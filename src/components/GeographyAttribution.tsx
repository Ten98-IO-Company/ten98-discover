import {Link,Text} from '@ten98/ui';
export function GeographyAttribution(){
  return <Text as="p" size="sm" tone="muted"><Link href="https://db-ip.com" target="_blank">IP location data by DB-IP</Link> · Approximate location, supplied under <Link href="https://creativecommons.org/licenses/by/4.0/" target="_blank">CC BY 4.0</Link>.</Text>;
}
