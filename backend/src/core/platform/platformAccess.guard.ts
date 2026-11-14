import type { RequestHandler } from 'express';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { getDbPool } from '../database/pool';
import { getTenantContext } from '../tenant/tenantContext';
import { AppError } from '../errors/AppError';

// This authorization guard runs AFTER the existing verified session and tenant resolver.
// It does not verify Clerk JWTs or accept company/user identity from HTTP headers.
// The platform's signed identity resolver remains a separate required integration.
interface AccessRow extends RowDataPacket {
 company_status:string;
 company_mode:string;
 entitlement_live:number;
 entitlement_fresh:number;
 user_role:string|null;
 user_status:string|null;
 activated:number;
 platform_identity:string|null;
}
type Db = Pick<PoolConnection,'execute'|'release'>;
export interface PlatformAccessDependencies {
 readonly connectionFactory?:()=>Promise<Db>;
 readonly requireFreshEntitlement?:boolean;
 readonly maxAgeSeconds?:number;
}
const recordId=/^[1-9][0-9]{0,19}$/;
const writable=new Set(['POST','PUT','PATCH','DELETE']);

export function createPlatformAccessGuard(deps:PlatformAccessDependencies={}):RequestHandler{
 const factory=deps.connectionFactory??(()=>getDbPool().getConnection());
 const requireFresh=deps.requireFreshEntitlement??(process.env.NODE_ENV==='production');
 const maxAge=deps.maxAgeSeconds??300;
 if(!Number.isSafeInteger(maxAge)||maxAge<30||maxAge>3600)throw Error('INVALID_PLATFORM_ENTITLEMENT_MAX_AGE');
 return async (req,res,next)=>{
  let db:Db|undefined;
  try{
   // TenantContext is supplied only by the trusted, pre-existing authentication middleware.
   const t=getTenantContext(res);
   if(!recordId.test(t.companyId)||!recordId.test(t.actorUserId)||
      !['OWNER','MANAGER','EMPLOYEE'].includes(t.role)||
      !['FULL','READ_ONLY'].includes(t.accessMode)||
      (('membershipStatus' in t) && (t as typeof t & {membershipStatus?:string}).membershipStatus!=='ACTIVE'))throw AppError.forbidden();
   db=await factory();
   const [rows]=await db.execute<AccessRow[]>(`
    SELECT c.status AS company_status,c.platform_access_mode AS company_mode,
      CASE WHEN c.platform_entitlement_expires_at IS NULL
         OR c.platform_entitlement_expires_at>UTC_TIMESTAMP(3) THEN 1 ELSE 0 END AS entitlement_live,
      CASE WHEN c.platform_checked_at IS NOT NULL
         AND TIMESTAMPDIFF(SECOND,c.platform_checked_at,UTC_TIMESTAMP(3)) BETWEEN -30 AND ?
        THEN 1 ELSE 0 END AS entitlement_fresh,
      u.role AS user_role,u.status AS user_status,
      CASE WHEN u.activated_at IS NOT NULL THEN 1 ELSE 0 END AS activated,
      u.platform_user_id AS platform_identity
    FROM companies c LEFT JOIN users u ON u.company_id=c.id AND u.id=?
    WHERE c.id=? LIMIT 1`,[maxAge,t.actorUserId,t.companyId]);
   const row=rows[0];
   if(!row||row.company_status!=='active'||
      !['FULL','READ_ONLY'].includes(row.company_mode)||
      !Number(row.entitlement_live)||
      (requireFresh&&!Number(row.entitlement_fresh))||
      row.user_status!=='active'||row.user_role!==t.role.toLowerCase()||
      !Number(row.activated)||!row.platform_identity?.trim())throw AppError.forbidden();
   // Prevent an older FULL session from bypassing newer platform READ_ONLY restrictions.
   if(writable.has(req.method.toUpperCase())&&
      (row.company_mode!=='FULL'||t.accessMode!=='FULL'))throw AppError.forbidden();
   next();
  }catch(error){next(error);}finally{db?.release();}
 };
}