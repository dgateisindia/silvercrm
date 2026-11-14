import type {PoolConnection,RowDataPacket} from 'mysql2/promise';
import {getDbPool} from '../database/pool';

// The caller MUST be a trusted, authenticated platform service adapter. Do not
// expose applyTrustedSnapshot to arbitrary HTTP requests or call it from a JWT claim.
export interface TrustedPlatformSnapshot {
 readonly platformOrgId:string;
 readonly version:string;
 readonly accessMode:'FULL'|'READ_ONLY'|'DENIED';
 readonly companyStatus:'active'|'suspended'|'provisioning'|'closed';
 readonly reason:string|null;
 readonly expiresAt:string|null;
}
export type PlatformSnapshotOutcome='applied'|'heartbeat'|'stale';
type Db=Pick<PoolConnection,'execute'|'beginTransaction'|'commit'|'rollback'|'release'|'destroy'>;
interface CompanyRow extends RowDataPacket{
 id:string|number|bigint;
 status:string;
 platform_access_mode:string;
 platform_entitlement_version:string|number|bigint;
 platform_access_reason:string|null;
 expires:string|null;
}
export interface PlatformSnapshotSettings {
 readonly connectionFactory:()=>Promise<Db>;
}
function asVersion(x:unknown):bigint{
 if(typeof x!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(x))throw Error('PLATFORM_SNAPSHOT_INVALID_VERSION');
 const v=BigInt(x);if(v>18446744073709551615n)throw Error('PLATFORM_SNAPSHOT_INVALID_VERSION');
 return v;
}
function expiryAsSql(x:unknown):string|null{
 if(x===null)return null;
 if(typeof x!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x)||!Number.isFinite(Date.parse(x))||new Date(x).toISOString()!==x)throw Error('PLATFORM_SNAPSHOT_INVALID_EXPIRY');
 return x.slice(0,19).replace('T',' ')+'.'+x.slice(20,23);
}
function validate(x:TrustedPlatformSnapshot){
 if(!x||typeof x!=='object'||!/^[-_a-zA-Z0-9]{2,128}$/.test(x.platformOrgId)||
    !['FULL','READ_ONLY','DENIED'].includes(x.accessMode)||
    !['active','suspended','provisioning','closed'].includes(x.companyStatus)||
    (x.companyStatus==='active'&&x.accessMode==='DENIED')||
    (x.reason!==null&&(typeof x.reason!=='string'||x.reason.length>40||!/^[a-zA-Z0-9_-]+$/.test(x.reason))))throw Error('PLATFORM_SNAPSHOT_INVALID');
 return {version:asVersion(x.version),expiresAt:expiryAsSql(x.expiresAt)};
}
export function createTrustedPlatformSnapshotApplier(settings:PlatformSnapshotSettings){
 return Object.freeze({
  async apply(x:TrustedPlatformSnapshot):Promise<{outcome:PlatformSnapshotOutcome;companyId:string;version:string}>{
   const parsed=validate(x);
   let db:Db|undefined;let started=false;
   try{
    db=await settings.connectionFactory();
    await db.beginTransaction();started=true;
    const [rows]=await db.execute<CompanyRow[]>(`
      SELECT id,status,platform_access_mode,platform_entitlement_version,platform_access_reason,
        DATE_FORMAT(platform_entitlement_expires_at,'%Y-%m-%d %H:%i:%s.%f') AS expires
      FROM companies WHERE platform_org_id=? LIMIT 1 FOR UPDATE`,[x.platformOrgId]);
    const row=rows[0];if(!row)throw Error('PLATFORM_SNAPSHOT_COMPANY_NOT_FOUND');
    const companyId=String(row.id);
    const existing=BigInt(String(row.platform_entitlement_version));
    let outcome:PlatformSnapshotOutcome='stale';
    if(parsed.version>existing){
     await db.execute(`UPDATE companies SET status=?,platform_access_mode=?,
       platform_entitlement_version=?,platform_access_reason=?,platform_entitlement_expires_at=?,
       platform_checked_at=UTC_TIMESTAMP(3) WHERE id=?`,[
      x.companyStatus,x.accessMode,x.version,x.reason,parsed.expiresAt,companyId]);
     outcome='applied';
    }else if(parsed.version===existing){
     // Same-version heartbeat is allowed only when the trusted payload is identical.
     const currentExpires=row.expires===null?null:String(row.expires).slice(0,23);
     if(row.status!==x.companyStatus||row.platform_access_mode!==x.accessMode||
         (row.platform_access_reason??null)!==(x.reason??null)||currentExpires!==parsed.expiresAt)
       throw Error('PLATFORM_SNAPSHOT_VERSION_CONFLICT');
     await db.execute(`UPDATE companies SET platform_checked_at=UTC_TIMESTAMP(3) WHERE id=?`,[companyId]);
     outcome='heartbeat';
    }
    if(outcome!=='stale')await db.execute(`INSERT INTO audit_logs
      (company_id,actor_user_id,action,entity_type,entity_id,outcome,request_id,details_json,occurred_at)
      VALUES(?,NULL,'platform.entitlement.sync','company',?,'success',NULL,?,UTC_TIMESTAMP(3))`,
      [companyId,companyId,JSON.stringify({version:x.version,mode:x.accessMode,status:x.companyStatus,outcome})]);
    await db.commit();started=false;
    return {outcome,companyId,version:existing>parsed.version?String(existing):x.version};
   }catch(error){
    if(db&&started){try{await db.rollback();}catch{db.destroy();}}
    throw error;
   }finally{db?.release();}
  }
 });
}

/** Trusted platform-worker entrypoint only; never mount as an unauthenticated HTTP route. */
export function createProductionPlatformSnapshotApplier(){
 return createTrustedPlatformSnapshotApplier({connectionFactory:()=>getDbPool().getConnection()});
}