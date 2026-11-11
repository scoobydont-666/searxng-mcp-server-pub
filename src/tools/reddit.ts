import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { safeFetch, decodeBody } from '../utils/fetch-client.js';
import { publicHttpUrl } from '../utils/public-url.js';

function asJsonContent(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

interface RedditChild {
  kind: string;
  data: Record<string, unknown>;
}
interface RedditListing {
  kind: string;
  data: { children: RedditChild[]; after?: string | null };
}

const REDDIT_HOSTS = new Set(['reddit.com', 'www.reddit.com', 'old.reddit.com']);
const SHARE_PATH = /^\/(?:r\/[A-Za-z0-9_]+\/)?s\/[A-Za-z0-9_-]+\/?$/;

function parseRedditUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Invalid Reddit URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
      (parsed.port && parsed.port !== '443') || !REDDIT_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('reddit_fetch requires an HTTPS reddit.com URL or bare post ID');
  }
  if (parsed.pathname.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new Error('Invalid Reddit URL path');
  }
  return parsed;
}

/**
 * Coerce a Reddit URL into the .json variant on old.reddit.com (no JS, no auth).
 * Accepts:
 *   - https://www.reddit.com/r/foo/comments/<id>/...
 *   - https://reddit.com/r/foo/comments/<id>/...
 *   - https://old.reddit.com/r/foo/comments/<id>/...
 *   - https://www.reddit.com/r/foo/s/<short>  (share link — fetch redirect first)
 *   - bare comment-id alone like `abc123`
 */
export async function resolveRedditJsonUrl(input: string): Promise<string> {
  const target = input.trim();
  if (/^[a-z0-9]+$/i.test(target) && target.length >= 5 && target.length <= 10) {
    return `https://old.reddit.com/comments/${target}.json`;
  }
  let u = parseRedditUrl(target);
  // Share links use /s/ — must follow redirect to get the canonical URL on Reddit.
  if (SHARE_PATH.test(u.pathname)) {
    const r = await safeFetch(u.toString(), {
      headers: { Accept: 'text/html' },
      max_bytes: 64 * 1024,
    });
    const finalUrl = r.url_final;
    r.release();
    u = parseRedditUrl(finalUrl);
    if (SHARE_PATH.test(u.pathname)) {
      throw new Error('Reddit share link did not resolve to a canonical post URL');
    }
  }
  // Strip ?utm_* etc. for cleaner JSON URL.
  if (u.hostname.toLowerCase() === 'reddit.com' || u.hostname.toLowerCase() === 'www.reddit.com') {
    u.hostname = 'old.reddit.com';
  }
  // Add .json suffix if not already present.
  if (!u.pathname.endsWith('.json')) {
    u.pathname = u.pathname.replace(/\/$/, '') + '.json';
  }
  u.search = '';
  u.hash = '';
  return u.toString();
}

function pickPostFields(p: Record<string, unknown>): Record<string, unknown> {
  const keep = [
    'subreddit',
    'subreddit_name_prefixed',
    'title',
    'selftext',
    'author',
    'score',
    'upvote_ratio',
    'num_comments',
    'created_utc',
    'permalink',
    'url',
    'is_self',
    'over_18',
    'stickied',
    'locked',
    'flair_text',
    'link_flair_text',
    'domain',
    'thumbnail',
  ];
  const out: Record<string, unknown> = {};
  for (const k of keep) {
    if (p[k] === undefined || p[k] === null || p[k] === '') continue;
    if (k === 'url' || k === 'thumbnail') {
      const safe = publicHttpUrl(p[k]);
      if (safe) out[k] = safe;
      continue;
    }
    out[k] = p[k];
  }
  return out;
}

function pickCommentFields(c: Record<string, unknown>): Record<string, unknown> {
  return {
    author: c.author,
    body: c.body,
    score: c.score,
    created_utc: c.created_utc,
    permalink: c.permalink,
    is_submitter: c.is_submitter,
    stickied: c.stickied,
    depth: c.depth ?? 0,
  };
}

function flattenComments(
  listing: RedditListing | undefined,
  depth: number,
  maxDepth: number,
  maxCount: number,
  acc: Record<string, unknown>[]
): void {
  if (!listing || acc.length >= maxCount) return;
  for (const child of listing.data?.children ?? []) {
    if (acc.length >= maxCount) break;
    if (child.kind !== 't1') continue; // skip "more" stubs
    const c = child.data as Record<string, unknown> & { replies?: RedditListing | '' };
    acc.push({ ...pickCommentFields(c), depth });
    if (depth < maxDepth && c.replies && typeof c.replies === 'object') {
      flattenComments(c.replies as RedditListing, depth + 1, maxDepth, maxCount, acc);
    }
  }
}

export function registerRedditTools(server: McpServer): void {
  server.registerTool(
    'reddit_fetch',
    {
      description:
        'Fetch a Reddit post + comments via old.reddit.com .json — no auth, no JS, robust against share-links. Accepts full URLs, /r/foo/comments/<id>, /s/<short> share links, or bare post IDs. Use this whenever WebFetch fails on Reddit.',
      inputSchema: {
        url_or_id: z.string().min(1).describe('Reddit URL or bare post ID.'),
        max_comments: z.number().int().min(0).max(500).optional().describe('Max comments to flatten. Default 50.'),
        max_depth: z.number().int().min(0).max(10).optional().describe('Max nested-reply depth. Default 4.'),
      },
    },
    async (args: { url_or_id: string; max_comments?: number; max_depth?: number }) => {
      const jsonUrl = await resolveRedditJsonUrl(args.url_or_id);
      const result = await safeFetch(jsonUrl, {
        headers: { Accept: 'application/json' },
      });
      const text = decodeBody(result.body, result.content_type);
      result.release();
      if (result.alternative) {
        return asJsonContent({ok:true,json_url:jsonUrl,url_final:result.url_final,status:result.status,
          alternative:result.alternative,content_type:result.content_type,content:text,
          note:'Alternative public source returned; it is not a complete Reddit post/comment response.'});
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (e) {
        return asJsonContent({
          ok: false,
          json_url: jsonUrl,
          status: result.status,
          error: 'Reddit returned non-JSON (likely rate-limited or blocked)',
        });
      }
      // Reddit returns [postListing, commentListing]
      if (!Array.isArray(json) || json.length < 1) {
        return asJsonContent({
          ok: false,
          json_url: jsonUrl,
          status: result.status,
          error: 'Unexpected Reddit response shape',
        });
      }
      const postListing = json[0] as RedditListing;
      const commentListing = json[1] as RedditListing | undefined;
      const post = postListing.data?.children?.[0]?.data;
      if (!post) {
        return asJsonContent({
          ok: false,
          json_url: jsonUrl,
          status: result.status,
          error: 'Post listing was empty',
        });
      }
      const comments: Record<string, unknown>[] = [];
      flattenComments(commentListing, 0, args.max_depth ?? 4, args.max_comments ?? 50, comments);
      return asJsonContent({
        ok: true,
        json_url: jsonUrl,
        status: result.status,
        elapsed_ms: result.elapsed_ms,
        post: pickPostFields(post),
        comment_count_returned: comments.length,
        comments,
      });
    }
  );
}
