import {revenueChannelRules} from '../lib/revenue.ts';
import {geographyKeySql} from './geography-sql.ts';

/** Closed projections of existing stored observations; aliases are internal SQL identifiers only. */
export function recordedDimensionSql(field:'hostname'|'screen'|'channel',alias:string):string{
 if(field==='hostname')return `substring(${alias}.dimensions->>'origin' from '^https?://(\\[[0-9a-f:.]+\\]|[a-z0-9.-]+)(?::[0-9]{1,5})?$')`;
 if(field==='screen')return `CASE WHEN jsonb_typeof(${alias}.dimensions->'screenWidth')='number' AND jsonb_typeof(${alias}.dimensions->'screenHeight')='number'
  AND ${alias}.dimensions->>'screenWidth' ~ '^([1-9][0-9]{0,3}|10000)$' AND ${alias}.dimensions->>'screenHeight' ~ '^([1-9][0-9]{0,3}|10000)$'
  THEN (${alias}.dimensions->>'screenWidth')||'x'||(${alias}.dimensions->>'screenHeight') END`;
 return "CASE "+revenueChannelRules.map(([name,tokens])=>"WHEN lower("+alias+".dimensions->'campaign'->>'medium')=ANY(ARRAY["+tokens.map(token=>"'"+token+"'").join(',')+"])THEN '"+name+"'").join(' ')
  +" WHEN NULLIF("+alias+".dimensions->'campaign'->>'medium','')IS NOT NULL OR NULLIF("+alias+".dimensions->'campaign'->>'source','')IS NOT NULL THEN 'other_tagged' WHEN NULLIF("+alias+".dimensions->>'referrerHost','')IS NOT NULL AND NOT "+selfReferralSql(alias)+" THEN 'referrer_only' ELSE 'not_recorded' END";
}
/**
 * A referrer host equal to the host of the event's own recorded origin is a self-referral (an in-app navigation, D11), never a referrer
 * for channels, touches or sources. A leading www. is ignored on both sides, as pinned Umami does; the host is read without a character
 * whitelist so any URL.hostname (underscores included) matches. No other alias counts, and an event without a recorded origin is never one.
 */
export function selfReferralSql(alias:string):string{
 const host=`substring(${alias}.dimensions->>'origin' from '^https?://(\\[[^]]+\\]|[^/:]+)')`;
 return `COALESCE(regexp_replace(NULLIF(${alias}.dimensions->>'referrerHost',''),'^www[.]','')=regexp_replace(${host},'^www[.]',''),false)`;
}
/** An untagged self-referral is internal navigation: attribution chooses another event of the same key first (revenue keeps its first observation). */
export function internalNavigationSql(alias:string){
 return `(${selfReferralSql(alias)} AND NOT(${alias}.dimensions ? 'campaign'))`;
}
export function analyticsDimensionValueSql(selector:string,alias:string){
 return `CASE ${selector} WHEN 'hostname' THEN to_jsonb(${recordedDimensionSql('hostname',alias)}) WHEN 'screen' THEN to_jsonb(${recordedDimensionSql('screen',alias)}) WHEN 'channel' THEN to_jsonb(${recordedDimensionSql('channel',alias)}) WHEN 'event' THEN to_jsonb(${alias}.event_name) WHEN 'path' THEN to_jsonb(${alias}.path) WHEN 'origin' THEN to_jsonb(${alias}.origin)
 WHEN 'country' THEN ${geographyKeySql('country',`${alias}.geography`)} WHEN 'region' THEN ${geographyKeySql('region',`${alias}.geography`)} WHEN 'city' THEN ${geographyKeySql('city',`${alias}.geography`)}
 WHEN 'referrer' THEN ${alias}.dimensions->'referrerHost' WHEN 'language' THEN ${alias}.dimensions->'language'
 WHEN 'browser' THEN ${alias}.dimensions->'browser' WHEN 'os' THEN ${alias}.dimensions->'os' WHEN 'device' THEN ${alias}.dimensions->'device'
 WHEN 'screenWidth' THEN ${alias}.dimensions->'screenWidth' WHEN 'screenHeight' THEN ${alias}.dimensions->'screenHeight'
 WHEN 'campaignSource' THEN ${alias}.dimensions->'campaign'->'source' WHEN 'campaignMedium' THEN ${alias}.dimensions->'campaign'->'medium'
 WHEN 'campaignName' THEN ${alias}.dimensions->'campaign'->'campaign' WHEN 'campaignTerm' THEN ${alias}.dimensions->'campaign'->'term' WHEN 'campaignContent' THEN ${alias}.dimensions->'campaign'->'content' END`;
}

/** Fixed SQL expressions from the Analytics and native-calendar report callers only. */
export function analyticsCustomVisitsSql(start:string,finish:string,calendar='TRUE'){
 return `SELECT DISTINCT e.visitor_id,e.visit_id FROM event e CROSS JOIN target t
  WHERE e.project_id=$1 AND e.received_at>=${start} AND e.received_at<${finish} AND (${calendar})
   AND (t.analytics_retained_from IS NULL OR e.received_at>=t.analytics_retained_from)
   AND e.event_name<>'page_view' AND e.visitor_id IS NOT NULL AND e.visit_id IS NOT NULL`;
}