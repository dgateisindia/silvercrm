import type {ClerkJwtSettings} from './clerkJwt';
import type {ClerkTenantSettings} from './clerkTenant';
import {createClerkPlatformBridge,configuredClerkJwtSettings} from './clerkBridge';
import {createLiveClerkSessionVerifier,type ClerkLiveSessionSettings} from './clerkLiveSession';
import {getDbPool} from '../database/pool';

// Production-oriented composition: verify pinned Clerk JWT, validate company/user
// against live CRM SQL, THEN inspect the current Clerk session through Backend API.
// No other CRM HTTP source should run alongside it in production.
export type ClerkRuntimeSettings=ClerkJwtSettings & ClerkTenantSettings & ClerkLiveSessionSettings;
export function createClerkRuntime(settings:ClerkRuntimeSettings){
 const bridge=createClerkPlatformBridge(settings);
 const sessions=createLiveClerkSessionVerifier(settings);
 return Object.freeze({
  async authenticate(authorization:unknown){
   const result=await bridge.authenticate(authorization);
   await sessions.check(result.session);
   return result;
  }
 });
}
export function configuredClerkRuntimeCredentials(){
 const jwt=configuredClerkJwtSettings();
 const key=process.env.CRM_CLERK_BACKEND_SECRET_KEY??'';
 if(!key)throw Error('CLERK_SESSION_BACKEND_SECRET_REQUIRED');
 return Object.freeze({...jwt,secretKey:key,requireFreshEntitlement:true,
  requireOrganizationMatch:process.env.CRM_CLERK_REQUIRE_ORG==='true'});
}

/** Production factory. Does not run until explicitly invoked by an audited auth bootstrap. */
export function createProductionClerkRuntime(){
 return createClerkRuntime({...configuredClerkRuntimeCredentials(),connectionFactory:()=>getDbPool().getConnection()});
}