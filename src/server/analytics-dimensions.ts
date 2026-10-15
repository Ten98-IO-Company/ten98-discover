import {geographyKeySql} from './geography-sql.ts';

/** Fixed projection shared by Explorer and comparison; selectors and aliases are internal constants. */
export function analyticsDimensionValueSql(selector:string,alias:string){
 return `CASE ${selector} WHEN 'event' THEN to_jsonb(${alias}.event_name) WHEN 'path' THEN to_jsonb(${alias}.path) WHEN 'origin' THEN to_jsonb(${alias}.origin)
 WHEN 'country' THEN ${geographyKeySql('country',`${alias}.geography`)} WHEN 'region' THEN ${geographyKeySql('region',`${alias}.geography`)} WHEN 'city' THEN ${geographyKeySql('city',`${alias}.geography`)}
 WHEN 'referrer' THEN ${alias}.dimensions->'referrerHost' WHEN 'language' THEN ${alias}.dimensions->'language'
 WHEN 'browser' THEN ${alias}.dimensions->'browser' WHEN 'os' THEN ${alias}.dimensions->'os' WHEN 'device' THEN ${alias}.dimensions->'device'
 WHEN 'screenWidth' THEN ${alias}.dimensions->'screenWidth' WHEN 'screenHeight' THEN ${alias}.dimensions->'screenHeight'
 WHEN 'campaignSource' THEN ${alias}.dimensions->'campaign'->'source' WHEN 'campaignMedium' THEN ${alias}.dimensions->'campaign'->'medium'
 WHEN 'campaignName' THEN ${alias}.dimensions->'campaign'->'campaign' WHEN 'campaignTerm' THEN ${alias}.dimensions->'campaign'->'term' WHEN 'campaignContent' THEN ${alias}.dimensions->'campaign'->'content' END`;
}
