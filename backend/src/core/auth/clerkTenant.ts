import type {PoolConnection,RowDataPacket} from 'mysql2/promise';
import type {VerifiedClerkSession} from './clerkJwt';
import {ClerkAuthenticationError} from './clerkJwt';
import type {TenantContext} from '../tenant/tenantContext';

// Treat only the Clerk-signed subject as an identity hint. All CRM memberships and
// permissions are resolved from live, server-owned database state on every request.
export class ClerkMembershipError extends Error {
 readonly statusCode=403;
 constructor(){super('CRM_PLATFORM_MEMBERSHIP_DENIED');this.name='ClerkMembershipError';}
}
type Db=Pick<PoolConnection,'execute'|'release'>;
interface MembershipRow extends RowDataPacket {
 company_id:string|number|bigint;
 actor_user_id:string|number|bigint;
 platform_org_id:string;
 company_status:string;
 company_mode:string;
 entitlement_live:number;
 entitlement_fresh:number;
 user_status:string;
 user_role:string;
 activated:number;
}
export interface ClerkTenantSettings {
 readonly connectionFactory:()=>Promise<Db>;
 readonly requireFreshEntitlement?:boolean;
 readonly maxAgeSeconds?:number;
 readonly requireOrganizationMatch?:boolean;
}
function decimalId(id:unknown):string{
 const v=String(id);
 if(!/^[1-9][0-9]{0,19}$/.test(v)||BigInt(v)>18446744073709551615n)throw new ClerkMembershipError();
 return v;
}
export function createClerkTenantResolver(settings:ClerkTenantSettings){
 const maxAge=settings.maxAgeSeconds??300;
 if(!Number.isSafeInteger(maxAge)||maxAge<30||maxAge>3600)throw Error('INVALID_PLATFORM_FRESHNESS_POLICY');
 const requireFresh=settings.requireFreshEntitlement??(process.env.NODE_ENV==='production');
 return Object.freeze({
  async resolve(session:VerifiedClerkSession):Promise<TenantContext>{
   if(!session.platformUserId.startsWith('user_'))throw new ClerkAuthenticationError();
   if(settings.requireOrganizationMatch&&!session.organizationId)throw new ClerkMembershipError();
   let db:Db|undefined;
   try{
    db=await settings.connectionFactory();
    const [rows]=await db.execute<MembershipRow[]>(`
     SELECT c.id AS company_id,u.id AS actor_user_id,c.platform_org_id,
      c.status AS company_status,c.platform_access_mode AS company_mode,
      CASE WHEN c.platform_entitlement_expires_at IS NULL OR
        c.platform_entitlement_expires_at>UTC_TIMESTAMP(3) THEN 1 ELSE 0 END AS entitlement_live,
      CASE WHEN c.platform_checked_at IS NOT NULL AND
        TIMESTAMPDIFF(SECOND,c.platform_checked_at,UTC_TIMESTAMP(3)) BETWEEN -30 AND ?
        THEN 1 ELSE 0 END AS entitlement_fresh,
      u.status AS user_status,u.role AS user_role,
      CASE WHEN u.activated_at IS NOT NULL THEN 1 ELSE 0 END AS activated
     FROM users u INNER JOIN companies c ON c.id=u.company_id
     WHERE u.platform_user_id=?
       AND (?=0 OR c.platform_org_id=?) LIMIT 2`,
     [maxAge,session.platformUserId,settings.requireOrganizationMatch?1:0,session.organizationId??'']);
    if(rows.length!==1)throw new ClerkMembershipError();
    const r=rows[0];
    if(!r||r.company_status!=='active'||r.user_status!=='active'||!Number(r.activated)||
       !['owner','manager','employee'].includes(r.user_role)||
       !['FULL','READ_ONLY'].includes(r.company_mode)||!Number(r.entitlement_live)||
       (requireFresh&&!Number(r.entitlement_fresh)))throw new ClerkMembershipError();
    const role=r.user_role.toUpperCase() as TenantContext['role'];
    const accessMode=r.company_mode as TenantContext['accessMode'];
    return Object.freeze({
     companyId:decimalId(r.company_id),actorUserId:decimalId(r.actor_user_id),
     role,accessMode,membershipStatus:'ACTIVE' as const,
    });
   }finally{db?.release();}
  }
 });
}