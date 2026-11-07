import { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent } from 'undici';

const excluded = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0',8], ['10.0.0.0',8], ['100.64.0.0',10], ['127.0.0.0',8],
  ['169.254.0.0',16], ['172.16.0.0',12], ['192.0.0.0',24], ['192.0.2.0',24],
  ['192.168.0.0',16], ['198.18.0.0',15], ['198.51.100.0',24], ['203.0.113.0',24],
  ['224.0.0.0',4], ['240.0.0.0',4],
] as const) excluded.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['2001::',23],['2001:db8::',32],['2002::',16]] as const) {
  excluded.addSubnet(address, prefix, 'ipv6');
}
const globalV6 = new BlockList();
globalV6.addSubnet('2000::',3,'ipv6');
const mappedV4 = new BlockList();
mappedV4.addSubnet('::ffff:0:0',96,'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (!family) return false;
  const type = family === 6 ? 'ipv6' : 'ipv4';
  if (excluded.check(address,type)) return false;
  return family === 4 || globalV6.check(address,'ipv6') || mappedV4.check(address,'ipv6');
}

export function validateFetchUrl(url: URL): void {
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80','443'].includes(url.port))) {
    throw new Error('Fetch destinations require credential-free HTTP(S) on port 80 or 443');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g,'');
  if (isIP(hostname) && !isPublicAddress(hostname)) throw new Error('Fetch destination is not a public address');
}

/** The connection uses these checked DNS answers; no second unchecked resolution. */
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname,{all:true,verbatim:true,family:options.family},(error,answers) => {
    if (error) {callback(error,'',4);return;}
    if (!answers.length || answers.some(answer => !isPublicAddress(answer.address))) {
      const denied = Object.assign(new Error('Fetch DNS response contains a non-public address'),{code:'EACCES'});
      callback(denied,'',4);return;
    }
    if (options.all) callback(null,answers);
    else callback(null,answers[0].address,answers[0].family);
  });
};

export const publicOnlyDispatcher = new Agent({
  connections:16, pipelining:1, connect:{lookup:publicLookup,timeout:5000},
});
