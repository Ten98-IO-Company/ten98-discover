import {InputError} from './validation.ts';
import {explorerFilters,explorerQuery} from './explorer-input.ts';
import type {RetentionQuery} from '../lib/retention-report.ts';

const names=new Set(['month','timeZone','kind',...explorerFilters,'propertyKey','propertyType','propertyValue','predicates','cohortId','cohortRevision']);
export function retentionReportQuery(params:URLSearchParams,now=new Date()){
  if(params.toString().length>20000||[...params.keys()].some(key=>!names.has(key)||params.getAll(key).length!==1))throw new InputError(400,'Use each supported retention filter once, within the query limit.');
  const month=params.get('month');
  if(!month||!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)||month<'1970-01'||month>'9998-12'||!params.get('timeZone'))throw new InputError(400,'Choose a valid month and an IANA timezone.');
  const from=month+'-01',to=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).toISOString().slice(0,10),entry=new URLSearchParams(params);entry.delete('month');entry.set('from',from);entry.set('to',to);
  const scope=explorerQuery(entry,now),parts=new Intl.DateTimeFormat('en-US',{timeZone:scope.timeZone,year:'numeric',month:'2-digit'}).formatToParts(now);
  const current=['year','month'].map(key=>parts.find(part=>part.type===key)!.value).join('-');
  if(month>current)throw new InputError(400,'This month has not started in the selected timezone.');
  const query:RetentionQuery={month,timeZone:scope.timeZone,kind:scope.kind as RetentionQuery['kind'],filters:scope.filters,property:scope.property as RetentionQuery['property'],...scope.predicates?{predicates:scope.predicates}:{},...scope.cohort?{cohort:scope.cohort}:{}};
  return {scope,query};
}
