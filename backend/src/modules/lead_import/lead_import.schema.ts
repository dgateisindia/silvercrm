import {AppError} from '../../core/errors/AppError';

export function id(value:unknown):string{
 if(typeof value==='string'&&/^[1-9][0-9]{0,19}$/.test(value)&&BigInt(value)<=18446744073709551615n)return value;
 if(typeof value==='number'&&Number.isSafeInteger(value)&&value>0)return String(value);
 throw AppError.badRequest();
}
export function exact(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw AppError.badRequest();
 const obj=value as Record<string,unknown>;
 if(Object.keys(obj).some(k=>!keys.includes(k)))throw AppError.badRequest();
 return obj;
}
export function queryLimit(input:Record<string,unknown>){
 if(Object.keys(input).some(k=>k!=='limit'))throw AppError.badRequest();
 if(input.limit===undefined)return 50;
 if(typeof input.limit!=='string'||!/^[1-9][0-9]{0,2}$/.test(input.limit))throw AppError.badRequest();
 const n=Number(input.limit);if(n>100)throw AppError.badRequest();return n;
}
export type ImportStrategy='SKIP'|'REJECT';
export interface LeadImportPayload{
 readonly csv:string;
 readonly mapping:Record<string,string>;
 readonly duplicateStrategy:ImportStrategy;
 readonly ownerUserId:string|null;
 readonly idempotencyKey:string|null;
}
export function parseImport(input:unknown,commit:boolean):LeadImportPayload{
 const x=exact(input,['csv','mapping','duplicateStrategy','ownerUserId','idempotencyKey']);
 if(typeof x.csv!=='string'||!x.csv.trim()||Buffer.byteLength(x.csv,'utf8')>65536)throw AppError.badRequest();
 // The unknown header keys are verified against the parsed CSV before use.
 if(x.mapping!==undefined && (!x.mapping||typeof x.mapping!=='object'||Array.isArray(x.mapping)||![Object.prototype,null].includes(Object.getPrototypeOf(x.mapping))))throw AppError.badRequest();
 const source=x.mapping===undefined?{}:x.mapping as Record<string,unknown>;
 if(Object.keys(source).length>8||Object.keys(source).some(k=>k.length>80||['__proto__','prototype','constructor'].includes(k))||Object.values(source).some(v=>typeof v!=='string'||v.length>50))throw AppError.badRequest();
 const mapping:Record<string,string>=Object.create(null) as Record<string,string>;for(const [k,v] of Object.entries(source))mapping[k]=v as string;
 if(x.duplicateStrategy!=='SKIP'&&x.duplicateStrategy!=='REJECT')throw AppError.badRequest();
 const ownerUserId=x.ownerUserId===undefined?null:id(x.ownerUserId);
 const key=x.idempotencyKey===undefined?null:x.idempotencyKey;
 if(commit && (typeof key!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(key)))throw AppError.badRequest();
 if(!commit && key!==null && (typeof key!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(key)))throw AppError.badRequest();
 return {csv:x.csv,mapping,duplicateStrategy:x.duplicateStrategy,ownerUserId,idempotencyKey:key as string|null};
}