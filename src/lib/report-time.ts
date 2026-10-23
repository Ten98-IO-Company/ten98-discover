/** Formats an instant inside a report as `YYYY-MM-DD HH:MM <zone>` in the report's own time zone, never the browser's. */
export function formatReportInstant(iso:string,timeZone:string):string {
  const date=new Date(iso);
  if(Number.isNaN(date.getTime()))return iso;
  try {
    const p=Object.fromEntries(new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map(part=>[part.type,part.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${timeZone}`;
  } catch { return iso; }
}
