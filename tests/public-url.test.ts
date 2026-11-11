import { describe, expect, it } from 'vitest';
import { boundedStringList, boundedText, publicHttpUrl } from '../src/utils/public-url.js';

describe('publicHttpUrl', () => {
  it('keeps ordinary public HTTP(S) URLs and rejects credentials or other schemes', () => {
    expect(publicHttpUrl('https://example.com/path')).toBe('https://example.com/path');
    expect(publicHttpUrl('http://example.org/')).toBe('http://example.org/');
    expect(publicHttpUrl('javascript:alert(1)')).toBeNull();
    expect(publicHttpUrl('file:///etc/passwd')).toBeNull();
    expect(publicHttpUrl('https://user:secret@example.com/')).toBeNull();
    expect(publicHttpUrl(123)).toBeNull();
  });

  it('rejects private, metadata, localhost and IPv4-mapped literals after URL normalization', () => {
    for (const value of [
      'http://127.0.0.1/admin',
      'http://169.254.169.254/latest/meta-data',
      'http://10.1.2.3/',
      'http://192.168.0.9/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:10.1.2.3]/',
      'http://0x7f000001/',
      'http://2130706433/',
      'http://localhost/secret',
      'http://localhost.localdomain/',
      'http://foo.localhost/',
      'http://metadata.google.internal/',
      'http://kubernetes.default.svc.cluster.local/',
      'http://localhost./',
      'http://metadata.google.internal./',
      'http://kubernetes.default.svc./',
      'http://foo.localhost./',
    ]) {
      expect(publicHttpUrl(value), value).toBeNull();
    }
    expect(publicHttpUrl('https://[::ffff:8.8.8.8]/')).toBe(new URL('https://[::ffff:8.8.8.8]/').toString());
    expect(publicHttpUrl('https://1.1.1.1/')).toBe('https://1.1.1.1/');
  });
});

describe('bounded text helpers', () => {
  it('slices strings and ignores non-strings', () => {
    expect(boundedText('abcdef', 3)).toBe('abc');
    expect(boundedText(12, 3)).toBe('');
    expect(boundedStringList(['aa', 1, 'bbbb', 'c'], 2, 3)).toEqual(['aa', 'bbb']);
    expect(boundedStringList('nope', 2, 3)).toEqual([]);
  });
});
