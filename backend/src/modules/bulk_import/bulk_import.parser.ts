import ExcelJS from 'exceljs';
import {AppError} from '../../core/errors/AppError';
import {id} from '../lead_import/lead_import.schema';
import type {BulkRequest} from './bulk_import.schema';

export interface BulkLeadRow {row:number;title:string;contactId:string;status:string;priority:string;sourceKey:string|null;description:string|null;}
const FIELDS=new Set(['title','contactId','status','priority','sourceKey','description']);
function safe(input:string|undefined,max:number,required:boolean){
 const text=(input??'').trim();
 if((required&&!text)||text.length>max||/[\x00-\x1f\x7f]/.test(text))throw AppError.badRequest();
 return text;
}
function csvRows(raw:string):string[][]{
 const src=raw.replace(/^\uFEFF/,'');const rows:string[][]=[];
 let row:string[]=[],value='',inQuotes=false,afterQuote=false;
 for(let i=0;i<src.length;i++){
  const c=src[i]!;
  if(inQuotes){if(c==='"'){if(src[i+1]==='"'){value+='"';i++;}else{inQuotes=false;afterQuote=true;}}else value+=c;continue;}
  if(afterQuote){if(c===','){row.push(value);value='';afterQuote=false;continue;}
   if(c==='\n'||c==='\r'){row.push(value);rows.push(row);row=[];value='';afterQuote=false;if(c==='\r'&&src[i+1]==='\n')i++;continue;}
   throw AppError.badRequest();}
  if(c==='"'){if(value)throw AppError.badRequest();inQuotes=true;}
  else if(c===','){row.push(value);value='';}
  else if(c==='\n'||c==='\r'){row.push(value);rows.push(row);row=[];value='';if(c==='\r'&&src[i+1]==='\n')i++;}
  else value+=c;
 }
 if(inQuotes)throw AppError.badRequest();
 if(row.length||value||afterQuote){row.push(value);rows.push(row);}
 return rows;
}
function xlCell(cell:ExcelJS.Cell):string{
 const v=cell.value;
 if(v===null||v===undefined)return '';
 if(typeof v==='string')return v;
 if(typeof v==='number'&&Number.isSafeInteger(v))return String(v);
 // Do not evaluate formulas, follow hyperlinks, or accept rich text as trusted data.
 throw AppError.badRequest();
}
function boundedZip(input:Buffer){
 // Reject encrypted, ZIP64, oversized, and decompression-bomb XLSX packages before ExcelJS inflates them.
 let end=-1;
 for(let n=input.length-22;n>=Math.max(0,input.length-65557);n--){if(input.readUInt32LE(n)===0x06054b50){end=n;break;}}
 if(end<0||input.readUInt16LE(end+4)!==0||input.readUInt16LE(end+6)!==0)throw AppError.badRequest();
 const entries=input.readUInt16LE(end+10),diskEntries=input.readUInt16LE(end+8);
 const directorySize=input.readUInt32LE(end+12),directoryStart=input.readUInt32LE(end+16);
 if(entries<1||entries>64||diskEntries!==entries||directoryStart+directorySize>end)throw AppError.badRequest();
 let pos=directoryStart,total=0;
 for(let n=0;n<entries;n++){
  if(pos+46>directoryStart+directorySize||input.readUInt32LE(pos)!==0x02014b50)throw AppError.badRequest();
  const flags=input.readUInt16LE(pos+8),packed=input.readUInt32LE(pos+20),expanded=input.readUInt32LE(pos+24);
  if(flags&1||packed===0xffffffff||expanded===0xffffffff||expanded>2_097_152)throw AppError.badRequest();
  total+=expanded;
  if(total>2_097_152)throw AppError.badRequest();
  pos+=46+input.readUInt16LE(pos+28)+input.readUInt16LE(pos+30)+input.readUInt16LE(pos+32);
 }
 if(pos!==directoryStart+directorySize)throw AppError.badRequest();
}
async function xlsxRows(raw:string):Promise<string[][]>{
 const input=Buffer.from(raw,'base64');
 if(input.length>49152||input.length<22||input[0]!==0x50||input[1]!==0x4b)throw AppError.badRequest();
 boundedZip(input);
 const book=new ExcelJS.Workbook();
 try{await book.xlsx.load(input as unknown as Parameters<typeof book.xlsx.load>[0]);}catch{throw AppError.badRequest();}
 if(book.worksheets.length!==1)throw AppError.badRequest();
 const ws=book.worksheets[0];
 if(!ws||ws.rowCount<2||ws.rowCount>501||ws.columnCount>8||ws.columnCount<3||ws.hasMerges)throw AppError.badRequest();
 const rows:string[][]=[];
 for(let n=1;n<=ws.rowCount;n++){
  const row=ws.getRow(n);
  const cells:string[]=[];
  for(let c=1;c<=ws.columnCount;c++)cells.push(xlCell(row.getCell(c)));
  rows.push(cells);
 }
 return rows;
}
export async function parseBulkRows(req:BulkRequest):Promise<BulkLeadRow[]>{
 const rows=req.format==='CSV'?csvRows(req.csv!):await xlsxRows(req.xlsxBase64!);
 if(rows.length<2||rows.length>501||!rows[0]||rows[0].length<3||rows[0].length>8||rows.some(r=>r.length!==rows[0]!.length))throw AppError.badRequest();
 const headers=rows[0].map(x=>safe(x,80,true));
 if(new Set(headers).size!==headers.length||Object.keys(req.mapping).some(k=>!headers.includes(k)))throw AppError.badRequest();
 const fields=headers.map(h=>req.mapping[h]??h);
 if(new Set(fields).size!==fields.length||fields.some(f=>!FIELDS.has(f))||!['title','contactId','status'].every(f=>fields.includes(f)))throw AppError.badRequest();
 const result:BulkLeadRow[]=[];
 for(let n=1;n<rows.length;n++){
  const obj:Record<string,string>=Object.create(null) as Record<string,string>;
  fields.forEach((field,i)=>{obj[field]=rows[n]![i]??'';});
  const title=safe(obj.title,200,true),contactId=id(safe(obj.contactId,20,true)),status=safe(obj.status,40,true);
  const priority=safe(obj.priority??'normal',20,true);
  const sourceKey=safe(obj.sourceKey??'',60,false)||null;
  const description=safe(obj.description??'',2000,false)||null;
  if(!/^[a-z][a-z0-9_]*$/.test(status)||!/^[a-z][a-z0-9_]*$/.test(priority)||(sourceKey!==null&&!/^[a-z][a-z0-9_]*$/.test(sourceKey)))throw AppError.badRequest();
  result.push({row:n+1,title,contactId,status,priority,sourceKey,description});
 }
 return result;
}