import type {VerifiedClerkSession} from './clerkJwt';
import {ClerkAuthenticationError} from './clerkJwt';

// Live session lookup is optional only for explicitly staged/offline testing.
// A production caller must configure a backend secret and treat failure as DENY.
export interface ClerkLiveSessionSettings {
 readonly secretKey: string;
 readonly fetchImpl?: typeof fetch;
 readonly timeoutMs?: number;
 readonly now?:()=>number;
}
export interface ActiveClerkSessionVerifier {
 check(session:VerifiedClerkSession):Promise<void>;
}

const liveKey=/^sk_(?:test|live)_[a-zA-Z0-9_+./=-]{10,}$/;
const validSession=/^sess_[a-zA-Z0-9_-]{1,123}$/;
const validUser=/^user_[a-zA-Z0-9_-]{1,123}$/;

export function createLiveClerkSessionVerifier(settings:ClerkLiveSessionSettings):ActiveClerkSessionVerifier {
 if(!liveKey.test(settings.secretKey))throw Error('CLERK_SESSION_BACKEND_SECRET_REQUIRED');
 const timeoutMs=settings.timeoutMs??3500;
 if(!Number.isInteger(timeoutMs)||timeoutMs<250||timeoutMs>10000)throw Error('INVALID_CLERK_SESSION_TIMEOUT');
 const doFetch=settings.fetchImpl??fetch;
 const now=settings.now??(()=>Date.now());
 return Object.freeze({
  async check(session:VerifiedClerkSession):Promise<void>{
   if(!validSession.test(session.sessionId)||!validUser.test(session.platformUserId))throw new ClerkAuthenticationError();
   try{
    const response=await doFetch(`https://api.clerk.com/v1/sessions/${encodeURIComponent(session.sessionId)}`,{
     method:'GET',
     headers:{Authorization:`Bearer ${settings.secretKey}`,Accept:'application/json'},
     signal:AbortSignal.timeout(timeoutMs),
     redirect:'error',
     cache:'no-store',
    });
    if(!response.ok)throw Error('CLERK_SESSION_REJECTED');
    const data:unknown=await response.json();
    if(!data||typeof data!=='object'||Array.isArray(data))throw Error('CLERK_SESSION_MALFORMED');
    const record=data as Record<string,unknown>;
    // Clerk's session API uses snake_case. Expire_at is epoch milliseconds.
    const expiry=record.expire_at;
    if(record.id!==session.sessionId||record.user_id!==session.platformUserId||
       record.status!=='active'||typeof expiry!=='number'||!Number.isFinite(expiry)||
       expiry<=now())throw Error('CLERK_SESSION_INACTIVE');
   }catch{throw new ClerkAuthenticationError();}
  }
 });
}