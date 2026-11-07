// Standalone bounded synthetic JSON backend. No external search-engine traffic.
// Run only in isolated qualification; it is never included in the production image.
import http from 'node:http';

const latency = Number(process.env.MOCK_LATENCY_MS || 2000);
const failureEvery = Number(process.env.MOCK_FAIL_EVERY || 0);
const port = Number(process.env.MOCK_PORT || 18080);
if (!Number.isFinite(latency) || latency < 0 || latency > 15000) throw new Error('Invalid MOCK_LATENCY_MS');
if (!Number.isInteger(failureEvery) || failureEvery < 0) throw new Error('Invalid MOCK_FAIL_EVERY');
let requests = 0;
const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://fixture.invalid');
  if (url.pathname === '/healthz') { response.writeHead(200).end('OK'); return; }
  if (url.pathname !== '/search') { response.writeHead(404).end(); return; }
  let chunks = [], bytes = 0, timer;
  request.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 65536) { response.writeHead(413).end(); request.destroy(); return; }
    chunks.push(chunk);
  });
  request.on('end', () => {
    const query = request.method === 'POST'
      ? new URLSearchParams(Buffer.concat(chunks).toString()).get('q')
      : url.searchParams.get('q');
    chunks = [];
    const current = ++requests;
    timer = setTimeout(() => {
      if (failureEvery && current % failureEvery === 0) { response.writeHead(503).end(); return; }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ query: query || 'synthetic',
        number_of_results: 2, answers: [], suggestions: [], unresponsive_engines: [],
        results: [{ title: 'Synthetic result one', url: 'https://example.com/one', content: 'Bounded fixture content.', engine: 'fixture', score: 1 },
          { title: 'Synthetic result two', url: 'https://example.com/two', content: 'Another fixture result.', engine: 'fixture', score: 0.5 }] }));
    }, latency);
  });
  response.on('close', () => clearTimeout(timer));
});
server.listen(port, '127.0.0.1', () => process.stderr.write(`Synthetic backend on loopback port ${port}\n`));
process.on('SIGTERM', () => server.close());
