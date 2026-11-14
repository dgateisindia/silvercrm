import { AppError } from '../../../core/errors/AppError';
import { id as salesId } from '../../sales/schemas/sales.schema';

export function id(raw:unknown):string { return salesId(raw); }
export function limit(raw:unknown):number {
 if(raw===undefined)return 50;
 if(typeof raw!=='string'|| !/^[1-9][0-9]{0,2}$/.test(raw))throw AppError.badRequest();
 const value=Number(raw);if(value>100)throw AppError.badRequest();return value;
}
function object(raw:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!raw||typeof raw!=='object'||Array.isArray(raw) || ![Object.prototype,null].includes(Object.getPrototypeOf(raw)))throw AppError.badRequest();
 const v=raw as Record<string,unknown>;
 if(Object.keys(v).some(k=>!keys.includes(k)))throw AppError.badRequest();
 return v;
}
export function strict(raw:unknown,keys:readonly string[]){return object(raw,keys);}
function word(raw:unknown,max:number,required:boolean):string|null {
 if(raw===null && !required)return null;
 if(typeof raw!=='string')throw AppError.badRequest();
 const val=raw.trim();if((required&&!val)||val.length>max || /[\u0000-\u001F\u007F]/.test(val))throw AppError.badRequest();
 return val || (required? (()=>{throw AppError.badRequest();})():null);
}
function nullableString(v:unknown,max:number){return word(v,max,false);}
export function email(raw:unknown):string|null{
 if(raw===null||raw===undefined||raw==='')return null;
 if(typeof raw!=='string')throw AppError.badRequest();
 const v=raw.trim().toLowerCase();
 if(v.length>254||!/^[^\s@]{1,64}@[^\s@]{1,185}\.[a-zA-Z]{2,24}$/.test(v))throw AppError.badRequest();
 return v;
}
export function phone(raw:unknown):string|null {
 if(raw===null||raw===undefined||raw==='')return null;
 if(typeof raw!=='string')throw AppError.badRequest();
 const v=raw.trim();
 if(!/^\+?[0-9]{7,15}$/.test(v))throw AppError.badRequest();return v;
}
export function accountBody(raw:unknown){
 const v=object(raw,['name','email','phone','website']);
 const name=word(v.name,200,true)!;
 const e=email(v.email),p=phone(v.phone);
 const website=v.website===undefined||v.website===null?null:nullableString(v.website,255);
 if(website && !/^https:\/\/[a-z0-9.-]+(?::[0-9]{2,5})?(?:\/[\x21-\x7E]*)?$/i.test(website))throw AppError.badRequest();
 return {name,email:e,phone:p,website};
}
export function contactBody(raw:unknown){
 const v=object(raw,['firstName','lastName','email','phone','accountId','marketingOptIn']);
 const firstName=word(v.firstName,120,true)!;
 const lastName=v.lastName===undefined||v.lastName===null?null:word(v.lastName,120,false);
 const e=email(v.email),p=phone(v.phone);
 if(!e&&!p)throw AppError.badRequest();
 if(v.marketingOptIn!==undefined&&typeof v.marketingOptIn!=='boolean')throw AppError.badRequest();
 const accountId=v.accountId===undefined||v.accountId===null?null:id(v.accountId);
 return {firstName,lastName,email:e,phone:p,accountId,marketingOptIn:v.marketingOptIn===true};
}
export function accountPatch(raw:unknown){
 const v=object(raw,['expectedRevision','changes']);
 if(typeof v.expectedRevision!=='string'|| !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}$/.test(v.expectedRevision))throw AppError.badRequest();
 const changes=object(v.changes,['name','email','phone','website']);
 if(!Object.keys(changes).length)throw AppError.badRequest();
 const output:Record<string,string|null>={};
 if('name' in changes)output.name=word(changes.name,200,true);
 if('email' in changes)output.email=email(changes.email);
 if('phone' in changes)output.phone=phone(changes.phone);
 if('website' in changes){const w=nullableString(changes.website,255);if(w&&!/^https:\/\/[a-z0-9.-]+(?::[0-9]{2,5})?(?:\/[\x21-\x7E]*)?$/i.test(w))throw AppError.badRequest();output.website=w;}
 return {expectedRevision:v.expectedRevision,changes:output};
}
export function contactPatch(raw:unknown){
 const v=object(raw,['expectedRevision','changes']);
 if(typeof v.expectedRevision!=='string'|| !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}$/.test(v.expectedRevision))throw AppError.badRequest();
 const c=object(v.changes,['firstName','lastName','email','phone','accountId','marketingOptIn']);
 if(!Object.keys(c).length)throw AppError.badRequest();
 const out:Record<string,string|boolean|null>={};
 if('firstName' in c)out.firstName=word(c.firstName,120,true);
 if('lastName' in c)out.lastName=word(c.lastName,120,false);
 if('email' in c)out.email=email(c.email);
 if('phone' in c)out.phone=phone(c.phone);
 if('accountId' in c)out.accountId=c.accountId===null?null:id(c.accountId);
 if('marketingOptIn' in c){if(typeof c.marketingOptIn!=='boolean')throw AppError.badRequest();out.marketingOptIn=c.marketingOptIn;}
 return {expectedRevision:v.expectedRevision,changes:out};
}
export function activityBody(raw:unknown){
 const v=object(raw,['type','summary']);
 if(!['note','call','meeting'].includes(String(v.type)))throw AppError.badRequest();
 return {type:v.type as 'note'|'call'|'meeting',summary:word(v.summary,500,true)!};
}
export function duplicatesQuery(raw:Record<string,unknown>){
 if(Object.keys(raw).some(k=>!['email','phone','limit'].includes(k)))throw AppError.badRequest();
 const e=email(raw.email),p=phone(raw.phone);if(!e&&!p)throw AppError.badRequest();
 return {email:e,phone:p,limit:limit(raw.limit)};
}
export function importBody(raw:unknown,commit:boolean){
 const v=object(raw,['csv','mapping','duplicateStrategy','idempotencyKey']);
 if(typeof v.csv!=='string'||v.csv.length>64000||v.csv.length<5)throw AppError.badRequest();
 if(!['SKIP','REJECT'].includes(String(v.duplicateStrategy)))throw AppError.badRequest();
 const rawMapping=v.mapping===undefined?{}:v.mapping as Record<string,unknown>;
 if(v.mapping!==undefined){
  if(!v.mapping||typeof v.mapping!=='object'||Array.isArray(v.mapping) ||![Object.prototype,null].includes(Object.getPrototypeOf(v.mapping)))throw AppError.badRequest();
 }
 const entries=Object.entries(rawMapping);
 if(entries.length>7||entries.some(([k,val])=>k.length<1||k.length>80||typeof val!=='string'||!['firstName','lastName','email','phone','accountId','marketingOptIn'].includes(val)))throw AppError.badRequest();
 if(new Set(entries.map(([,val])=>val)).size!==entries.length)throw AppError.badRequest();
 let idempotencyKey:string|null=null;
 if(commit){
  if(typeof v.idempotencyKey!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,119}$/.test(v.idempotencyKey))throw AppError.badRequest();
  idempotencyKey=v.idempotencyKey;
 }else if(v.idempotencyKey!==undefined){throw AppError.badRequest();}
 return {csv:v.csv,duplicateStrategy:v.duplicateStrategy as 'SKIP'|'REJECT',mapping:Object.fromEntries(entries) as Record<string,string>,idempotencyKey};
}