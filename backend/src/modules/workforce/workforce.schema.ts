import {AppError} from '../../core/errors/AppError';

export function id(raw:unknown):string {
 if(typeof raw==='bigint'&&raw>0n)return String(raw);
 if(typeof raw==='number'&&Number.isSafeInteger(raw)&&raw>0)return String(raw);
 if(typeof raw==='string'&&/^[1-9][0-9]{0,19}$/.test(raw)&&BigInt(raw)<=18446744073709551615n)return raw;
 throw AppError.badRequest();
}
function record(raw:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||![Object.prototype,null].includes(Object.getPrototypeOf(raw)))throw AppError.badRequest();
 const val=raw as Record<string,unknown>;
 if(Object.keys(val).some(k=>!keys.includes(k)))throw AppError.badRequest();
 return val;
}
function string(raw:unknown,max:number):string{
 if(typeof raw!=='string'||!raw.trim()||raw.trim().length>max)throw AppError.badRequest();
 return raw.trim();
}
export function utc(raw:unknown):string {
 if(typeof raw!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(raw))throw AppError.badRequest();
 const d=new Date(raw);
 if(!Number.isFinite(d.getTime()))throw AppError.badRequest();
 const normalized=d.toISOString();
 if(normalized!==new Date(normalized).toISOString()||
    (raw.length===20?normalized.slice(0,19)+'Z'!==raw:normalized!==raw))throw AppError.badRequest();
 return normalized.slice(0,23).replace('T',' ');
}
function span(from:unknown,to:unknown,maxDays:number):{start:string;end:string}{
 const start=utc(from),end=utc(to);
 const delta=Date.parse(end+'Z')-Date.parse(start+'Z');
 if(delta<=0||delta>maxDays*86400000)throw AppError.badRequest();
 return {start,end};
}
export function eventInput(raw:unknown){
 const a=record(raw,['title','organizerUserId','leadId','contactId','startsAt','endsAt']);
 for(const k of ['title','startsAt','endsAt'])if(a[k]===undefined)throw AppError.badRequest();
 const time=span(a.startsAt,a.endsAt,2);
 return {title:string(a.title,200),organizerUserId:a.organizerUserId===undefined?null:id(a.organizerUserId),
   leadId:a.leadId===undefined?null:id(a.leadId),contactId:a.contactId===undefined?null:id(a.contactId),...time};
}
export function absenceInput(raw:unknown){
 const a=record(raw,['userId','startsAt','endsAt','reason']);
 for(const k of ['startsAt','endsAt'])if(a[k]===undefined)throw AppError.badRequest();
 const time=span(a.startsAt,a.endsAt,90);
 if(a.reason!==undefined&&(typeof a.reason!=='string'||a.reason.trim().length>250))throw AppError.badRequest();
 return {userId:a.userId===undefined?null:id(a.userId),reason:a.reason===undefined?null:(a.reason as string).trim()||null,...time};
}
export function coverageInput(raw:unknown){
 const a=record(raw,['leadId','absenceId','coverUserId','startsAt','endsAt']);
 for(const k of ['leadId','absenceId','coverUserId','startsAt','endsAt'])if(a[k]===undefined)throw AppError.badRequest();
 return {leadId:id(a.leadId),absenceId:id(a.absenceId),coverUserId:id(a.coverUserId),...span(a.startsAt,a.endsAt,90)};
}
export function rangeQuery(raw:Record<string,unknown>){
 if(Object.keys(raw).some(k=>!['from','to','limit'].includes(k)))throw AppError.badRequest();
 const limit=raw.limit===undefined?50:Number(raw.limit);
 if(raw.limit!==undefined&&(typeof raw.limit!=='string'||!/^[1-9][0-9]{0,2}$/.test(raw.limit)))throw AppError.badRequest();
 if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw AppError.badRequest();
 if((raw.from===undefined)!==(raw.to===undefined))throw AppError.badRequest();
 let from:string|null=null,to:string|null=null;
 if(raw.from!==undefined){const v=span(raw.from,raw.to,366);from=v.start;to=v.end;}
 return {from,to,limit};
}