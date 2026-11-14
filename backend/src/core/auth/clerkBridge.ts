import {createClerkJwtVerifier,type ClerkJwtSettings} from './clerkJwt';
import {createClerkTenantResolver,type ClerkTenantSettings} from './clerkTenant';

/**
 * Trusted adapter for a future production session-verifier/identity-resolver hookup.
 * Do not mount this as a second authentication system after existing session auth:
 * replace the upstream production auth source only after its contract is audited.
 */
export function createClerkPlatformBridge(settings:ClerkJwtSettings&ClerkTenantSettings){
 const verifier=createClerkJwtVerifier(settings);
 const tenants=createClerkTenantResolver(settings);
 return Object.freeze({
  async authenticate(authorization:unknown){
   const session=verifier.verifyBearer(authorization);
   const tenant=await tenants.resolve(session);
   return Object.freeze({session,tenant});
  },
 });
}

export function configuredClerkJwtSettings():ClerkJwtSettings{
 const issuer=process.env.CRM_CLERK_ISSUER_URL??'';
 const publicKeyPem=process.env.CRM_CLERK_JWT_PUBLIC_KEY??'';
 const authorizedParties=(process.env.CRM_CLERK_AUTHORIZED_PARTIES??'').split(',').map(x=>x.trim()).filter(Boolean);
 // Configuration is mandatory and no production fallback to a local dev secret is allowed.
 if(!issuer||!publicKeyPem||!authorizedParties.length)throw Error('CLERK_CONFIGURATION_INCOMPLETE');
 return Object.freeze({issuer,publicKeyPem,authorizedParties,
  audience:process.env.CRM_CLERK_AUDIENCE||undefined,
  requireAzp:process.env.CRM_CLERK_REQUIRE_AZP==='true',
 });
}