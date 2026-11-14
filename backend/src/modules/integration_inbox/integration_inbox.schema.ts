import {AppError} from '../../core/errors/AppError';

export function id(value:unknown):string{
 if(typeof value==='number'&&Number.isSafeInteger(value)&&value>0)return String(value);
 if(typeof value==='bigint'&&value>0n&&value<=18446744073709551615n)return String(value);
 if(typeof value==='string'&&/^[1-9][0-9]{0,19}$/.test(value)&&BigInt(value)<=18446744073709551615n)return value;
 throw AppError.badRequest();
}
export function strict(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw AppError.badRequest();
 const item=value as Record<string,unknown>;
 if(Object.keys(item).some(key=>!keys.includes(key)))throw AppError.badRequest();
 return item;
}
function word(value:unknown,limit:number){
 if(typeof value!=='string'||!value.trim()||value.trim().length>limit||/[\x00-\x1f\x7f]/.test(value))throw AppError.badRequest();
 return value.trim();
}
export function providerKey(value:unknown){
 const key=word(value,90);
 if(!/^[a-z][a-z0-9_-]{1,89}$/.test(key))throw AppError.badRequest();
 return key;
}
export function eventId(value:unknown){
 const key=word(value,180);
 if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(key))throw AppError.badRequest();
 return key;
}
export function registerConnectionBody(value:unknown){
 const v=strict(value,['providerKey','displayName']);
 return {providerKey:providerKey(v.providerKey),displayName:word(v.displayName,140)};
}
export function listQuery(q:Record<string,unknown>){
 if(Object.keys(q).some(key=>!['limit','providerKey'].includes(key)))throw AppError.badRequest();
 const limit=q.limit===undefined?50:Number(q.limit);
 if(q.limit!==undefined&&(typeof q.limit!=='string'||!/^[1-9][0-9]{0,2}$/.test(q.limit)))throw AppError.badRequest();
 if(!Number.isInteger(limit)||limit<1||limit>100)throw AppError.badRequest();
 const key=q.providerKey===undefined?null:providerKey(q.providerKey);
 return {limit,providerKey:key};
}
export function webhookEnvelope(value:unknown){
 const x=strict(value,['companyId','providerKey','eventId','signature','rawBody']);
 const companyId=id(x.companyId);
 const key=providerKey(x.providerKey);
 const event=eventId(x.eventId);
 if(typeof x.signature!=='string'||!/^sha256=[a-fA-F0-9]{64}$/.test(x.signature))throw AppError.badRequest();
 if(typeof x.rawBody!=='string'||!x.rawBody||Buffer.byteLength(x.rawBody,'utf8')>65536)throw AppError.badRequest();
 try{const value=JSON.parse(x.rawBody);if(value===null||typeof value!=='object'||Array.isArray(value))throw Error('bad JSON shape');}catch{throw AppError.badRequest();}
 return {companyId,providerKey:key,eventId:event,signature:x.signature.toLowerCase(),rawBody:x.rawBody};
}