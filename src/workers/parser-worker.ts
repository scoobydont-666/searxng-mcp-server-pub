import { parentPort } from 'node:worker_threads';
import { parseHtmlDocument, parsePdfDocument, xmlRootName } from '../utils/document-parser.js';
import type { ParseTask } from '../utils/parse-pool.js';

if (!parentPort) throw new Error('parser-worker must run in a worker thread');
const port = parentPort;

async function run(task: ParseTask): Promise<unknown> {
  switch (task.kind) {
    case 'html': return parseHtmlDocument(task.html, task.url, task.maxChars);
    case 'pdf': return parsePdfDocument(task.data);
    case 'xml-root': return xmlRootName(task.text);
  }
}

port.on('message', async (message: { id: number; task: ParseTask }) => {
  try {
    port.postMessage({ id: message.id, ok: true, result: await run(message.task) });
  } catch {
    port.postMessage({ id: message.id, ok: false, reason: 'parser_failed' });
  }
});
