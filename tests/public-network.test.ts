import { describe, expect, it } from 'vitest';
import { isPublicAddress, publicLookup, validateFetchUrl } from '../src/utils/public-network.js';

describe('Public-only fetch network boundary', () => {
  it('denies private, metadata, loopback, reserved and IPv4-mapped internal destinations', () => {
    for (const address of ['127.0.0.1','10.1.2.3','192.168.1.1','169.254.169.254','100.100.100.200',
      '0.0.0.0','224.0.0.1','198.18.0.1','192.0.2.4','::1','fe80::1','fd00::1','2001:db8::1',
      '::ffff:127.0.0.1','::ffff:7f00:1','::ffff:10.1.2.3','2002:7f00:1::',
      '64:ff9b::7f00:1','64:ff9b::a9fe:a9fe']) {
      expect(isPublicAddress(address),address).toBe(false);
    }
  });
  it('permits ordinary global IPv4 and IPv6 addresses', () => {
    for (const address of ['1.1.1.1','8.8.8.8','2606:4700:4700::1111','::ffff:8.8.8.8']) {
      expect(isPublicAddress(address),address).toBe(true);
    }
  });
  it('validates literals after URL normalization, credentials and unusual ports', () => {
    for (const url of ['http://0x7f000001/','http://2130706433/','https://[::ffff:127.0.0.1]/',
      'https://user:secret@example.org/','https://example.org:8443/','ftp://example.org/']) {
      expect(() => validateFetchUrl(new URL(url))).toThrow();
    }
    expect(() => validateFetchUrl(new URL('https://example.org/'))).not.toThrow();
  });
  it('rejects localhost during the resolver used by the actual connection', async () => {
    await expect(new Promise((resolve,reject) => publicLookup('localhost', {all:true}, (error,address) => {
      if (error) reject(error); else resolve(address);
    }))).rejects.toMatchObject({code:'EACCES'});
  });
});
