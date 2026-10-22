import assert from 'node:assert/strict';
import test from 'node:test';
import type {ChartSeries} from '@ten98/ui';
import {chartSeriesLimit,foldChartSeries} from '../src/lib/chart-series.ts';

const row=(id:string,values:(number|null)[],partial=-1):ChartSeries=>({id,label:id,points:values.map((y,x)=>({x,xLabel:'d'+x,y,state:y===null?'unavailable':x===partial?'partial':'observed'}))});

test('series within the shared style limit pass through unchanged',()=>{
  const series=Array.from({length:chartSeriesLimit},(_,i)=>row('s'+i,[i]));
  assert.deepEqual(foldChartSeries(series,'Other'),series);
});

test('later series fold into one Other series that keeps unavailable and partial points distinct from zero',()=>{
  const series=[row('a',[1,1,1]),row('b',[2,2,2]),row('c',[3,3,3]),row('d',[4,4,4]),row('e',[5,0,5],2),row('f',[6,0,null]),row('g',[-1,0,1])];
  const folded=foldChartSeries(series,'Other events');
  assert.equal(folded.length,chartSeriesLimit);
  assert.deepEqual(folded.slice(0,4),series.slice(0,4));
  const other=folded[4];
  assert.equal(other.label,'Other events (3)');
  assert.deepEqual(other.points.map(point=>point.y),[10,0,null]);
  assert.deepEqual(other.points.map(point=>point.state),['observed','observed','unavailable']);
  assert.match(other.points[0].note!,/Combines e, f, g\./);
  const partial=foldChartSeries([...series.slice(0,6),row('g',[1,1,1],1)],'Other');
  assert.equal(partial[4].points[1].state,'partial');
});
