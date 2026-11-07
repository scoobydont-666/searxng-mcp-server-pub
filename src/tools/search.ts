import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { publicHttpUrl } from '../utils/public-url.js';
import { searxQuery, type SearxResult } from '../utils/searxng-client.js';

const TimeRange = z.enum(['', 'day', 'week', 'month', 'year']);

interface NormalizedResult {
  title: string;
  url: string;
  snippet: string;
  engine: string;
  score: number;
  category: string;
  published_date: string | null;
  thumbnail?: string;
  img_src?: string;
  iframe_src?: string;
  author?: string;
}

function normalize(r: SearxResult): NormalizedResult | null {
  const url = publicHttpUrl(r.url);
  if (!url) return null;
  const thumbnail = publicHttpUrl(r.thumbnail);
  const imgSrc = publicHttpUrl(r.img_src);
  const iframeSrc = publicHttpUrl(r.iframe_src);
  return {
    title: r.title ?? '',
    url,
    snippet: (r.content ?? '').replace(/\s+/g, ' ').trim(),
    engine: r.engine ?? r.engines?.[0] ?? '',
    score: typeof r.score === 'number' && Number.isFinite(r.score) ? r.score : 0,
    category: r.category ?? '',
    published_date: r.publishedDate ?? null,
    ...(thumbnail ? { thumbnail } : {}),
    ...(imgSrc ? { img_src: imgSrc } : {}),
    ...(iframeSrc ? { iframe_src: iframeSrc } : {}),
    ...(r.author ? { author: r.author } : {}),
  };
}

function asJsonContent(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function makeSearchHandler(category: string, defaultTimeRange?: z.infer<typeof TimeRange>) {
  return async (args: {
    query: string;
    max_results?: number;
    time_range?: z.infer<typeof TimeRange>;
    language?: string;
    page?: number;
    engines?: string;
    safesearch?: 0 | 1 | 2;
  }) => {
    const limit = Math.min(Math.max(args.max_results ?? 10, 1), 50);
    const resp = await searxQuery({
      query: args.query,
      categories: category,
      pageno: args.page ?? 1,
      time_range: args.time_range ?? defaultTimeRange ?? '',
      language: args.language,
      engines: args.engines,
      safesearch: args.safesearch ?? 0,
    });
    const results = (resp.results ?? []).flatMap((r) => {
      const normalized = normalize(r);
      return normalized ? [normalized] : [];
    }).slice(0, limit);
    return asJsonContent({
      query: resp.query,
      category,
      number_of_results: resp.number_of_results,
      returned: results.length,
      results,
      unresponsive_engines: resp.unresponsive_engines ?? [],
      suggestions: resp.suggestions ?? [],
      answers: resp.answers ?? [],
      search_policy: resp.search_policy,
    });
  };
}

const baseSearchSchema = {
  query: z.string().min(1).max(2048).describe('Search query string.'),
  max_results: z.number().int().min(1).max(50).optional().describe('Max results returned. Default 10.'),
  language: z.string().optional().describe('IETF language tag (e.g. "en", "de", "ja").'),
  page: z.number().int().min(1).max(5).optional().describe('Pagination page (1–5).'),
  engines: z.string().optional().describe('One to four comma-separated engine names from the configured inventory; explicit selections do not silently fall back.'),
  safesearch: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional().describe('0=off, 1=moderate, 2=strict.'),
};

const newsSearchSchema = {
  ...baseSearchSchema,
  time_range: TimeRange.optional().describe('Time range filter.'),
};

export function registerSearchTools(server: McpServer): void {
  server.registerTool(
    'web_search',
    {
      description:
        'General web search through configured SearXNG engine pools. Uses at most four engines per attempt and approved alternate pools when blocked or timed out. Returns ranked results, source engines, and fallback metadata. Authenticated access with shared quotas.',
      inputSchema: { ...baseSearchSchema, time_range: TimeRange.optional() },
    },
    makeSearchHandler('general')
  );

  server.registerTool(
    'news_search',
    {
      description:
        'News search through the configured news engine pools. Supports time_range filters and returns engine/fallback metadata. Use when freshness matters.',
      inputSchema: newsSearchSchema,
    },
    makeSearchHandler('news', 'week')
  );

  server.registerTool(
    'image_search',
    {
      description:
        'Image search through the configured image engine pools. Returns thumbnails, source URLs, and engine/fallback metadata.',
      inputSchema: baseSearchSchema,
    },
    makeSearchHandler('images')
  );

  server.registerTool(
    'video_search',
    {
      description:
        'Video search through the configured video engine pools. Returns video URLs, available embeds, and engine/fallback metadata.',
      inputSchema: baseSearchSchema,
    },
    makeSearchHandler('videos')
  );

  server.registerTool(
    'science_search',
    {
      description:
        'Academic and science search through the configured research engine pools. Returns source/fallback metadata. Use for papers and citations.',
      inputSchema: baseSearchSchema,
    },
    makeSearchHandler('science')
  );
}
