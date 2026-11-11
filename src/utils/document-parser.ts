import { JSDOM, VirtualConsole } from 'jsdom';
import { extractArticle, htmlToPlainText, type Extracted } from './extract.js';

export type HtmlParseResult =
  | { extraction: 'readability'; article: Extracted }
  | { extraction: 'fallback-html-strip' | 'oversize-html-text'; text: string };

/**
 * Parses untrusted HTML, normally inside the parser worker. Above `maxChars` the DOM is never built: the
 * document gets a bounded, approximate text extraction instead.
 */
export function parseHtmlDocument(html: string, url: string, maxChars: number): HtmlParseResult {
  if (html.length > maxChars) return { extraction: 'oversize-html-text', text: stripMarkupBounded(html) };
  const article = extractArticle(html, url);
  if (article) return { extraction: 'readability', article };
  return { extraction: 'fallback-html-strip', text: htmlToPlainText(html) };
}

/**
 * Linear-time tag stripper for oversize documents. It drops tags and script/style bodies, does not decode
 * entities, and does not build a DOM. An unterminated tag ends the text, so no input causes quadratic work.
 */
export function stripMarkupBounded(html: string): string {
  const lower = html.toLowerCase();
  const out: string[] = [];
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open === -1) {
      out.push(html.slice(index));
      break;
    }
    out.push(html.slice(index, open), ' ');
    const close = html.indexOf('>', open + 1);
    if (close === -1) break;
    const name = /^<([a-z][a-z0-9]*)/.exec(lower.slice(open, open + 32))?.[1];
    if (name === 'script' || name === 'style') {
      const end = lower.indexOf(`</${name}`, close + 1);
      if (end === -1) break;
      const endTag = lower.indexOf('>', end);
      if (endTag === -1) break;
      index = endTag + 1;
      continue;
    }
    index = close + 1;
  }
  return out.join('').replace(/\s+/g, ' ').trim();
}

/** Returns the local name of an XML document root, or null for malformed XML. Scripts and resources are off. */
export function xmlRootName(text: string): string | null {
  try {
    const dom = new JSDOM(text, { contentType: 'application/xml', virtualConsole: new VirtualConsole() });
    const root = dom.window.document.documentElement?.localName ?? null;
    dom.window.close();
    return root;
  } catch {
    return null;
  }
}

export interface PdfParseResult {
  pages: number;
  info: Record<string, unknown>;
  metadata: string | null;
  text: string;
}

// pdf-parse@1.x runs a debug load of a bundled sample when its index module is the entry point; the library
// file is imported directly to avoid that path.
interface PdfPage {
  getTextContent(options: { normalizeWhitespace: boolean; disableCombineTextItems: boolean }): Promise<{
    items: Array<{ str: string; transform: number[] }>;
  }>;
}
type PdfParseFn = (buf: Buffer, options: { pagerender: (page: PdfPage) => Promise<string> }) => Promise<{
  numpages: number;
  info: Record<string, unknown>;
  metadata: { toString?(): string } | null;
  text: string;
}>;
let pdfParseFn: PdfParseFn | null = null;
async function loadPdfParse(): Promise<PdfParseFn> {
  if (pdfParseFn) return pdfParseFn;
  const mod = (await import('pdf-parse/lib/pdf-parse.js')) as unknown as { default?: PdfParseFn } & PdfParseFn;
  pdfParseFn = mod.default ?? mod;
  return pdfParseFn;
}

export async function parsePdfDocument(data: Uint8Array): Promise<PdfParseResult> {
  const parse = await loadPdfParse();
  let completedPages = 0;
  const parsed = await parse(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
    pagerender: async page => {
      const content = await page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
      let lastY: number | undefined;
      let text = '';
      // Preserve pdf-parse's text ordering and newline behavior.
      for (const item of content.items) {
        text += lastY === item.transform[5] || !lastY ? item.str : '\n' + item.str;
        lastY = item.transform[5];
      }
      completedPages++;
      return text;
    },
  });
  // The wrapper swallows getPage/pagerender failures and reports the planned page count.
  // Count successful extraction, including blank pages, rather than trusting numrender.
  if (!Number.isSafeInteger(parsed.numpages) || parsed.numpages < 1 || completedPages !== parsed.numpages) {
    throw new Error('pdf_incomplete');
  }
  return {
    pages: parsed.numpages,
    info: parsed.info,
    metadata: parsed.metadata?.toString?.() ?? null,
    text: parsed.text,
  };
}
