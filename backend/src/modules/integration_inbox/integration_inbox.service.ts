import {createHmac,createHash,timingSafeEqual} from 'node:crypto';
import type {Response} from 'express';
import {getDbPool} from '../../core/database/pool';
import {getTenantContext} from '../../core/tenant/tenantContext';
import {requirePermission} from '../../core/permissions/policies';
import {AppError} from '../../core/errors/AppError';
import {registerConnectionBody,listQuery,webhookEnvelope} from './integration_inbox.schema';
import {type Db,listConnections,createConnection,listWebhooks,listInboundJobs,insertVerifiedReceipt} from './integration_inbox.repository';

export interface IntegrationDependencies{
 readonly connectionFactory?:()=>Promise<Db>;
 // Security boundary: a trusted server-side adapter resolves secrets by provider+company.
 readonly secretResolver?:(companyId:string,providerKey:string)=>Promise<string|null>;
}
export function createIntegrationService(deps:IntegrationDependencies={}){
 const connectionFactory=deps.connectionFactory??(()=>getDbPool().getConnection());
 async function read<T>(fn:(db:Db)=>Promise<T>){const db=await connectionFactory();try{return await fn(db);}finally{db.release();}}
 async function tx<T>(fn:(db:Db)=>Promise<T>){const db=await connectionFactory();let started=false,committing=false,destroy=false;
  try{await db.beginTransaction();started=true;const result=await fn(db);committing=true;await db.commit();committing=false;started=false;return result;}
  catch(e){if(committing)destroy=true;else if(started){try{await db.rollback();}catch{destroy=true;}}
   if(e&&typeof e==='object'&&'code' in e&&e.code==='ER_DUP_ENTRY')throw AppError.conflict();throw e;
  }finally{if(destroy)db.destroy();else db.release();}
 }
 function owner(res:Response,write=false){const t=getTenantContext(res);requirePermission(t,'leads.read');
  if(t.role!=='OWNER')throw AppError.forbidden();if(write&&t.accessMode!=='FULL')throw AppError.forbidden();return t;
 }
 return Object.freeze({
  connections:(res:Response,q:Record<string,unknown>)=>{const t=owner(res);const parsed=listQuery(q);return read(db=>listConnections(db,t,parsed));},
  register:(res:Response,body:unknown)=>{const t=owner(res,true);const parsed=registerConnectionBody(body);return tx(db=>createConnection(db,t,parsed));},
  events:(res:Response,q:Record<string,unknown>)=>{const t=owner(res);const parsed=listQuery(q);return read(db=>listWebhooks(db,t,parsed));},
  jobs:(res:Response,q:Record<string,unknown>)=>{const t=owner(res);const parsed=listQuery(q);if(parsed.providerKey!==null)throw AppError.badRequest();return read(db=>listInboundJobs(db,t,parsed));},
  // NOT AN HTTP ROUTE: caller is an authenticated platform/provider adapter, not browser input.
  receiveSigned:async(input:unknown)=>{
   if(!deps.secretResolver)throw AppError.forbidden();
   const x=webhookEnvelope(input);
   const secret=await deps.secretResolver(x.companyId,x.providerKey);
   if(typeof secret!=='string'||Buffer.byteLength(secret,'utf8')<32)throw AppError.forbidden();
   const expected=createHmac('sha256',secret).update(x.rawBody,'utf8').digest();
   const supplied=Buffer.from(x.signature.slice(7),'hex');
   if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))throw AppError.forbidden();
   const payloadHash=createHash('sha256').update(x.rawBody,'utf8').digest('hex');
   return tx(db=>insertVerifiedReceipt(db,{companyId:x.companyId,providerKey:x.providerKey,eventId:x.eventId,payloadHash}));
  }
 });
}