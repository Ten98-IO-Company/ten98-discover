import { BlockList, isIP } from 'node:net';

// Conservative public-unicast boundary. IANA special-purpose registries, checked 2026-10-13:
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
// Special-purpose anycast allocations are excluded too; this is for ordinary public web hosts.
const reserved = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0',8], ['10.0.0.0',8], ['100.64.0.0',10], ['127.0.0.0',8],
  ['169.254.0.0',16], ['172.16.0.0',12], ['192.0.0.0',24], ['192.0.2.0',24],
  ['192.31.196.0',24], ['192.52.193.0',24], ['192.88.99.0',24], ['192.168.0.0',16],
  ['192.175.48.0',24], ['198.18.0.0',15], ['198.51.100.0',24], ['203.0.113.0',24], ['224.0.0.0',3],
] as const) reserved.addSubnet(address,prefix,'ipv4');
for (const [address,prefix] of [
  ['2001::',23], ['2001:db8::',32], ['2002::',16], ['2620:4f:8000::',48], ['3fff::',20],
] as const) reserved.addSubnet(address,prefix,'ipv6');

export function addressKey(address:string):string {
  if (isIP(address)===4) return address;
  if (isIP(address)===6 && !address.includes('%')) {
    try{return new URL(`http://[${address}]`).hostname.slice(1,-1);}catch{return '';}
  }
  return '';
}

export function publicNetworkAddress(address:string):boolean {
  const canonical=addressKey(address);
  if (!canonical) return false;
  if (isIP(address)===4) return !reserved.check(address,'ipv4');
  // Only global unicast; mapped/translated IPv4, ULA, link-local and multicast fail closed.
  return /^[23]/.test(canonical) && !reserved.check(address,'ipv6');
}
