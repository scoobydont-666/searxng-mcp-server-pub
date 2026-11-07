import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});
turndown.remove(['script', 'style', 'iframe', 'noscript', 'svg'] as unknown as Array<keyof HTMLElementTagNameMap>);

export interface Extracted {
  title: string;
  byline: string | null;
  content_html: string;
  content_text: string;
  content_markdown: string;
  excerpt: string | null;
  length: number;
  site_name: string | null;
  published_time: string | null;
  lang: string | null;
}

/**
 * Run @mozilla/readability against an HTML string. Returns null if extraction fails.
 */
export function extractArticle(html: string, url: string): Extracted | null {
  let dom: JSDOM;
  try {
    dom = new JSDOM(html, { url, virtualConsole:new VirtualConsole() });
  } catch {
    return null;
  }
  try {
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article) return null;
    const html_content = article.content ?? '';
    const text = (article.textContent ?? '').trim();
    let markdown = '';
    try {
      markdown = turndown.turndown(html_content);
    } catch {
      markdown = text;
    }
    return {
      title: (article.title ?? '').trim(),
      byline: article.byline?.trim() ?? null,
      content_html: html_content,
      content_text: text,
      content_markdown: markdown,
      excerpt: article.excerpt?.trim() ?? null,
      length: article.length ?? text.length,
      site_name: article.siteName?.trim() ?? null,
      published_time: article.publishedTime ?? null,
      lang: article.lang ?? null,
    };
  } finally {
    try { dom.window.close(); } catch { /* ignore */ }
  }
}

/**
 * Strip HTML to plain text without invoking Readability (used as fallback).
 */
export function htmlToPlainText(html: string): string {
  try {
    const dom = new JSDOM(html, {virtualConsole:new VirtualConsole()});
    const doc = dom.window.document;
    doc.querySelectorAll('script,style,iframe,noscript,svg').forEach((n) => n.remove());
    const text = (doc.body?.textContent ?? '').replace(/\s+/g, ' ').trim();
    try { dom.window.close(); } catch { /* ignore */ }
    return text;
  } catch {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}
