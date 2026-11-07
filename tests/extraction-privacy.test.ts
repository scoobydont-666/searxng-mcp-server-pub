import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractArticle, htmlToPlainText } from '../src/utils/extract.js';
import { isAlternativeContent } from '../src/utils/feed-fallback.js';

afterEach(() => vi.restoreAllMocks());

describe('Untrusted document parser privacy', () => {
  it('never copies fetched CSS/body text into console diagnostics', () => {
    const error = vi.spyOn(console,'error').mockImplementation(() => undefined);
    const html = '<html><head><style>@layer fixture { PRIVATE_PAGE_FIXTURE }</style></head><body><article><h1>Example</h1><p>Useful content for a parser fixture.</p></article></body></html>';
    extractArticle(html,'https://example.test/article');
    expect(htmlToPlainText(html)).toContain('Useful content');
    expect(error).not.toHaveBeenCalled();
  });

  it('rejects malformed alternative XML without echoing its content', async () => {
    const error = vi.spyOn(console,'error').mockImplementation(() => undefined);
    const xml = new TextEncoder().encode('<feed>PRIVATE_FEED_FIXTURE</wrong>');
    await expect(isAlternativeContent('atom','application/atom+xml',xml.buffer)).resolves.toBe(false);
    expect(error).not.toHaveBeenCalled();
  });
});
