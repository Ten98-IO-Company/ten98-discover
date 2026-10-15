import {analyticsDay,sessionNavigation} from './navigation.ts';

export const revenueCalendarPresets = [
  ['today','Today'],
  ['week','This week (Sunday–Saturday)'],
  ['7days','Last 7 calendar days'],
  ['month','This month'],
  ['30days','Last 30 calendar days'],
  ['90days','Last 90 calendar days'],
  ['year','This year'],
  ['6months','6 calendar months, including this month'],
  ['12months','12 calendar months, including this month'],
] as const;

// Calendar tokens only: PostgreSQL still resolves local event boundaries and DST.
export function revenueCalendarRange(preset:string,timeZone:string,now=new Date()):{from:string;to:string}|null {
  if(!revenueCalendarPresets.some(([key])=>key===preset)||!Number.isFinite(now.getTime()))return null;
  try {
    const zone=timeZone.trim(),parts=Object.fromEntries(new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(p=>[p.type,p.value]));
    const today=`${parts.year.padStart(4,'0')}-${parts.month}-${parts.day}`,time=analyticsDay(today);if(time===null)return null;
    const from=new Date(time),to=new Date(time);
    if(preset==='week'){from.setUTCDate(from.getUTCDate()-from.getUTCDay());to.setUTCFullYear(from.getUTCFullYear(),from.getUTCMonth(),from.getUTCDate()+6);}
    else if(preset.endsWith('days'))from.setUTCDate(from.getUTCDate()-(Number(preset.slice(0,-4))-1));
    else if(preset==='year'){from.setUTCMonth(0,1);to.setUTCMonth(11,31);}
    else if(preset==='month'||preset.endsWith('months')){from.setUTCDate(1);from.setUTCMonth(from.getUTCMonth()-(preset==='month'?0:Number(preset.slice(0,-6))-1));to.setUTCMonth(to.getUTCMonth()+1,0);}
    const range={from:from.toISOString().slice(0,10),to:to.toISOString().slice(0,10)},validated=sessionNavigation({...range,timeZone:zone});
    return validated.sessionInvalid?null:range;
  } catch {return null;}
}
