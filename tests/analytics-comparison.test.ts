import assert from 'node:assert/strict';
import test from 'node:test';
import {analyticsQuery,analyticsRange} from '../src/server/analytics.ts';
import {deriveAnalyticsComparison} from '../src/lib/analytics-comparison.ts';

test('comparison is optional, closed and does not widen the shared current-range parser',()=>{
 assert.deepEqual(analyticsQuery(new URLSearchParams('from=2024-02-28&to=2024-02-29')).filters,{});assert.equal(Object.hasOwn(analyticsQuery(new URLSearchParams()),'compare'),false);
 for(const compare of ['prev','yoy'])assert.equal(analyticsQuery(new URLSearchParams({compare,browser:'chrome'})).compare,compare);
 for(const query of ['compare=','compare=custom','compare=previous','compare=prev&compare=yoy','compare=prev%0a','compare=yoy&baselineFrom=2024-01-01'])assert.throws(()=>analyticsQuery(new URLSearchParams(query)),{status:400});
 assert.throws(()=>analyticsRange(new URLSearchParams('from=2025-02-28&to=2026-02-28&compare=yoy')),{status:400});assert.throws(()=>analyticsRange(new URLSearchParams('from=2024-02-28&to=2025-02-28')),{status:400});
});
test('previous period is the preceding equal N whole UTC days with no boundary overlap',()=>{
 for(const [from,to,expectedFrom,expectedTo,days] of [['2026-03-29','2026-03-29','2026-03-28','2026-03-28',1],['2024-02-28','2024-03-01','2024-02-25','2024-02-27',3],['2024-01-01','2024-12-31','2022-12-31','2023-12-31',366]] as const){const value=deriveAnalyticsComparison({from,to},'prev')!;assert.equal(value.range.from,expectedFrom);assert.equal(value.range.to,expectedTo);assert.equal(value.range.end,from+'T00:00:00.000Z');assert.equal(value.alignment.currentDays,days);assert.equal(value.alignment.comparisonDays,days);assert.equal(value.alignment.overlapDays,0);}
});
test('year comparison clamps inclusive calendar endpoints and preserves every leap-year day/overlap',()=>{
 for(const [from,to,baseFrom,baseTo,currentDays,previousDays,overlap] of [['2024-02-29','2024-02-29','2023-02-28','2023-02-28',1,1,0],['2024-02-28','2024-02-28','2023-02-28','2023-02-28',1,1,0],['2024-02-28','2024-02-29','2023-02-28','2023-02-28',2,1,0],['2024-01-01','2024-12-31','2023-01-01','2023-12-31',366,365,0],['2025-02-28','2026-02-28','2024-02-28','2025-02-28',366,367,1]] as const){const value=deriveAnalyticsComparison({from,to},'yoy')!;assert.equal(value.range.from,baseFrom);assert.equal(value.range.to,baseTo);assert.equal(value.alignment.currentDays,currentDays);assert.equal(value.alignment.comparisonDays,previousDays);assert.equal(value.alignment.slots,Math.max(currentDays,previousDays));assert.equal(value.alignment.overlapDays,overlap);assert.equal((Date.parse(value.range.end)-Date.parse(value.range.start))/86400000,previousDays);}
});
test('a derived range before1970 is explicit invalid intent, never a fallback/shortened baseline',()=>{
 for(const mode of ['prev','yoy'] as const)assert.equal(deriveAnalyticsComparison({from:'1970-01-01',to:'1970-01-02'},mode),null);
 assert.equal(deriveAnalyticsComparison({from:'1971-01-01',to:'1971-01-01'},'yoy')?.range.from,'1970-01-01');for(const current of [{from:'2025-02-29',to:'2025-03-01'},{from:'2024-02-28',to:'2025-02-28'},{from:'2026-01-02',to:'2026-01-01'},{from:'9999-01-01',to:'9999-01-01'}])assert.equal(deriveAnalyticsComparison(current,'prev'),null);
});
