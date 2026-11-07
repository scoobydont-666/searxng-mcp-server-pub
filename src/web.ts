import { config } from './constants.js';
import { createAdmissionStore } from './utils/admission.js';
import { createWebApplication, readWebConfig } from './web-proxy.js';

async function main(): Promise<void> {
  const web = readWebConfig(config);
  const store = await createAdmissionStore(config.redisUrl);
  const service = createWebApplication(config, web, store);
  const listener = service.app.listen(web.port, '0.0.0.0', () => {
    process.stderr.write(JSON.stringify({ level: 'info', event: 'web_listening', port: web.port }) + '\n');
  });
  listener.requestTimeout = config.requestTimeoutMs;
  listener.headersTimeout = Math.min(config.requestTimeoutMs, 10000);
  listener.keepAliveTimeout = 5000;
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true; service.drain();
    const deadline = setTimeout(() => {
      listener.closeAllConnections(); void store.close().finally(() => process.exit(1));
    }, config.shutdownGraceMs);
    deadline.unref();
    listener.close(() => { clearTimeout(deadline); void store.close().then(() => process.exit(0)); });
    listener.closeIdleConnections();
  };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
}
main().catch(() => {
  process.stderr.write('{"level":"error","event":"web_startup_failed","message":"Check web configuration and shared quota-store availability"}\n');
  process.exitCode = 1;
});
