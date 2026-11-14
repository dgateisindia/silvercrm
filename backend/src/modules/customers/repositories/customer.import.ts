import type {RowDataPacket} from 'mysql2/promise';
import {AppError} from '../../../core/errors/AppError';
import type {TenantContext} from '../../../core/tenant/tenantContext';
import {email,phone,id} from '../schemas/customer.schema';
import type {Db} from '../repositories/customer.repository';
import {companyLock,duplicateContactExists,createContact,sha256,writeImportJob} from '../repositories/customer.repository';

const FIELDS=['firstName','lastName','email','phone','accountId','marketingOptIn'] as const;
type Field=typeof FIELDS[number];
type Parsed={firstName:string;lastName:string|null;email:string|null;phone:string|null;accountId:string|null;marketingOptIn:boolean};
interface CellRow {index:number;data:Parsed}
function parseCsv(raw:string):string[][]{
 // Strict CSV parser: RFC4180 double quoting, BOM, CRLF; no permissive broken quotes.
 const text=raw.replace(/^\uFEFF/,'');
 if(text.length>64000||!text.length)throw AppError.badRequest();
 const rows:string[][]=[];let row:string[]=[],cell='',quoted=false,afterQuote=false;
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(quoted){
   if(c==='"'){
    if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;afterQuote=true;}
   }else cell+=c;
   continue;
  }
  if(afterQuote){
   if(c===','){row.push(cell);cell='';afterQuote=false;continue;}
   if(c==='\n'||c==='\r'){row.push(cell);rows.push(row);row=[];cell='';afterQuote=false;if(c==='\r'&&text[i+1]==='\n')i++;continue;}
   throw AppError.badRequest();
  }
  if(c==='"'){
   if(cell!=='')throw AppError.badRequest();
   quoted=true;
  }else if(c===','){row.push(cell);cell='';}
  else if(c==='\n'||c==='\r'){
   row.push(cell);rows.push(row);row=[];cell='';if(c==='\r'&&text[i+1]==='\n')i++;
  }else cell+=c;
 }
 if(quoted)throw AppError.badRequest();
 if(row.length||cell||afterQuote){row.push(cell);rows.push(row);}
 if(rows.length<2||rows.length>101)throw AppError.badRequest();
 if(rows.some(r=>r.length!==rows[0]!.length))throw AppError.badRequest();
 return rows;
}
function nonempty(v:string,max:number){const result=v.trim();if(!result||result.length>max||/[\u0000-\u001f\u007f]/.test(result))throw AppError.badRequest();return result;}
function optional(v:string,max:number){const result=v.trim();if(result.length>max||/[\u0000-\u001f\u007f]/.test(result))throw AppError.badRequest();return result||null;}
export function parseContactCsv(csv:string,mapping:Record<string,string>):CellRow[]{
 const rows=parseCsv(csv);const header=rows[0]!.map(x=>x.trim());
 if(header.some(x=>!x||x.length>80)||new Set(header).size!==header.length)throw AppError.badRequest();
 const columns=header.map(h=>mapping[h]??h);
 if(columns.some(c=>!FIELDS.includes(c as Field))||new Set(columns).size!==columns.length)throw AppError.badRequest();
 if(!columns.includes('firstName')||(!columns.includes('email')&&!columns.includes('phone')))throw AppError.badRequest();
 if(Object.keys(mapping).some(key=>!header.includes(key)))throw AppError.badRequest();
 const parsed:CellRow[]=[];
 for(let ri=1;ri<rows.length;ri++){
  const values=Object.fromEntries(columns.map((k,i)=>[k,rows[ri]![i]!]));
  const firstName=nonempty(values.firstName!,120);
  const lastName=values.lastName===undefined?null:optional(values.lastName,120);
  const e=email(values.email),p=phone(values.phone);
  if(!e&&!p)throw AppError.badRequest();
  const accountId=values.accountId? id(values.accountId.trim()):null;
  const rawOpt=values.marketingOptIn?.trim().toLowerCase();
  if(rawOpt && !['true','false','1','0'].includes(rawOpt))throw AppError.badRequest();
  parsed.push({index:ri+1,data:{firstName,lastName,email:e,phone:p,accountId,marketingOptIn:rawOpt==='true'||rawOpt==='1'}});
 }
 return parsed;
}
export async function runImport(db:Db,t:TenantContext,raw:ReturnType<typeof import('../schemas/customer.schema').importBody>,rid:string|null,commit:boolean){
 const rows=parseContactCsv(raw.csv,raw.mapping);
 // Serializing all company customer imports/creates prevents cross-request duplicate races.
 if(commit)await companyLock(db,t);
 const seenEmails=new Set<string>(),seenPhones=new Set<string>();
 let created=0,duplicates=0;
 const rowOut:{row:number;outcome:'created'|'duplicate'}[]=[];
 for(const row of rows){
  const v=row.data;
  const sameFile=(v.email!==null&&seenEmails.has(v.email))||(v.phone!==null&&seenPhones.has(v.phone));
  if(v.email!==null)seenEmails.add(v.email);
  if(v.phone!==null)seenPhones.add(v.phone);
  let dup=sameFile;
  if(v.accountId!==null){
   // For any linked account, use the normal contact creation access check.
   const [a]=await db.execute<RowDataPacket[]>(`SELECT id,owner_user_id FROM accounts WHERE company_id=? AND id=? LIMIT 1`,[t.companyId,v.accountId]);
   if(!a[0])throw AppError.notFound();
   const owner=String(a[0].owner_user_id??'');
   if(t.role==='EMPLOYEE' && owner!==t.actorUserId)throw AppError.notFound();
   if(t.role==='MANAGER'&&owner!==t.actorUserId){
    const [m]=await db.execute<RowDataPacket[]>(`SELECT tm.id FROM team_members tm JOIN teams te ON te.company_id=tm.company_id AND te.id=tm.team_id WHERE tm.company_id=? AND tm.user_id=? AND tm.left_at IS NULL AND tm.joined_at<=UTC_TIMESTAMP(3) AND te.manager_user_id=? AND te.status='active' LIMIT 1`,[t.companyId,owner,t.actorUserId]);
    if(!m.length)throw AppError.notFound();
   }
  }
  dup=dup || await duplicateContactExists(db,t,v.email,v.phone,null);
  if(dup){duplicates++;rowOut.push({row:row.index,outcome:'duplicate'});if(raw.duplicateStrategy==='REJECT')throw AppError.conflict();continue;}
  created++;rowOut.push({row:row.index,outcome:'created'});
  if(commit)await createContact(db,t,v,rid);
 }
 if(!commit)return {validationOnly:true,totalRows:rows.length,expectedCreated:created,expectedDuplicates:duplicates,rows:rowOut};
 const importId=await writeImportJob(db,t,sha256(raw.csv),raw.duplicateStrategy,raw.mapping,raw.idempotencyKey!,rows.length,created,duplicates,rid);
 return {id:importId,validationOnly:false,totalRows:rows.length,created,skippedDuplicates:duplicates,rows:rowOut};
}
export async function ensureImportKeyUnused(db:Db,t:TenantContext,key:string){
 const [rows]=await db.execute<RowDataPacket[]>(`SELECT id FROM import_jobs WHERE company_id=? AND idempotency_key=? LIMIT 1`,[t.companyId,key]);
 if(rows.length)throw AppError.conflict();
}