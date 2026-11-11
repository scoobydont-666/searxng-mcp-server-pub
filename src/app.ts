import express, { type Request, type Response } from 'express';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Config } from './constants.js';
import { createServer } from './server.js';
import { createAuthenticator, loadPrincipals, type Principal, type Scope } from './middleware/auth.js';
import { registerSearchTools } from './tools/search.js';
import { registerFetchTools } from './tools/fetch.js';
import { registerResearchTools } from './tools/research.js';
import { registerRedditTools } from './tools/reddit.js';
import { AdmissionError, type AdmissionStore } from './utils/admission.js';
import { requestContext } from './utils/request-context.js';
import { LANGUAGE_TAG, requireEnginePolicy } from './utils/engine-policy.js';
import { boundedText, publicHttpUrl } from './utils/public-url.js';
import { searxQuery } from './utils/searxng-client.js';

const SEARCH_TOOLS = new Set(['web_search','news_search','image_search','video_search','science_search']);
const FETCH_TOOLS = new Set(['fetch_url','fetch_batch','fetch_pdf','extract_article','reddit_fetch','search_and_extract']);
const SearchInput = z.object({
  q:z.string().trim().min(1).max(2048),
  category:z.enum(['general','news','images','videos','science']).default('general'),
  max_results:z.coerce.number().int().min(1).max(50).default(10),
  page:z.coerce.number().int().min(1).max(5).default(1),
  language:z.string().regex(LANGUAGE_TAG).optional(),
  time_range:z.enum(['','day','week','month','year']).default(''),
  safesearch:z.coerce.number().int().min(0).max(2).default(0),
  engines:z.union([z.string().max(512),z.array(z.string().max(128)).min(1).max(4)]).transform(value => Array.isArray(value) ? value.join(',') : value).optional(),
}).strict();
function safeUrl(value: unknown): string | null {
  return publicHttpUrl(value);
}

export function createApplication(cfg: Config, store: AdmissionStore, principals = loadPrincipals(cfg)) {
  requireEnginePolicy(cfg.enginePolicy);
  if (cfg.fetchEnabled && !cfg.allowedDomains.length) throw new Error('Fetch tools require a nonempty SEARXNG_MCP_ALLOWED_DOMAINS allowlist');
  const app = express();
  const authenticateRequest = createAuthenticator(principals);
  app.disable('x-powered-by');
  app.set('query parser','simple');
  const registry = new Registry();
  collectDefaultMetrics({register:registry});
  const requests = new Counter({name:'searxng_mcp_requests_total',help:'Requests by fixed route and status class',labelNames:['route','status'],registers:[registry]});
  const rejects = new Counter({name:'searxng_mcp_auth_rejections_total',help:'Authentication and admission rejections',labelNames:['reason'],registers:[registry]});
  const latency = new Histogram({name:'searxng_mcp_request_duration_seconds',help:'Service request latency',labelNames:['route'],buckets:[.01,.05,.1,.5,1,2,5,10,30],registers:[registry]});
  const inflightMetric = new Gauge({name:'searxng_mcp_inflight',help:'Requests currently in flight in this process',registers:[registry]});
  let draining = false, inflight = 0;

  // Probes and metrics live on the admin listener only; the API listener answers them with 404.
  const READY_CACHE_MS = 1000;
  let readiness: {at: number; result: Promise<boolean>} | null = null;
  const checkReadiness = (): Promise<boolean> => {
    if (readiness && Date.now() - readiness.at < READY_CACHE_MS) return readiness.result;
    const result = (async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(),3000);
      try {
        const [upstream, quota] = await Promise.all([
          fetch(new URL('/healthz',cfg.searxngUrl),{signal:ac.signal,redirect:'error'}),store.ready(),
        ]);
        await upstream.body?.cancel();
        return upstream.ok && quota;
      } catch { return false; }
      finally { clearTimeout(timer); }
    })();
    readiness = {at: Date.now(), result};
    return result;
  };
  const admin = express();
  admin.disable('x-powered-by');
  const harden = (_req: Request, res: Response, next: express.NextFunction) => {
    res.set('X-Content-Type-Options','nosniff');
    res.set('X-Frame-Options','DENY');
    res.set('Referrer-Policy','no-referrer');
    res.set('Cache-Control','no-store');
    next();
  };
  admin.use(harden);
  admin.get('/health',(_req,res) => res.status(200).json({status:'alive'}));
  admin.get('/ready',async (_req,res) => {
    if (draining) { res.status(503).json({ready:false}); return; }
    const ready = await checkReadiness();
    res.status(ready ? 200 : 503).json({ready});
  });
  admin.get('/metrics',async (_req,res) => {res.type(registry.contentType);res.end(await registry.metrics());});
  admin.use((_req,res) => {res.status(404).json({error:'not_found'});});

  app.use(harden);
  app.use((req,res,next) => {
    const route = req.path === '/mcp' && cfg.mcpEnabled ? 'mcp' : req.path === '/api/v1/search' && cfg.apiEnabled ? 'api' : null;
    if (!route) {res.status(404).json({error:'not_found'});return;}
    const origin = req.headers.origin;
    if (origin && !cfg.allowedOrigins.includes(origin)) {
      rejects.inc({reason:'origin'});res.status(403).json({error:'origin_denied'});return;
    }
    if (origin) {
      res.set('Access-Control-Allow-Origin',origin); res.set('Vary','Origin');
      res.set('Access-Control-Allow-Methods',route === 'api' ? 'GET, POST, OPTIONS' : 'POST, OPTIONS');
      res.set('Access-Control-Allow-Headers','Content-Type, Authorization, Accept, MCP-Protocol-Version');
    }
    if (req.method === 'OPTIONS') {res.status(204).end();return;}
    if (draining) {res.set('Retry-After','5');res.status(503).json({error:'draining'});return;}
    const principal = authenticateRequest(req.headers.authorization);
    if (!principal) {rejects.inc({reason:'unauth'});res.set('WWW-Authenticate','Bearer');res.status(401).json({error:'authentication_required'});return;}
    const permitted = route === 'api' ? principal.scopes.includes('api:search') : principal.scopes.some(s => s.startsWith('mcp:'));
    if (!permitted) {rejects.inc({reason:'scope'});res.status(403).json({error:'scope_denied'});return;}
    if (inflight >= cfg.maxInflight) {rejects.inc({reason:'inflight'});res.set('Retry-After','1');res.status(503).json({error:'overloaded'});return;}
    inflight++; inflightMetric.inc();
    const stopTimer = latency.startTimer({route});
    const ac = new AbortController();
    const timer = setTimeout(() => {
      ac.abort();
      if (!res.headersSent) res.status(504).json({error:'request_timeout'});
      else res.destroy();
    },cfg.requestTimeoutMs);
    let released = false;
    const release = () => {
      if (released) return; released=true;
      clearTimeout(timer); ac.abort(); inflight--; inflightMetric.dec(); stopTimer();
      requests.inc({route,status:`${Math.floor(res.statusCode/100)}xx`});
    };
    res.once('finish',release);res.once('close',release);
    res.locals.principal = principal;
    requestContext.run({signal:ac.signal,deadline:Date.now()+cfg.requestTimeoutMs,store,config:cfg,principal},() => {
      store.take(`${cfg.rateLimitPrefix}:principal:${principal.id}`,principal.rate_limit,cfg.rateLimitWindowSeconds*1000)
        .then(allowed => {
          if (ac.signal.aborted) return;
          if (!allowed) {rejects.inc({reason:'rate'});res.set('Retry-After',String(cfg.rateLimitWindowSeconds));res.status(429).json({error:'rate_limit_exceeded'});return;}
          next();
        }).catch(() => {if (!res.headersSent) {rejects.inc({reason:'store'});res.status(503).json({error:'quota_store_unavailable'});}});
    });
  });
  app.use(express.json({limit:cfg.requestMaxBytes,strict:true}));
  app.all('/api/v1/search',async (req:Request,res:Response) => {
    if (!['GET','POST'].includes(req.method)) {res.set('Allow','GET, POST');res.status(405).json({error:'method_not_allowed'});return;}
    const parsed = SearchInput.safeParse(req.method === 'GET' ? req.query : req.body);
    if (!parsed.success) {res.status(400).json({error:'invalid_search_parameters'});return;}
    try {
      const p = parsed.data;
      const found = await searxQuery({query:p.q,categories:p.category,engines:p.engines,pageno:p.page,language:p.language,time_range:p.time_range,safesearch:p.safesearch as 0|1|2});
      const results = found.results.flatMap(r => {
        const url = safeUrl(r.url); if (!url) return [];
        return [{title:boundedText(r.title,1024),url,snippet:boundedText(r.content,8192),engine:boundedText(r.engine ?? r.engines?.[0],128),score:Number.isFinite(r.score) ? r.score : 0}];
      }).slice(0,p.max_results);
      res.json({query:p.q,category:p.category,returned:results.length,results,partial:!!found.unresponsive_engines?.length,search_policy:found.search_policy});
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      if (error instanceof AdmissionError) {res.set('Retry-After','1');res.status(error.status).json({error:error.code});}
      else res.status(502).json({error:'search_upstream_unavailable'});
    }
  });
  app.post('/mcp',async (req,res) => {
    const principal = res.locals.principal as Principal;
    const body = req.body as {method?:string;params?:{name?:string}} | undefined;
    if (!body || Array.isArray(body)) {res.status(400).json({error:'invalid_mcp_request'});return;}
    if (body.method === 'tools/call') {
      const name = body.params?.name;
      const required: Scope[] = name && SEARCH_TOOLS.has(name) ? ['mcp:search'] : name && FETCH_TOOLS.has(name) ? name === 'search_and_extract' ? ['mcp:search','mcp:fetch'] : ['mcp:fetch'] : [];
      if ((name && FETCH_TOOLS.has(name) && !cfg.fetchEnabled) || required.some(scope => !principal.scopes.includes(scope))) {
        rejects.inc({reason:'scope'});res.status(403).json({error:'tool_scope_denied'});return;
      }
    }
    const server = createServer();
    if (principal.scopes.includes('mcp:search')) registerSearchTools(server);
    if (cfg.fetchEnabled && principal.scopes.includes('mcp:fetch')) {
      registerFetchTools(server);registerRedditTools(server);
      if (principal.scopes.includes('mcp:search')) registerResearchTools(server);
    }
    const transport = new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    const close = () => {void server.close().catch(() => undefined);};
    res.once('close',close);
    try {await server.connect(transport);await transport.handleRequest(req,res,req.body);}
    catch {if (!res.headersSent && !res.destroyed) res.status(500).json({error:'mcp_request_failed'});}
    finally {res.off('close',close);await server.close().catch(() => undefined);}
  });
  app.all('/mcp',(_req,res) => {res.set('Allow','POST');res.status(405).json({error:'method_not_allowed'});});
  app.use((err: {status?:number},_req:Request,res:Response,_next:express.NextFunction) => {
    if (!res.headersSent) res.status(err.status === 413 ? 413 : 400).json({error:err.status === 413 ? 'request_too_large' : 'invalid_request'});
  });
  return {app,admin,registry,drain:() => {draining=true;},activeRequests:() => inflight};
}
