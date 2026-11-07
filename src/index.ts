import { config } from './constants.js';
import { createApplication } from './app.js';
import { loadPrincipals } from './middleware/auth.js';
import { requireEnginePolicy } from './utils/engine-policy.js';
import { createAdmissionStore } from './utils/admission.js';
import { closeParsePool } from './utils/parse-pool.js';
async function main(): Promise<void> {
  const principals = loadPrincipals(config);
  requireEnginePolicy(config.enginePolicy);
  const store = await createAdmissionStore(config.redisUrl);
  const service = createApplication(config,store,principals);
  const listener = service.app.listen(config.port,config.bindHost,() => {
    process.stderr.write(JSON.stringify({level:'info',event:'listening',port:config.port,mcp:config.mcpEnabled,api:config.apiEnabled,quota_store:config.redisUrl ? 'redis' : 'memory'})+'\n');
  });
  listener.requestTimeout = config.requestTimeoutMs;
  listener.headersTimeout = Math.min(config.requestTimeoutMs,10000);
  listener.keepAliveTimeout = 5000;
  // The admin listener stays up while the API drains so readiness reports 503 until exit.
  const adminListener = service.admin.listen(config.adminPort,config.adminBindHost,() => {
    process.stderr.write(JSON.stringify({level:'info',event:'admin_listening',port:config.adminPort})+'\n');
  });
  adminListener.requestTimeout = 10000;
  adminListener.headersTimeout = 5000;
  let stopping = false;
  const shutdown = () => {
    if (stopping) return; stopping=true; service.drain();
    const stopWorkers = (): Promise<unknown> => Promise.allSettled([store.close(), closeParsePool()]);
    const deadline = setTimeout(() => {listener.closeAllConnections();adminListener.closeAllConnections();void stopWorkers().finally(() => process.exit(1));},config.shutdownGraceMs);
    deadline.unref();
    listener.close(() => {
      adminListener.close(() => {clearTimeout(deadline);void stopWorkers().then(() => process.exit(0));});
      adminListener.closeIdleConnections();
    });
    listener.closeIdleConnections();
  };
  process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
}
main().catch(() => {process.stderr.write('{"level":"error","event":"startup_failed","message":"Check validated configuration, credentials, and quota-store availability"}\n');process.exitCode=1;});
