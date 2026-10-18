export const propertyWeekdays=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'] as const;
export type PropertyDateUnit='day'|'week'|'month'|'year';
export type PropertyDateSummary={samples:number|null;unit:PropertyDateUnit|null;earliest:string|null;latest:string|null;topDate:{date:string;count:number}|null;weekdays:number[]|null;histogram:{date:string;count:number}[]};
export type PropertyNumberStats={samples:number|null;sum:string|null;average:string|null;median:string|null;min:string|null;max:string|null};

// Native magnitudes are <=1e15 with <=324 fractional digits. Leave
// room for exact population sums/averages, without accepting unbounded BigInts.
export const propertyDecimal=(value:unknown):value is string=>typeof value==='string'&&value.length<=1024&&/^-?\d+(?:\.\d+)?$/.test(value);
export function comparePropertyDecimals(a:string,b:string):number{
  if(!propertyDecimal(a)||!propertyDecimal(b))throw new Error('Invalid property decimals.');
  const places=Math.max(a.split('.')[1]?.length??0,b.split('.')[1]?.length??0);
  const units=(value:string)=>BigInt(value.replace('.',''))*10n**BigInt(places-(value.split('.')[1]?.length??0));
  const left=units(a),right=units(b);return left<right?-1:left>right?1:0;
}
export function validPropertyNumberStats(value:unknown,maximum:number|null):value is PropertyNumberStats{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const data=value as PropertyNumberStats,decimals=[data.sum,data.average,data.median,data.min,data.max];
  if(maximum===null)return data.samples===null&&decimals.every(v=>v===null);
  if(!Number.isSafeInteger(data.samples)||data.samples===null||data.samples<0||data.samples>maximum)return false;
  if(data.samples===0)return decimals.every(v=>v===null);
  if(!decimals.every(propertyDecimal))return false;
  if(data.samples===1&&decimals.some(v=>comparePropertyDecimals(v!,data.sum!)!==0))return false;
  return comparePropertyDecimals(data.min!,data.median!)<=0&&comparePropertyDecimals(data.median!,data.max!)<=0&&comparePropertyDecimals(data.min!,data.average!)<=0&&comparePropertyDecimals(data.average!,data.max!)<=0;
}
export function propertyDecimalScale(values:(string|null)[]):(number|null)[]{
  if(values.length>732||!values.every(value=>value===null||propertyDecimal(value)))throw new Error('Invalid property chart decimals.');
  const places=Math.max(0,...values.map(value=>value?.split('.')[1]?.length??0));
  const units=values.map(value=>value===null?null:BigInt(value.replace('.',''))*10n**BigInt(places-(value.split('.')[1]?.length??0)));
  const maximum=units.reduce<bigint>((largest,value)=>value===null?largest:(value<0n?-value:value)>largest?(value<0n?-value:value):largest,0n);
  // Only coordinates are rounded toward zero to one millionth of the scale;
  // labels, summaries and CSV keep the original PostgreSQL decimal strings.
  return units.map(value=>value===null?null:maximum===0n?0:Number(value*1000000n/maximum)/1000000);
}

export function propertyCalendarDay(value:unknown):value is string{
  if(typeof value!=='string'||!/^(?:\d{4}|-000001|\+010000)-\d\d-\d\d$/.test(value))return false;
  const date=new Date(value+'T00:00:00.000Z');return Number.isFinite(date.getTime())&&date.toISOString().split('T')[0]===value;
}
export function propertyDateUnit(first:string,last:string):PropertyDateUnit{
  const span=(Date.parse(last+'T00:00:00Z')-Date.parse(first+'T00:00:00Z'))/86400000;
  return span<=45?'day':span<=180?'week':span<=730?'month':'year';
}
export function propertyDateBucket(value:string,unit:PropertyDateUnit,advance=false):string{
  const date=new Date(value+'T00:00:00.000Z');
  if(unit==='week')date.setUTCDate(date.getUTCDate()-(date.getUTCDay()+6)%7);
  if(unit==='month'||unit==='year')date.setUTCDate(1);
  if(unit==='year')date.setUTCMonth(0);
  if(advance){if(unit==='year')date.setUTCFullYear(date.getUTCFullYear()+1);else if(unit==='month')date.setUTCMonth(date.getUTCMonth()+1);else date.setUTCDate(date.getUTCDate()+(unit==='week'?7:1));}
  return date.toISOString().split('T')[0];
}
export function validPropertyDateSummary(value:unknown,maximum:number|null):value is PropertyDateSummary{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const data=value as PropertyDateSummary,count=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
  if(!Array.isArray(data.histogram)||data.histogram.length>10002)return false;
  if(maximum===null)return data.samples===null&&data.unit===null&&data.earliest===null&&data.latest===null&&data.topDate===null&&data.weekdays===null&&data.histogram.length===0;
  if(!count(data.samples)||data.samples>maximum||!Array.isArray(data.weekdays)||data.weekdays.length!==7||!data.weekdays.every(count)||data.weekdays.reduce((a,b)=>a+b,0)!==data.samples)return false;
  if(data.samples===0)return data.unit===null&&data.earliest===null&&data.latest===null&&data.topDate===null&&data.histogram.length===0;
  if(!propertyCalendarDay(data.earliest)||!propertyCalendarDay(data.latest)||Date.parse(data.earliest)>Date.parse(data.latest)||data.unit!==propertyDateUnit(data.earliest,data.latest)||!data.topDate||!propertyCalendarDay(data.topDate.date)||Date.parse(data.topDate.date)<Date.parse(data.earliest)||Date.parse(data.topDate.date)>Date.parse(data.latest)||!count(data.topDate.count)||data.topDate.count<1||data.topDate.count>data.samples)return false;
  let expected=propertyDateBucket(data.earliest,data.unit),total=0;
  for(const bucket of data.histogram){if(!bucket||bucket.date!==expected||!count(bucket.count)||bucket.count>data.samples)return false;total+=bucket.count;expected=propertyDateBucket(expected,data.unit,true);}
  if(total!==data.samples||data.histogram.at(-1)?.date!==propertyDateBucket(data.latest,data.unit)||data.histogram[0]?.count===0||data.histogram.at(-1)?.count===0)return false;
  if(data.unit==='day'){
    const top=data.histogram.reduce((best,bucket)=>bucket.count>=best.count?bucket:best),weekdays=Array<number>(7).fill(0);
    for(const bucket of data.histogram)weekdays[(new Date(bucket.date+'T00:00:00Z').getUTCDay()+6)%7]+=bucket.count;
    if(top.date!==data.topDate.date||top.count!==data.topDate.count||weekdays.some((n,i)=>n!==data.weekdays![i]))return false;
  }
  const topBucket=data.histogram.find(bucket=>bucket.date===propertyDateBucket(data.topDate!.date,data.unit!));
  return !!topBucket&&data.topDate.count<=topBucket.count&&data.topDate.count<=data.weekdays[(new Date(data.topDate.date+'T00:00:00Z').getUTCDay()+6)%7];
}
