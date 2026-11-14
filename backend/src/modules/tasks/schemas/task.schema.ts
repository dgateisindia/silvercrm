import {AppError} from '../../../core/errors/AppError';

export function taskId(value:unknown):string {
 if(typeof value==='bigint'&&value>0n&&value<=18446744073709551615n)return String(value);
 if(typeof value==='number'&&Number.isSafeInteger(value)&&value>0)return String(value);
 if(typeof value==='string'&&/^[1-9][0-9]{0,19}$/.test(value)&&BigInt(value)<=18446744073709551615n)return value;
 throw AppError.badRequest();
}
function object(value:unknown,allowed:readonly string[]):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value)||
   ![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw AppError.badRequest();
 const data=value as Record<string,unknown>;
 if(Object.keys(data).some(key=>!allowed.includes(key)))throw AppError.badRequest();
 return data;
}
function text(value:unknown,max:number):string {
 if(typeof value!=='string'||!value.trim()||value.trim().length>max||/[\u0000-\u001f\u007f]/u.test(value))throw AppError.badRequest();
 return value.trim();
}
function description(value:unknown):string|null {
 if(value===null)return null;
 if(typeof value!=='string'||value.length>4000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))throw AppError.badRequest();
 return value.trim()||null;
}
function priority(value:unknown):'low'|'normal'|'high'|'urgent' {
 if(value!=='low'&&value!=='normal'&&value!=='high'&&value!=='urgent')throw AppError.badRequest();
 return value;
}
function timestamp(value:unknown):string|null {
 if(value===null)return null;
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))throw AppError.badRequest();
 const parsed=new Date(value);
 if(!Number.isFinite(parsed.getTime())||parsed.toISOString()!==value)throw AppError.badRequest();
 return value.slice(0,23).replace('T',' ');
}
function revision(value:unknown):string {
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value))throw AppError.badRequest();
 return value;
}
export function createTaskBody(value:unknown) {
 const data=object(value,['title','description','ownerUserId','dueAt','priority','dealId','contactId']);
 return {
  title:text(data.title,200),
  description:data.description===undefined?null:description(data.description),
  ownerUserId:data.ownerUserId===undefined?null:taskId(data.ownerUserId),
  dueAt:data.dueAt===undefined?null:timestamp(data.dueAt),
  priority:data.priority===undefined?'normal' as const:priority(data.priority),
  dealId:data.dealId===undefined||data.dealId===null?null:taskId(data.dealId),
  contactId:data.contactId===undefined||data.contactId===null?null:taskId(data.contactId),
 };
}
export function patchTaskBody(value:unknown){
 const data=object(value,['title','description','dueAt','priority','expectedRevision']);
 const keys=['title','description','dueAt','priority'].filter(k=>Object.prototype.hasOwnProperty.call(data,k));
 if(keys.length===0)throw AppError.badRequest();
 return {
  expectedRevision:revision(data.expectedRevision),
  title:data.title===undefined?undefined:text(data.title,200),
  description:data.description===undefined?undefined:description(data.description),
  dueAt:data.dueAt===undefined?undefined:timestamp(data.dueAt),
  priority:data.priority===undefined?undefined:priority(data.priority),
 };
}
export function completeTaskBody(value:unknown){
 const data=object(value,['expectedRevision']);
 return {expectedRevision:revision(data.expectedRevision)};
}
export function taskListQuery(value:Record<string,unknown>){
 const data=object(value,['limit','status']);
 const raw=data.limit===undefined?'50':data.limit;
 if(typeof raw!=='string'||!/^[1-9]\d{0,2}$/.test(raw))throw AppError.badRequest();
 const limit=Number(raw);
 if(limit<1||limit>100)throw AppError.badRequest();
 const status=data.status===undefined?'all':data.status;
 if(status!=='all'&&status!=='open'&&status!=='completed')throw AppError.badRequest();
 return {limit,status:status as 'all'|'open'|'completed'};
}
export function noQuery(value:Record<string,unknown>):void {
 if(Object.keys(value).length)throw AppError.badRequest();
}
