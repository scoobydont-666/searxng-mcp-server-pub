// Test-only worker entry. It answers ordinary tasks and misbehaves on demand, so pool deadlines and
// memory limits can be exercised without relying on a real parser being slow.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', ({ id, task }) => {
  if (task.kind === 'spin') {
    for (;;) { /* runaway parse */ }
  }
  if (task.kind === 'oom') {
    const retained = [];
    for (;;) retained.push(new Array(1_000_000).fill(task.kind));
  }
  parentPort.postMessage({ id, ok: true, result: { echo: task.kind } });
});
