import type {PortfolioRecord} from './portfolio.repository';

function normal(value:unknown):string|null {
  if(value===null||value===undefined)return null;
  if(value instanceof Date)return value.toISOString();
  if(typeof value==='string'||typeof value==='number'||typeof value==='bigint')return String(value);
  if(typeof value==='boolean')return value?'true':'false';
  throw Error('EXPORT_UNSUPPORTED_VALUE');
}
function csvValue(value:unknown):string {
  // Separate rows always remain CSV data; never allow embedded newline/control characters.
  let s=(normal(value)??'').replace(/[\r\n\u0000-\u001F\u007F]/gu,' ');
  // Excel interprets =,+,-,@ as formulas even after leading whitespace or BOM.
  if(/^[\s\uFEFF]*[=+\-@]/u.test(s))s="'"+s;
  return '"'+s.replace(/"/g,'""')+'"';
}

export function portfolioBytes(
  rows:readonly PortfolioRecord[],columns:readonly string[],format:'CSV'|'JSON',hasMore:boolean,
):Buffer {
  const filtered=rows.map(row=>Object.fromEntries(columns.map(key=>[
    key,normal(row[key]),
  ])));
  if(format==='JSON')return Buffer.from(JSON.stringify({rows:filtered,hasMore}),'utf8');
  const csv=[columns.join(',')];
  for(const row of rows)csv.push(columns.map(key=>csvValue(row[key])).join(','));
  return Buffer.from('\uFEFF'+csv.join('\r\n')+'\r\n','utf8');
}