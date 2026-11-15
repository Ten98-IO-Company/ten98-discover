import {BlockList,isIP} from 'node:net';
import {publicNetworkAddress} from '@ten98/runtime';

// ponytail: Discover-side refusals on top of the shared @ten98/runtime policy, which keeps every range it already
// refuses (IANA special-purpose IPv4, 2001::/23 including 2001:db8::/32, 2002::/16 6to4, 2620:4f:8000::/48, 3fff::/20).
// Upgrade path: move these two rules into runtime's publicNetworkAddress, then import it directly and delete this file.

// Azure's platform host (wire server / DNS / health probes), reachable from any Azure VM though outside private space.
const refusedIpv4=new BlockList();
refusedIpv4.addAddress('168.63.129.16','ipv4');

// Only 2000::/3 is global unicast. This bitwise test replaces runtime's first-character check, which also admitted
// 0000::/8 forms such as 2::1 or 3ff::1. IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96) and NAT64
// (64:ff9b::/96, 64:ff9b:1::/48) forms all fall outside it, so they are refused whatever IPv4 address they embed;
// DNS answers must use the A record instead. Connected-peer checks still accept the mapped spelling of a pinned IPv4.
const globalUnicast=new BlockList();
globalUnicast.addSubnet('2000::',3,'ipv6');

/** Admission test for every outbound connection to a user-influenced host: crawl, redirect checks and OIDC. */
export function publicTargetAddress(address:string):boolean{
  if(!publicNetworkAddress(address))return false;
  return isIP(address)===4?!refusedIpv4.check(address,'ipv4'):globalUnicast.check(address,'ipv6');
}
