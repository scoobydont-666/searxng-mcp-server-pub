import { AdmissionError } from './admission.js';
import { requestContext } from './request-context.js';
import { enginePlan, rejectQueryOverrides } from './engine-policy.js';

export interface SearxResult {
  url:string; title:string; content?:string; engine?:string; engines?:string[];
  category?:string; score?:number; publishedDate?:string|null; thumbnail?:string;
  img_src?:string; iframe_src?:string; audio_src?:string; metadata?:string;
  author?:string; parsed_url?:string[];
}
export interface SearxResponse {
  query:string; number_of_results:number; results:SearxResult[];
  unresponsive_engines?:Array<[string,string]>; suggestions?:string[]; answers?:string[];
  corrections?:string[]; infoboxes?:unknown[];
  search_policy?: { attempts:number; fallback_used:boolean; engines:string[]; fallback_reason?:string };
}
export interface SearchParams {
  query:string; categories?:string; engines?:string; language?:string; pageno?:number;
  time_range?:'day'|'week'|'month'|'year'|''; safesearch?:0|1|2;
}
/** Read through the body under the deadline, bounding decompressed response bytes. */
async function boundedJson(res:Response, maxBytes:number): Promise<unknown> {
  if (Number(res.headers.get('content-length') ?? 0) > maxBytes) {await res.body?.cancel();throw new Error('Search response too large');}
  const reader = res.body?.getReader(); if (!reader) throw new Error('Empty upstream response');
  const chunks:Uint8Array[]=[];let bytes=0;
  try {
    for (;;) { const {done,value}=await reader.read();if(done) break;if(value){bytes+=value.byteLength;if(bytes>maxBytes)throw new Error('Search response too large');chunks.push(value);} }
  } catch(error) {await reader.cancel().catch(() => undefined);throw error;}
  finally {reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function searxQuery(params:SearchParams):Promise<SearxResponse> {
  const context = requestContext.getStore();
  if (!context) throw new AdmissionError(503,'request_context_required');
  const cfg = context.config;
  if (!params.query.trim() || params.query.length>2048) throw new AdmissionError(400,'invalid_query');
  // SearXNG bang syntax can select engines inside q and bypass the bounded plan.
  rejectQueryOverrides(params.query);
  const category = params.categories ?? 'general';
  const pools = enginePlan(cfg.enginePolicy, category, params.engines);
  const url = new URL('/search',cfg.searxngUrl);
  let fallbackReason: string | undefined;
  for (const [attempt, engines] of pools.entries()) {
    context.signal.throwIfAborted();
    // Each distinct engine pool is one actual upstream call and consumes shared admission.
    let admitted: boolean;
    try { admitted = await context.store.take(`${cfg.rateLimitPrefix}:search`,cfg.searchRate,1000); }
    catch { throw new AdmissionError(503,'quota_store_unavailable'); }
    if (!admitted) throw new AdmissionError(429,'search_capacity_exceeded');
    // SearXNG appends every category engine when categories accompanies engines.
    // Keep category selection local; the explicit bounded engine list is authoritative.
    const body = new URLSearchParams({q:params.query,format:'json',pageno:String(params.pageno ?? 1),safesearch:String(params.safesearch ?? 0),
      engines:engines.join(','),...(params.language ? {language:params.language} : {}),...(params.time_range ? {time_range:params.time_range} : {})});
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(),cfg.searchTimeoutMs);
    const signal = AbortSignal.any([controller.signal,context.signal]);
    try {
      const response = await fetch(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json','User-Agent':cfg.userAgent},body:body.toString(),signal,redirect:'error'});
      if ([403,429,503].includes(response.status)) {
        await response.body?.cancel(); fallbackReason = `http_${response.status}`;
      } else if (!response.ok) {
        await response.body?.cancel(); throw new Error('Search upstream rejected request');
      } else {
        const value = await boundedJson(response,cfg.searchMaxBytes);
        if (!value || typeof value!=='object' || !Array.isArray((value as SearxResponse).results)) throw new Error('Malformed search response');
        const result = value as SearxResponse;
        if (result.results.some(r => !r || typeof r!=='object' || typeof r.url!=='string' || typeof r.title!=='string')) throw new Error('Malformed search result');
        if (result.unresponsive_engines !== undefined && (!Array.isArray(result.unresponsive_engines) || result.unresponsive_engines.some(item => !Array.isArray(item) || typeof item[0] !== 'string' || typeof item[1] !== 'string'))) throw new Error('Malformed engine status');
        if (!result.results.length && result.unresponsive_engines?.length) {
          fallbackReason = 'empty_unresponsive_pool';
        } else {
          return {...result,query:params.query,search_policy:{attempts:attempt+1,fallback_used:attempt>0,engines:[...engines],...(attempt>0 ? {fallback_reason:fallbackReason} : {})}};
        }
      }
    } catch (error) {
      if (context.signal.aborted) throw error;
      if (controller.signal.aborted) fallbackReason = 'upstream_timeout';
      else throw error;
    } finally { clearTimeout(timeout); }
    // No retries against the blocked pool, identity changes, or challenge solving.
  }
  throw new Error('Configured search engine pools unavailable');
}
