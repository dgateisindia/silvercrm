import {AppError} from '../../core/errors/AppError';
import {id} from './lead_import.schema';
export interface LeadCsvRow{row:number;title:string;contactId:string;status:string;priority:string;sourceKey:string|null;description:string|null;}
const FIELDS=['title','contactId','status','priority','sourceKey','description'];
function parseCsv(raw:string){
 const source=raw.replace(/^\uFEFF/,'');
 const rows:string[][]=[];let row:string[]=[],cell='',inside=false,finishedQuote=false;
 for(let i=0;i<source.length;i++){
  const c=source[i];
  if(inside){if(c==='"'){if(source[i+1]==='"'){cell+='"';i++;}else{inside=false;finishedQuote=true;}}else cell+=c;continue;}
  if(finishedQuote){if(c===','){row.push(cell);cell='';finishedQuote=false;continue;}
   if(c==='\r'||c==='\n'){row.push(cell);rows.push(row);row=[];cell='';finishedQuote=false;if(c==='\r'&&source[i+1]==='\n')i++;continue;}throw AppError.badRequest();}
  if(c==='"'){if(cell!=='')throw AppError.badRequest();inside=true;}
  else if(c===','){row.push(cell);cell='';}
  else if(c==='\n'||c==='\r'){row.push(cell);rows.push(row);row=[];cell='';if(c==='\r'&&source[i+1]==='\n')i++;}
  else cell+=c;
 }
 if(inside)throw AppError.badRequest();
 if(row.length||cell||finishedQuote){row.push(cell);rows.push(row);}
 if(rows.length<2||rows.length>101||rows.some(r=>r.length!==rows[0]!.length))throw AppError.badRequest();
 if(rows[0]!.length>8)throw AppError.badRequest();
 return rows;
}
function safe(value:string,max:number,required:boolean){
 const v=value.trim();if((required&&!v)||v.length>max||/[\x00-\x1f\x7f]/.test(v))throw AppError.badRequest();return v;
}
export function parseLeadCsv(raw:string,mapping:Record<string,string>):LeadCsvRow[]{
 const rows=parseCsv(raw);const headers=rows[0]!.map(h=>safe(h,80,true));
 if(new Set(headers).size!==headers.length||Object.keys(mapping).some(k=>!headers.includes(k)))throw AppError.badRequest();
 const mapped=headers.map(h=>mapping[h]??h);
 if(mapped.some(h=>!FIELDS.includes(h))||new Set(mapped).size!==mapped.length)throw AppError.badRequest();
 if(!mapped.includes('title')||!mapped.includes('contactId')||!mapped.includes('status'))throw AppError.badRequest();
 const data:LeadCsvRow[]=[];
 for(let row=1;row<rows.length;row++){
  const obj=Object.fromEntries(mapped.map((k,i)=>[k,rows[row]![i]!]));
  const title=safe(obj.title??'',200,true);
  const contactId=id(safe(obj.contactId??'',20,true));
  const status=safe(obj.status??'',40,true);
  const priority=safe(obj.priority??'normal',20,true);
  const sourceKey=safe(obj.sourceKey??'',60,false)||null;
  const description=safe(obj.description??'',2000,false)||null;
  if(!/^[a-z][a-z0-9_]*$/.test(status)||!/^[a-z][a-z0-9_]*$/.test(priority)||
     (sourceKey!==null&&!/^[a-z][a-z0-9_]*$/.test(sourceKey)))throw AppError.badRequest();
  data.push({row:row+1,title,contactId,status,priority,sourceKey,description});
 }
 return data;
}