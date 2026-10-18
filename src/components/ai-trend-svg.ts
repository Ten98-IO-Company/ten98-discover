/** Shared geometry and the standalone light-theme file for the AI insights daily trend (viewBox 0 0 600 180, 0-100% on y 170-10). */
export const trendY = (value: number) => 170 - value * 1.6;
export const percentText = (value: number | null) => value === null ? 'Unavailable' : value.toFixed(1).replace(/\.0$/, '') + '%';

// XML 1.0 forbids these code points; everything else is entity-escaped so workspace labels stay text.
const escape = (text: string) => text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[character]!);
const n = (value: number) => value.toFixed(2);

/** Inline presentation attributes only (light tokens from design-tokens.css): no script, link, style sheet or foreign content. */
export function trendSvg({title, desc, points}: {title: string; desc: string; points: {x: number; value: number | null; date: string}[]}): string {
  const plotted = points.filter(point => Number.isFinite(point.x)).map(point => ({...point, value: point.value !== null && Number.isFinite(point.value) ? point.value : null}));
  const segments: typeof plotted[] = []; let segment: typeof plotted = [];
  for (const point of plotted) { if (point.value === null) segment = []; else { if (!segment.length) segments.push(segment); segment.push(point); } }
  const text = (x: number, y: number, anchor: string, label: string) => `<text x="${n(x)}" y="${n(y)}" text-anchor="${anchor}" font-family="sans-serif" font-size="10" fill="#696374">${escape(label)}</text>`;
  const first = plotted[0]?.date, last = plotted.length > 1 ? plotted.at(-1)!.date : undefined;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 180" width="600" height="180" role="img">`,
    `<title>${escape(title)}</title><desc>${escape(desc)}</desc>`,
    `<rect x="0" y="0" width="600" height="180" fill="#FFFFFF"/>`,
    ...[10, 90, 170].map(y => `<line x1="0" x2="600" y1="${y}" y2="${y}" stroke="#EAEAF1" stroke-width="1"/>`),
    ...plotted.filter(point => point.value === null).map(point => `<line x1="${n(point.x)}" x2="${n(point.x)}" y1="10" y2="170" stroke="#696374" stroke-dasharray="2 4" opacity="0.6"><title>${escape(point.date)}: Unavailable</title></line>`),
    ...segments.filter(run => run.length > 1).map(run => `<polyline fill="none" stroke="#5943CE" stroke-width="2" points="${run.map(point => `${n(point.x)},${n(trendY(point.value!))}`).join(' ')}"/>`),
    ...plotted.filter(point => point.value !== null).map(point => `<circle cx="${n(point.x)}" cy="${n(trendY(point.value!))}" r="3" fill="#5943CE" stroke="#FFFFFF" stroke-width="1"><title>${escape(point.date)}: ${percentText(point.value)}</title></circle>`),
    text(2, 21, 'start', '100%'), text(2, 86, 'start', '50%'), text(2, 166, 'start', '0%'),
    ...first === undefined ? [] : [text(4, 179, 'start', first)], ...last === undefined ? [] : [text(596, 179, 'end', last)],
    `</svg>`,
  ].join('\n') + '\n';
}
