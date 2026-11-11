import {fixtureEnginePolicy} from './fixtures.js';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {Server} from 'node:http';
import {createServer as httpServer} from 'node:http';
import {createApplication} from '../src/app.js';
import {readConfig,type Config} from '../src/constants.js';
import {AdmissionError,MemoryAdmissionStore,type AdmissionStore} from '../src/utils/admission.js';
import {digestToken,loadPrincipals,parsePrincipals,type Principal} from '../src/middleware/auth.js';
const TOKEN='fixture-client-secret';
const makePrincipal=(id='client',scopes:Principal['scopes']=['api:search','mcp:search'],rate_limit=1000):Principal=>({id,scopes,rate_limit,token_sha256:digestToken(TOKEN)});
const servers:Server[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(servers.splice(0).map(s=>new Promise<void>(resolve=>{s.closeAllConnections();s.close(()=>resolve());})));});
async function listen(server:Server):Promise<string>{servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const a=server.address();return `http://127.0.0.1:${a && typeof a!=='string' ? a.port : 0}`;}
async function backend(opts:{status?:number,latency?:number,slowBody?:boolean}={}){
  let count=0, health=0;
  const url=await listen(httpServer((req,res)=>{
    if(req.url==='/healthz'){health++;res.writeHead(opts.status??200);res.end('ok');return;}
    count++;
    let body='';req.on('data',d=>body+=d);req.on('end',()=>{
      const q=new URLSearchParams(body).get('q');
      setTimeout(()=>{res.setHeader('content-type','application/json');if(opts.status){res.statusCode=opts.status;res.end('{}');return;}
        if(opts.slowBody){res.write('{"results":[');return;}
        res.end(JSON.stringify({query:q,number_of_results:2,results:[{title:q,url:'https://example.com/',content:'result'},{title:'bad',url:'javascript:alert(1)'}]}));
      },opts.latency??0);
    });
  }));
  return {url,count:()=>count,health:()=>health};
}
async function app(overrides:Partial<Config>={},principals=[makePrincipal()],store:AdmissionStore=new MemoryAdmissionStore()){
  const cfg={...readConfig({}),enginePolicy:fixtureEnginePolicy,...overrides};
  const service=createApplication(cfg,store,principals);
  const url=await listen(httpServer(service.app));
  const adminUrl=await listen(httpServer(service.admin));
  return {...service,url,adminUrl};
}
async function request(url:string,path:string,body?:unknown,headers:Record<string,string>={}){
  return fetch(url+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${TOKEN}`,...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
}
async function mcp(url:string,id:number,method:string,params:unknown={}){
  const response=await request(url,'/mcp',{jsonrpc:'2.0',id,method,params},{Accept:'application/json, text/event-stream'});
  return {status:response.status,body:await response.json()};
}
describe('principal configuration',()=>{
  it('refuses boot without credentials through the actual application factory',()=>{
    expect(()=>createApplication(readConfig({}),new MemoryAdmissionStore())).toThrow(/Authentication required/);
  });
  it('validates duplicate tokens, duplicate IDs, unknown fields, expiry and scopes',()=>{
    expect(()=>parsePrincipals({principals:[makePrincipal(),makePrincipal('other')]})).toThrow(/Duplicate/);
    expect(()=>parsePrincipals({principals:[{...makePrincipal(),scopes:['admin']}]})).toThrow();
    expect(()=>parsePrincipals({principals:[{...makePrincipal(),expires_at:'next week'}]})).toThrow();
    expect(()=>parsePrincipals({principals:[{...makePrincipal(),token:'raw-token'}]})).toThrow();
  });
  it('requires a fetch allowlist when explicitly enabled',()=>{
    expect(()=>loadPrincipals(readConfig({SEARXNG_MCP_TOKEN:TOKEN,SEARXNG_MCP_FETCH_ENABLED:'true'}))).toThrow(/allowlist/);
    expect(()=>createApplication({...readConfig({}),enginePolicy:fixtureEnginePolicy,fetchEnabled:true},new MemoryAdmissionStore(),[makePrincipal()])).toThrow(/allowlist/);
  });
  it('binds the admin listener to loopback by default and forbids sharing the API port',()=>{
    expect(readConfig({}).adminBindHost).toBe('127.0.0.1');
    expect(readConfig({}).bindHost).toBe('127.0.0.1');
    expect(readConfig({SEARXNG_MCP_BIND_HOST:'0.0.0.0'}).bindHost).toBe('0.0.0.0');
    expect(readConfig({}).adminPort).not.toBe(readConfig({}).port);
    expect(()=>readConfig({SEARXNG_MCP_PORT:'8600',SEARXNG_MCP_ADMIN_PORT:'8600'})).toThrow(/differ/);
  });
  it('rejects malformed numeric and boolean configuration',()=>{
    expect(()=>readConfig({SEARXNG_MCP_MAX_INFLIGHT:'10junk'})).toThrow();
    expect(()=>readConfig({SEARXNG_API_ENABLED:'yes'})).toThrow();
  });
});
describe('API authorization and contract',()=>{
  it('is unavailable by default and can enable REST while disabling MCP',async()=>{
    const off=await app();expect((await request(off.url,'/api/v1/search?q=test')).status).toBe(404);
    const up=await backend();const on=await app({apiEnabled:true,mcpEnabled:false,searxngUrl:up.url});
    expect((await mcp(on.url,1,'tools/list')).status).toBe(404);
    const response=await request(on.url,'/api/v1/search?q=hello');expect(response.status).toBe(200);
    const result=await response.json();expect(result.query).toBe('hello');expect(result.results).toHaveLength(1);expect(result.results[0].url).toBe('https://example.com/');
    const searching=await app({searxngUrl:up.url});
    const mcpResult=await mcp(searching.url,2,'tools/call',{name:'web_search',arguments:{query:'hello'}});
    const rendered=JSON.stringify(mcpResult.body);
    expect(rendered).toContain('https://example.com/');
    expect(rendered).not.toContain('javascript:');
  });
  it('requires exact Bearer syntax, unexpired credentials and API scope',async()=>{
    const service=await app({apiEnabled:true});
    expect((await request(service.url,'/api/v1/search?q=test',undefined,{Authorization:TOKEN})).status).toBe(401);
    const expired=await app({apiEnabled:true},[{...makePrincipal(),expires_at:'2020-01-01T00:00:00Z'}]);
    expect((await request(expired.url,'/api/v1/search?q=test')).status).toBe(401);
    const denied=await app({apiEnabled:true},[makePrincipal('machine',['mcp:search'])]);
    expect((await request(denied.url,'/api/v1/search?q=test')).status).toBe(403);
  });
  it('denies unlisted browser origins including preflight and accepts configured origins',async()=>{
    const service=await app({apiEnabled:true,allowedOrigins:['https://portal.example']});
    expect((await request(service.url,'/api/v1/search?q=test',undefined,{Origin:'https://evil.example'})).status).toBe(403);
    expect((await fetch(service.url+'/api/v1/search',{method:'OPTIONS',headers:{Origin:'https://evil.example'}})).status).toBe(403);
    const pre=await fetch(service.url+'/api/v1/search',{method:'OPTIONS',headers:{Origin:'https://portal.example'}});expect(pre.status).toBe(204);expect(pre.headers.get('access-control-allow-origin')).toBe('https://portal.example');
  });
  it('rejects arbitrary engines, URLs, pages and bang engine overrides',async()=>{
    const up=await backend();const service=await app({apiEnabled:true,searxngUrl:up.url});
    for(const path of ['/api/v1/search?q=test&engines=unlisted-engine','/api/v1/search?q=test&url=http://localhost','/api/v1/search?q=test&page=6','/api/v1/search?q=!google%20test'])expect((await request(service.url,path)).status).toBe(400);
    expect(up.count()).toBe(0);
  });
  it('blocks bang selection after every Python whitespace separator',async()=>{
    const up=await backend();const service=await app({apiEnabled:true,searxngUrl:up.url});
    for(const separator of ['\u0085','\u001c','\u001d','\u001e','\u001f']) {
      expect((await request(service.url,'/api/v1/search',{q:`term${separator}!general`})).status).toBe(400);
    }
    for(const q of ['term <9999','term\u0085<9999','term <\u0661\u0662']) {
      expect((await request(service.url,'/api/v1/search',{q})).status).toBe(400);
    }
    expect(up.count()).toBe(0);
  });
  it('enforces a body cap before tool execution',async()=>{
    const service=await app({apiEnabled:true,requestMaxBytes:1024});
    expect((await request(service.url,'/api/v1/search',{q:'x'.repeat(3000)})).status).toBe(413);
  });
  it('accepts explicit inventory engines with a four-engine maximum and reports selection',async()=>{
    const up=await backend();const service=await app({apiEnabled:true,searxngUrl:up.url});
    const response=await request(service.url,'/api/v1/search',{q:'test',engines:['fixture-fallback']});
    expect(response.status).toBe(200);
    expect((await response.json()).search_policy).toMatchObject({engines:['fixture-fallback'],attempts:1,fallback_used:false});
    expect((await request(service.url,'/api/v1/search',{q:'test',engines:Array(5).fill('fixture-primary')})).status).toBe(400);
    expect(up.count()).toBe(1);
  });
});
describe('shared admission and failures',()=>{
  it('shares per-principal quotas across application replicas',async()=>{
    const store=new MemoryAdmissionStore();const up=await backend();
    const principal=makePrincipal('limited',['api:search'],1);
    const first=await app({apiEnabled:true,searxngUrl:up.url},[principal],store),second=await app({apiEnabled:true,searxngUrl:up.url},[principal],store);
    expect((await request(first.url,'/api/v1/search?q=first')).status).toBe(200);
    expect((await request(second.url,'/api/v1/search?q=second')).status).toBe(429);expect(up.count()).toBe(1);
  });
  it('fails closed when the shared quota backend fails',async()=>{
    const store:AdmissionStore={take:async()=>{throw new Error('offline');},ready:async()=>false,close:async()=>{}};
    const service=await app({apiEnabled:true},[makePrincipal()],store);
    expect((await request(service.url,'/api/v1/search?q=test')).status).toBe(503);
  });
  it('charges the upstream budget across API and MCP plus retries',async()=>{
    const store=new MemoryAdmissionStore();const up=await backend();
    const service=await app({apiEnabled:true,searxngUrl:up.url,searchRate:1},[makePrincipal()],store);
    expect((await request(service.url,'/api/v1/search?q=one')).status).toBe(200);
    const result=await mcp(service.url,3,'tools/call',{name:'web_search',arguments:{query:'two'}});
    expect(result.body.result.isError).toBe(true);expect(up.count()).toBe(1);
    const broken=await backend({status:503});const failing=await app({apiEnabled:true,searxngUrl:broken.url,searchRate:1,fetchRetries:1});
    expect((await request(failing.url,'/api/v1/search?q=one')).status).toBe(429);expect(broken.count()).toBe(1);
  });
  it('readiness checks actual status, while liveness stays independent',async()=>{
    const up=await backend({status:503});const service=await app({searxngUrl:up.url});
    expect((await fetch(service.adminUrl+'/ready')).status).toBe(503);expect((await fetch(service.adminUrl+'/health')).status).toBe(200);
  });
  it('serves probes and metrics only on the admin listener, with bounded readiness upstream checks',async()=>{
    const up=await backend();const service=await app({apiEnabled:true,searxngUrl:up.url});
    for(const path of ['/metrics','/ready','/health']){expect((await request(service.url,path)).status).toBe(404);}
    expect((await fetch(service.url+'/metrics')).status).toBe(404);
    expect((await fetch(service.adminUrl+'/ready')).status).toBe(200);
    expect((await fetch(service.adminUrl+'/ready')).status).toBe(200);
    expect(up.health()).toBe(1);
    const metrics=await fetch(service.adminUrl+'/metrics');expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain('searxng_mcp_requests_total');
    expect((await fetch(service.adminUrl+'/unknown')).status).toBe(404);
    expect((await fetch(service.adminUrl+'/health')).headers.get('x-content-type-options')).toBe('nosniff');
  });
  it('maps upstream errors to 502 and timeouts to a bounded error',async()=>{
    const up=await backend({status:500});const service=await app({apiEnabled:true,searxngUrl:up.url,fetchRetries:0});
    expect((await request(service.url,'/api/v1/search?q=test')).status).toBe(502);
    const slow=await backend({slowBody:true});const timed=await app({apiEnabled:true,searxngUrl:slow.url,requestTimeoutMs:150,fetchTimeoutMs:1000});
    expect((await request(timed.url,'/api/v1/search?q=test')).status).toBe(504);
  });
  it('bounds in-flight work and rejects work when draining',async()=>{
    const up=await backend({latency:150});const service=await app({apiEnabled:true,searxngUrl:up.url,maxInflight:1});
    const first=request(service.url,'/api/v1/search?q=one');await new Promise(r=>setTimeout(r,30));
    expect((await request(service.url,'/api/v1/search?q=two')).status).toBe(503);expect((await first).status).toBe(200);
    service.drain();expect((await request(service.url,'/api/v1/search?q=three')).status).toBe(503);expect((await fetch(service.adminUrl+'/ready')).status).toBe(503);
  });
});
describe('search result sanitization',()=>{
  it('drops private result URLs and bounds MCP search fields',async()=>{
    const url=await listen(httpServer((req,res)=>{
      if(req.url==='/healthz'){res.end('ok');return;}
      let body='';req.on('data',d=>body+=d);req.on('end',()=>{
        res.setHeader('content-type','application/json');
        res.end(JSON.stringify({
          query:'x',number_of_results:7,
          results:[
            {title:'ok',url:'https://example.com/public',content:'safe'},
            {title:'loop',url:'http://127.0.0.1/admin',content:'nope'},
            {title:'meta',url:'http://169.254.169.254/latest/meta-data',content:'nope'},
            {title:'mapped',url:'http://[::ffff:10.1.2.3]/',content:'nope'},
            {title:'local',url:'http://localhost/secret',content:'nope'},
            {title:'hex',url:'http://0x7f000001/',content:'nope'},
            {title:'A'.repeat(4000),url:'https://example.com/long',content:'B'.repeat(20000),author:'C'.repeat(500)},
          ],
          suggestions:['s'.repeat(2000),12,'ok'],
          answers:['a'.repeat(5000)],
        }));
      });
    }));
    const service=await app({apiEnabled:true,searxngUrl:url});
    const api=await (await request(service.url,'/api/v1/search?q=test')).json() as {results:{title:string,url:string,snippet:string}[]};
    expect(api.results.map(r=>r.url)).toEqual(['https://example.com/public','https://example.com/long']);
    expect(api.results[1].title.length).toBe(1024);
    expect(api.results[1].snippet.length).toBe(8192);
    const mcpResult=await mcp(service.url,1,'tools/call',{name:'web_search',arguments:{query:'test'}});
    const parsed=JSON.parse(mcpResult.body.result.content[0].text) as {results:{title:string,url:string,snippet:string,author?:string}[],suggestions:string[],answers:string[]};
    expect(parsed.results.map(r=>r.url)).toEqual(['https://example.com/public','https://example.com/long']);
    const long=parsed.results[1];
    expect(long.title.length).toBe(1024);
    expect(long.snippet.length).toBe(8192);
    expect(long.author?.length).toBe(256);
    expect(parsed.suggestions).toEqual(['s'.repeat(512),'ok']);
    expect(parsed.answers[0].length).toBe(2048);
    const badLang=await mcp(service.url,2,'tools/call',{name:'web_search',arguments:{query:'test',language:'en&engines=all'}});
    expect(badLang.body.result?.isError ?? badLang.status>=400).toBeTruthy();
  });
});
describe('outbound fetch admission through MCP',()=>{
  it('fails closed before any outbound request when the shared quota store is unavailable',async()=>{
    const fetch=vi.spyOn(globalThis,'fetch');
    const store:AdmissionStore={take:async key=>{if(key.includes(':fetch:'))throw new AdmissionError(503,'quota_store_unavailable');return true;},ready:async()=>true,close:async()=>{}};
    const service=await app({fetchEnabled:true,allowedDomains:['example.com']},[makePrincipal('client',['mcp:fetch'])],store);
    const result=await mcp(service.url,1,'tools/call',{name:'fetch_url',arguments:{url:'https://example.com/page'}});
    expect(result.body.result.isError).toBe(true);expect(result.body.result.content[0].text).toContain('quota_store_unavailable');
    expect(fetch.mock.calls.filter(call=>!String(call[0]).startsWith(service.url))).toHaveLength(0);
  });
});
describe('MCP isolation and tool authorization',()=>{
  it('lists scoped tools and rejects composite fetch without both scopes',async()=>{
    const service=await app({fetchEnabled:true,allowedDomains:['example.com']},[makePrincipal('client',['mcp:search'])]);
    const list=await mcp(service.url,1,'tools/list');expect(list.body.result.tools.map((t:{name:string})=>t.name)).toHaveLength(5);
    expect((await mcp(service.url,2,'tools/call',{name:'search_and_extract',arguments:{query:'secret'}})).status).toBe(403);
    const all=await app({fetchEnabled:true,allowedDomains:['example.com']},[makePrincipal('client',['mcp:search','mcp:fetch'])]);
    expect((await mcp(all.url,1,'tools/list')).body.result.tools).toHaveLength(11);
  });
  it('isolates concurrent stateless MCP transports and their responses',async()=>{
    const up=await backend({latency:30});const service=await app({searxngUrl:up.url});
    const result=await Promise.all(Array.from({length:12},(_,i)=>mcp(service.url,i+1,'tools/call',{name:'web_search',arguments:{query:`request-${i}`}})));
    result.forEach((r,i)=>{
      expect(r.status).toBe(200);
      expect(r.body.id).toBe(i+1);
      const parsed=JSON.parse(r.body.result.content[0].text);
      expect(parsed.query).toBe(`request-${i}`);
      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0].url).toBe('https://example.com/');
    });
    expect(up.count()).toBe(12);
  });
});
