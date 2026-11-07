// k6 arrival-rate qualification. Synthetic upstream is mandatory unless an
// operator deliberately selects the separately budgeted real-provider pilot.
import http from 'k6/http';
import { check, fail } from 'k6';
import { Rate } from 'k6/metrics';
import { validateResult } from './validate-result.mjs';

const semanticFailures = new Rate('search_semantic_failures');
const partialResults = new Rate('search_partial_results');
const target = __ENV.SEARCH_BASE_URL;
const token = __ENV.SEARCH_TOKEN;
const rate = Number(__ENV.SEARCH_QPS || 25);
const mode = __ENV.SEARCH_PROTOCOL || 'mcp';
if (!target || !token) throw new Error('Set SEARCH_BASE_URL and SEARCH_TOKEN');
if (__ENV.SEARCH_SYNTHETIC !== 'true' && __ENV.ALLOW_LIVE_SEARCH_LOAD !== 'true') {
  throw new Error('Use the synthetic provider fixture; real-provider load needs a separately approved budget');
}
if (!Number.isInteger(rate) || rate < 1 || rate > 100) throw new Error('SEARCH_QPS must be 1..100');
if (!['mcp', 'api'].includes(mode)) throw new Error('SEARCH_PROTOCOL must be mcp or api');
const endpoint = target.replace(/\/$/, '') + (mode === 'mcp' ? '/mcp' : '/api/v1/search');
export const options = {
  scenarios: {
    searches: { executor: 'constant-arrival-rate', rate, timeUnit: '1s',
      duration: __ENV.SEARCH_DURATION || '15m', preAllocatedVUs: 150, maxVUs: 300, gracefulStop: '35s' },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<5000', 'p(99)<10000'],
    search_semantic_failures: ['rate<0.01'],
    dropped_iterations: ['count==0'],
    checks: ['rate>0.99'],
  },
  // Do not put request URLs, queries or identities into metric tags.
  systemTags: ['status', 'method', 'name', 'scenario', 'expected_response'],
};

export default function () {
  const query = `synthetic qualification query ${__ITER % 100}`;
  const body = mode === 'mcp'
    ? { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search', arguments: { query, max_results: 5 } } }
    : { q: query, max_results: 5 };
  const response = http.post(endpoint, JSON.stringify(body), {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
    timeout: '30s', tags: { name: mode === 'mcp' ? 'MCP search' : 'JSON API search' },
  });
  let result;
  try {
    const raw = response.headers['Content-Type']?.includes('text/event-stream')
      ? response.body.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).pop()
      : response.body;
    result = validateResult(mode, response.status, JSON.parse(raw || '{}'), query);
  } catch (_) {
    semanticFailures.add(true);
    fail('Search returned an invalid protocol response');
  }
  semanticFailures.add(!result.valid);
  partialResults.add(result.partial);
  check(response, { 'authorized search returns useful results': () => result.valid });
}
