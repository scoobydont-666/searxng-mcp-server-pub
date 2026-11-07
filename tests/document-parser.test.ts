import { describe, expect, it } from 'vitest';
import { parseHtmlDocument, stripMarkupBounded, xmlRootName } from '../src/utils/document-parser.js';

const article = '<html><head><title>Long</title></head><body><article><h1>Heading</h1>'
  + '<p>' + 'Substantive paragraph text for readability extraction. '.repeat(40) + '</p></article></body></html>';

describe('bounded HTML parsing', () => {
  it('extracts an article when the document is within the parse cap', () => {
    const result = parseHtmlDocument(article, 'https://example.com/story', 1_000_000);
    expect(result.extraction).toBe('readability');
  });

  it('never builds a DOM for a document over the cap, even one that would extract cleanly', () => {
    const result = parseHtmlDocument(article, 'https://example.com/story', 200);
    expect(result.extraction).toBe('oversize-html-text');
    expect(result).not.toHaveProperty('article');
    expect((result as { text: string }).text).toContain('Substantive paragraph');
  });

  it('drops script and style bodies from oversize text and keeps visible text', () => {
    const html = '<style>.x{color:red}</style><p>visible</p><script>var secret = 1;</script><p>more</p>';
    expect(stripMarkupBounded(html)).toBe('visible more');
  });

  it('handles unterminated and hostile markup in linear time', () => {
    const started = performance.now();
    const hostile = '<'.repeat(2_000_000);
    expect(stripMarkupBounded(hostile)).toBe('');
    expect(stripMarkupBounded('<a' + ' x'.repeat(1_000_000))).toBe('');
    expect(stripMarkupBounded('<script>' + 'a'.repeat(1_000_000))).toBe('');
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('XML root detection', () => {
  it('returns the root element name and null for malformed input', () => {
    expect(xmlRootName('<feed xmlns="http://www.w3.org/2005/Atom"><title>x</title></feed>')).toBe('feed');
    expect(xmlRootName('<feed>PRIVATE_FEED_FIXTURE</wrong>')).toBeNull();
  });
});
