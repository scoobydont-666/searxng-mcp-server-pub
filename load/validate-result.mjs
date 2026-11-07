// Pure semantic oracle shared by k6 and its offline regression test.
export function validateResult(mode, status, document, query) {
  if (status !== 200 || !document || document.error) return { valid: false, partial: false };
  let payload = document;
  if (mode === 'mcp') {
    if (document.result?.isError) return { valid: false, partial: false };
    const text = document.result?.content?.find(item => item.type === 'text')?.text;
    if (typeof text !== 'string') return { valid: false, partial: false };
    try { payload = JSON.parse(text); }
    catch { return { valid: false, partial: false }; }
  }
  const partial = payload.partial === true || (Array.isArray(payload.unresponsive_engines) && payload.unresponsive_engines.length > 0);
  const valid = payload.query === query && Array.isArray(payload.results) && payload.results.length > 0 &&
    payload.results.every(result => typeof result.title === 'string' && /^https?:\/\//.test(result.url || ''));
  return { valid, partial };
}
