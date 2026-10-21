import type {ChartPoint,ChartSeries} from '@ten98/ui';

// ponytail: @ten98/ui 0.14.0 has five distinct series styles (colour, dash, marker), so a sixth series would look like the
// first. Later series are summed into one "Other" series; tables keep every series. Drop this when the library offers more.
export const chartSeriesLimit=5;

export function foldChartSeries(series:readonly ChartSeries[],otherLabel:string):ChartSeries[]{
  if(series.length<=chartSeriesLimit)return [...series];
  const kept=series.slice(0,chartSeriesLimit-1),folded=series.slice(chartSeriesLimit-1),names=folded.map(row=>row.label).join(', ');
  const points=folded[0].points.map((first,index):ChartPoint=>{
    const parts=folded.map(row=>row.points[index]),gone=parts.some(point=>!point||point.y===null||point.state==='unavailable');
    return {x:first.x,xLabel:first.xLabel,y:gone?null:parts.reduce((sum,point)=>sum+(point.y as number),0),state:gone?'unavailable':parts.some(point=>point.state==='partial')?'partial':'observed',note:`${gone?'Unavailable: a combined series has no value. ':''}Combines ${names}.`};
  });
  return [...kept,{id:'other-series',label:`${otherLabel} (${folded.length})`,points}];
}
