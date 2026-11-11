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
for (const [address, prefix] of [
  ['2001::',23],['2001:db8::',32],['2002::',16],
  // Well-known NAT64 prefixes (not in 2000::/3 today; listed so the deny stays explicit).
  ['64:ff9b::',96],['64:ff9b:1::',48],
] as const) {
  excluded.addSubnet(address, prefix, 'ipv6');
}
const globalV6 = new BlockList();
globalV6.addSubnet('2000::',3,'ipv6');
const mappedV4 = new BlockList();
mappedV4.addSubnet('::ffff:0:0',96,'ipv6');

function ipv6Hextets(address: string): number[] | null {
  const bare = address.toLowerCase().split('%')[0]!.replace(/^\[|\]$/g, '');
  const sides = bare.split('::');
  if (sides.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const out: number[] = [];
    const groups = side.split(':');
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!;
      if (group.includes('.')) {
        if (i !== groups.length - 1 || isIP(group) !== 4) return null;
        const octets = group.split('.').map(Number);
        out.push(((octets[0]! << 8) | octets[1]!) & 0xffff, ((octets[2]! << 8) | octets[3]!) & 0xffff);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
        out.push(Number.parseInt(group, 16));
      }
    }
    return out;
  };
  if (sides.length === 1) {
    const all = parseSide(sides[0]!);
    return all && all.length === 8 ? all : null;
  }
  const left = parseSide(sides[0]!);
  const right = parseSide(sides[1]!);
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...Array<number>(missing).fill(0), ...right];
}

/** Last 32 bits of an IPv4-mapped IPv6 address (::ffff:0:0/96), or null. */
function ipv4FromMapped(address: string): string | null {
  const hextets = ipv6Hextets(address);
  if (!hextets) return null;
  if (hextets[0] || hextets[1] || hextets[2] || hextets[3] || hextets[4] || hextets[5] !== 0xffff) return null;
  return `${hextets[6]! >> 8}.${hextets[6]! & 255}.${hextets[7]! >> 8}.${hextets[7]! & 255}`;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (!family) return false;
  // Unwrap IPv4-mapped IPv6 explicitly. Node's BlockList can treat these as IPv4
  // today, but the fetch boundary must not depend on that implicit conversion.
  if (family === 6 && mappedV4.check(address, 'ipv6')) {
    const mapped = ipv4FromMapped(address);
    return mapped !== null && isPublicAddress(mapped);
  }
  const type = family === 6 ? 'ipv6' : 'ipv4';
  if (excluded.check(address,type)) return false;
  return family === 4 || globalV6.check(address,'ipv6');
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
