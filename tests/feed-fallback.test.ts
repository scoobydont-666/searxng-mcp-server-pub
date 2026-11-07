import { describe, expect, it } from 'vitest';
import { parseFeedPolicy, resolveAlternatives } from '../src/utils/feed-fallback.js';

const input = {
  version:1, maxAlternatives:2, triggerStatuses:[403,429,503], rules:[
    {id:'arxiv-api',sourceHost:'arxiv.org',sourcePath:'/abs/{paper}',alternatives:[
      {name:'arXiv metadata API',kind:'api',urlTemplate:'https://export.arxiv.org/api/query?id_list={paper}'}]},
    {id:'github-releases',sourceHost:'github.com',sourcePath:'/{owner}/{repo}/releases',alternatives:[
      {name:'GitHub releases feed',kind:'atom',urlTemplate:'https://github.com/{owner}/{repo}/releases.atom'}]},
  ],
};

describe('Explicit alternative feed policy', () => {
  it('resolves a blocked article to an identified public alternative without forwarding query secrets', () => {
    const result = resolveAlternatives(parseFeedPolicy(input),'https://arxiv.org/abs/2601.12345?token=sensitive',403);
    expect(result).toEqual([{name:'arXiv metadata API',kind:'api',rule:'arxiv-api',url:'https://export.arxiv.org/api/query?id_list=2601.12345'}]);
  });
  it('does not treat success, authentication failure, unmatched sites or unsafe captures as fallbacks', () => {
    const policy = parseFeedPolicy(input);
    for (const [url,status] of [['https://arxiv.org/abs/2601.12345',200],['https://arxiv.org/abs/2601.12345',401],
      ['https://private.invalid/abs/2601.12345',403],['https://arxiv.org/abs/one%2Ftwo',403]]) {
      expect(resolveAlternatives(policy,String(url),Number(status))).toEqual([]);
    }
  });
  it('respects same-origin 429 rather than retrying a provider on another path', () => {
    const policy = parseFeedPolicy(input);
    expect(resolveAlternatives(policy,'https://github.com/org/repo/releases',429)).toEqual([]);
    expect(resolveAlternatives(policy,'https://github.com/org/repo/releases',403)[0].url).toBe('https://github.com/org/repo/releases.atom');
  });
  it('rejects credential, host interpolation and unknown capture mistakes at startup', () => {
    for (const urlTemplate of ['https://{paper}.example.com/feed','https://user:secret@example.com/feed',
      'http://example.com/feed','https://example.com/{unknown}']) {
      const altered = structuredClone(input);
      altered.rules[0].alternatives[0].urlTemplate = urlTemplate;
      expect(() => parseFeedPolicy(altered)).toThrow();
    }
  });
});
