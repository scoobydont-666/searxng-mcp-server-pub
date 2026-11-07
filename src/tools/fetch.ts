import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { safeFetch, decodeBody, FetchFailure, type FetchResult } from '../utils/fetch-client.js';
import { ParseFailure, parseHtmlInWorker, parsePdfInWorker } from '../utils/parse-pool.js';

const Format = z.enum(['markdown', 'text', 'html', 'raw']);

function asJsonContent(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

const fetchUrlSchema = {
  url: z.string().url().describe('URL to fetch.'),
  format: Format.optional().describe(
    'markdown (default): readability-extracted markdown. text: plain text. html: extracted HTML. raw: untouched body (utf-8 decoded if textual).'
  ),
  timeout_ms: z.number().int().min(500).max(60000).optional().describe('Request timeout in ms. Default 15000.'),
  max_bytes: z.number().int().min(1024).max(50 * 1024 * 1024).optional().describe('Max body bytes. Default 8MB.'),
  user_agent: z.string().optional().describe('Deprecated: must equal the server-configured transparent User-Agent; overrides are rejected.'),
};

interface FetchArgs {
  url: string;
  format?: z.infer<typeof Format>;
  timeout_ms?: number;
  max_bytes?: number;
  user_agent?: string;
}

async function fetchUrlImpl(args: FetchArgs) {
  const result = await safeFetch(args.url, {
    timeout_ms: args.timeout_ms,
    max_bytes: args.max_bytes,
    user_agent: args.user_agent,
  });
  try {
    return await renderFetchResult(args, result);
  } finally {
    result.release();
  }
}

async function renderFetchResult(args: FetchArgs, result: FetchResult) {
  const fmt = args.format ?? 'markdown';
  const ct = result.content_type.toLowerCase();
  const isHtml = ct.includes('text/html') || ct.includes('application/xhtml');
  const isText = ct.startsWith('text/') || ct.includes('json') || ct.includes('xml');

  // Binary types (images, video, etc.)
  if (!isText && !isHtml && fmt !== 'raw') {
    return asJsonContent({
      url: args.url,
      url_final: result.url_final,
      ...(result.alternative ? { alternative: result.alternative } : {}),
      status: result.status,
      content_type: result.content_type,
      bytes: result.bytes,
      truncated: result.truncated,
      elapsed_ms: result.elapsed_ms,
      note: 'binary content type — use fetch_pdf for PDFs or set format="raw" to receive base64',
    });
  }

  if (fmt === 'raw') {
    if (isText || isHtml) {
      return asJsonContent({
        url: args.url,
        url_final: result.url_final,
        ...(result.alternative ? { alternative: result.alternative } : {}),
        status: result.status,
        content_type: result.content_type,
        bytes: result.bytes,
        truncated: result.truncated,
        elapsed_ms: result.elapsed_ms,
        body: decodeBody(result.body, result.content_type),
      });
    }
    // Binary → base64
    return asJsonContent({
      url: args.url,
      url_final: result.url_final,
      ...(result.alternative ? { alternative: result.alternative } : {}),
      status: result.status,
      content_type: result.content_type,
      bytes: result.bytes,
      truncated: result.truncated,
      elapsed_ms: result.elapsed_ms,
      body_base64: Buffer.from(result.body).toString('base64'),
    });
  }

  const text = decodeBody(result.body, result.content_type);

  if (isHtml) {
    const parsed = await parseHtmlInWorker(text, result.url_final);
    if (parsed.extraction !== 'readability') {
      return asJsonContent({
        url: args.url,
        url_final: result.url_final,
        ...(result.alternative ? { alternative: result.alternative } : {}),
        status: result.status,
        content_type: result.content_type,
        bytes: result.bytes,
        truncated: result.truncated,
        elapsed_ms: result.elapsed_ms,
        title: null,
        content: parsed.text,
        extraction: parsed.extraction,
      });
    }
    const { article } = parsed;
    const content =
      fmt === 'markdown' ? article.content_markdown :
      fmt === 'text' ? article.content_text :
      article.content_html;
    return asJsonContent({
      url: args.url,
      url_final: result.url_final,
      ...(result.alternative ? { alternative: result.alternative } : {}),
      status: result.status,
      content_type: result.content_type,
      bytes: result.bytes,
      truncated: result.truncated,
      elapsed_ms: result.elapsed_ms,
      title: article.title,
      byline: article.byline,
      excerpt: article.excerpt,
      site_name: article.site_name,
      published_time: article.published_time,
      lang: article.lang,
      length: article.length,
      content,
    });
  }

  // Plain text / json / xml — return verbatim.
  return asJsonContent({
    url: args.url,
    url_final: result.url_final,
    ...(result.alternative ? { alternative: result.alternative } : {}),
    status: result.status,
    content_type: result.content_type,
    bytes: result.bytes,
    truncated: result.truncated,
    elapsed_ms: result.elapsed_ms,
    content: text,
  });
}

export function registerFetchTools(server: McpServer): void {
  server.registerTool(
    'fetch_url',
    {
      description:
        'Fetch a single URL with retry/backoff and per-host concurrency cap. Default returns Mozilla Readability article extraction as markdown. Set format="raw" for the untouched response body.',
      inputSchema: fetchUrlSchema,
    },
    fetchUrlImpl
  );

  server.registerTool(
    'fetch_batch',
    {
      description:
        'Fetch multiple URLs concurrently with the same options. Returns one result per URL in order. Honors per-host concurrency cap so parallelism stays polite.',
      inputSchema: {
        urls: z.array(z.string().url()).min(1).max(5).describe('URLs to fetch (max 5).'),
        format: Format.optional(),
        timeout_ms: z.number().int().min(500).max(60000).optional(),
        max_bytes: z.number().int().min(1024).max(50 * 1024 * 1024).optional(),
        user_agent: z.string().optional(),
      },
    },
    async (args: {
      urls: string[];
      format?: z.infer<typeof Format>;
      timeout_ms?: number;
      max_bytes?: number;
      user_agent?: string;
    }) => {
      const results = await Promise.allSettled(
        args.urls.map((u) =>
          fetchUrlImpl({
            url: u,
            format: args.format,
            timeout_ms: args.timeout_ms,
            max_bytes: args.max_bytes,
            user_agent: args.user_agent,
          })
        )
      );
      const flat = results.map((r, i) => {
        if (r.status === 'fulfilled') {
          try {
            const text = r.value.content[0]?.text ?? '{}';
            return { url: args.urls[i], ok: true, ...JSON.parse(text) };
          } catch {
            return { url: args.urls[i], ok: true, raw: r.value };
          }
        }
        return { url: args.urls[i], ok: false, error: r.reason instanceof FetchFailure ? String(r.reason) : 'fetch_failed' };
      });
      return asJsonContent({ count: flat.length, results: flat });
    }
  );

  server.registerTool(
    'fetch_pdf',
    {
      description:
        'Fetch a PDF and extract text + metadata via pdf-parse. Returns full text, page count, and PDF info dictionary.',
      inputSchema: {
        url: z.string().url().describe('URL to a PDF.'),
        max_bytes: z.number().int().min(1024).optional().describe('Max body bytes; values above the server fetch limit are clamped. Default 8MB.'),
        timeout_ms: z.number().int().min(500).max(60000).optional(),
      },
    },
    async (args: { url: string; max_bytes?: number; timeout_ms?: number }) => {
      const result = await safeFetch(args.url, {
        max_bytes: args.max_bytes ?? 16 * 1024 * 1024,
        timeout_ms: args.timeout_ms,
        headers: { Accept: 'application/pdf,*/*' },
      });
      try {
        if (result.alternative) {
          return asJsonContent({url:args.url,url_final:result.url_final,status:result.status,
            alternative:result.alternative,content_type:result.content_type,
            content:decodeBody(result.body,result.content_type),
            note:'The PDF was unavailable. This is an explicitly configured alternative feed/API response.'});
        }
        try {
          // The worker takes ownership of the buffer; result.body is not read after this call.
          const parsed = await parsePdfInWorker(result.body);
          return asJsonContent({
            url: args.url,
            url_final: result.url_final,
            status: result.status,
            bytes: result.bytes,
            truncated: result.truncated,
            elapsed_ms: result.elapsed_ms,
            pages: parsed.pages,
            info: parsed.info,
            metadata: parsed.metadata,
            text: parsed.text,
          });
        } catch (err) {
          if (!(err instanceof ParseFailure)) throw err;
          return asJsonContent({
            url: args.url,
            url_final: result.url_final,
            status: result.status,
            bytes: result.bytes,
            error: 'pdf_parse_failed',
          });
        }
      } finally {
        result.release();
      }
    }
  );

  server.registerTool(
    'extract_article',
    {
      description:
        'Run @mozilla/readability on a URL and return ONLY the article fields (title, byline, content_markdown, excerpt, site_name, published_time). Useful when you already know the URL is a clean article and want a smaller payload than fetch_url.',
      inputSchema: {
        url: z.string().url().describe('URL of the article.'),
        timeout_ms: z.number().int().min(500).max(60000).optional(),
      },
    },
    async (args: { url: string; timeout_ms?: number }) => {
      const result = await safeFetch(args.url, { timeout_ms: args.timeout_ms });
      try {
        const text = decodeBody(result.body, result.content_type);
        if (result.alternative) {
          return asJsonContent({url:args.url,url_final:result.url_final,status:result.status,
            alternative:result.alternative,extracted:false,content_type:result.content_type,content:text});
        }
        const parsed = await parseHtmlInWorker(text, result.url_final);
        if (parsed.extraction !== 'readability') {
          return asJsonContent({
            url: args.url,
            url_final: result.url_final,
            status: result.status,
            extracted: false,
            error: 'Readability failed to extract article structure',
          });
        }
        const article = parsed.article;
        return asJsonContent({
          url: args.url,
          url_final: result.url_final,
          status: result.status,
          extracted: true,
          title: article.title,
          byline: article.byline,
          excerpt: article.excerpt,
          site_name: article.site_name,
          published_time: article.published_time,
          lang: article.lang,
          length: article.length,
          content_markdown: article.content_markdown,
        });
      } finally {
        result.release();
      }
    }
  );
}
