import {AppError} from '../../core/errors/AppError';
import {id,exact} from '../lead_import/lead_import.schema';

export type BulkFormat='CSV'|'XLSX';
export interface BulkRequest{
 readonly format:BulkFormat;
 readonly csv:string|null;
 readonly xlsxBase64:string|null;
 readonly mapping:Record<string,string>;
 readonly duplicateStrategy:'SKIP';
 readonly ownerUserId:string|null;
 readonly idempotencyKey:string|null;
}
const keyPattern=/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
export function parseBulkRequest(input:unknown,commit:boolean):BulkRequest{
 const obj=exact(input,['format','csv','xlsxBase64','mapping','duplicateStrategy','ownerUserId','idempotencyKey']);
 if(obj.format!=='CSV'&&obj.format!=='XLSX')throw AppError.badRequest();
 const format=obj.format as BulkFormat;
 const csv=format==='CSV'?obj.csv:null;
 const xlsx=format==='XLSX'?obj.xlsxBase64:null;
 if(format==='CSV'){
  if(typeof csv!=='string'||!csv.trim()||Buffer.byteLength(csv,'utf8')>65536||obj.xlsxBase64!==undefined)throw AppError.badRequest();
 }else{
  if(typeof xlsx!=='string'||xlsx.length<20||xlsx.length>65536||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(xlsx)||obj.csv!==undefined)throw AppError.badRequest();
 }
 if(obj.duplicateStrategy!=='SKIP')throw AppError.badRequest(); // Atomic REJECT is not supported for asynchronously committed chunks.
 if(obj.mapping!==undefined&&(!obj.mapping||typeof obj.mapping!=='object'||Array.isArray(obj.mapping)||![Object.prototype,null].includes(Object.getPrototypeOf(obj.mapping))))throw AppError.badRequest();
 const source=(obj.mapping??{}) as Record<string,unknown>;
 if(Object.keys(source).length>8||Object.keys(source).some(k=>k.length>80||['__proto__','constructor','prototype'].includes(k))||Object.values(source).some(v=>typeof v!=='string'||v.length>50))throw AppError.badRequest();
 const mapping:Record<string,string>=Object.create(null) as Record<string,string>;
 for(const [k,v] of Object.entries(source))mapping[k]=v as string;
 const ownerUserId=obj.ownerUserId===undefined?null:id(obj.ownerUserId);
 const idempotencyKey=obj.idempotencyKey===undefined?null:obj.idempotencyKey;
 if(commit&&(typeof idempotencyKey!=='string'||!keyPattern.test(idempotencyKey)))throw AppError.badRequest();
 if(!commit&&idempotencyKey!==null&&(typeof idempotencyKey!=='string'||!keyPattern.test(idempotencyKey)))throw AppError.badRequest();
 return {format,csv:csv as string|null,xlsxBase64:xlsx as string|null,mapping,duplicateStrategy:'SKIP',ownerUserId,idempotencyKey:idempotencyKey as string|null};
}
export function parseJobId(value:unknown):string{return id(value);}