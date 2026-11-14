import {createPublicKey, verify as verifySignature, type KeyObject} from 'node:crypto';

// This is intentionally a networkless, pinned-PEM verifier. It never calls an arbitrary
// token-supplied JWKS URL, accepts no unsigned token, and does not trust role claims.
export class ClerkAuthenticationError extends Error {
 readonly statusCode=401;
 constructor(){super('CLERK_SESSION_NOT_AUTHENTICATED');this.name='ClerkAuthenticationError';}
}
export interface ClerkJwtSettings {
 readonly issuer:string;
 readonly publicKeyPem:string;
 readonly authorizedParties:readonly string[];
 readonly audience?:string;
 readonly requireAzp?:boolean;
 readonly now?:()=>number;
 readonly maxLifetimeSeconds?:number;
}
export interface VerifiedClerkSession {
 readonly platformUserId:string;
 readonly sessionId:string;
 readonly issuer:string;
 readonly organizationId:string|null;
 readonly expiresAt:number;
}
function decodePart(part:string):Record<string,unknown>{
 if(!/^[a-zA-Z0-9_-]{2,8192}$/.test(part))throw new ClerkAuthenticationError();
 let content:string;
 try{
  const bytes=Buffer.from(part,'base64url');
  if(bytes.toString('base64url')!==part)throw new Error('NON_CANONICAL');
  content=bytes.toString('utf8');
  const value:unknown=JSON.parse(content);
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)throw new Error('INVALID_JSON');
  return value as Record<string,unknown>;
 }catch{throw new ClerkAuthenticationError();}
}
function validId(value:unknown,prefix:string):value is string{
 return typeof value==='string' && value.startsWith(prefix) && value.length<=128 && /^[a-zA-Z0-9_-]+$/.test(value);
}
function intTime(value:unknown):value is number{return typeof value==='number'&&Number.isSafeInteger(value)&&value>0;}
export function createClerkJwtVerifier(settings:ClerkJwtSettings){
 if(!/^https:\/\/[^/?#\s]+$/.test(settings.issuer)||
    !settings.publicKeyPem.trim()||!Array.isArray(settings.authorizedParties)||
    settings.authorizedParties.length===0||settings.authorizedParties.some(x=>!/^https:\/\/[^/?#\s]+$/.test(x))||
    (settings.audience!==undefined&&!settings.audience.trim()))throw Error('CLERK_CONFIGURATION_INCOMPLETE');
 const maxLifetime=settings.maxLifetimeSeconds??3600;
 if(!Number.isSafeInteger(maxLifetime)||maxLifetime<60||maxLifetime>86400)throw Error('CLERK_LIFETIME_POLICY_INVALID');
 let key:KeyObject;
 try{key=createPublicKey(settings.publicKeyPem.replace(/\\n/g,'\n'));}
 catch{throw Error('CLERK_PUBLIC_KEY_INVALID');}
 if(key.asymmetricKeyType!=='rsa')throw Error('CLERK_PUBLIC_KEY_NOT_RSA');
 const parties=new Set(settings.authorizedParties);
 const now=settings.now??(()=>Math.floor(Date.now()/1000));
 return Object.freeze({
  verifyBearer(authorization:unknown):VerifiedClerkSession{
   if(typeof authorization!=='string'||authorization.length>10000||!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization))throw new ClerkAuthenticationError();
   const token=authorization.slice(7);
   const parts=token.split('.');if(parts.length!==3)throw new ClerkAuthenticationError();
   const [head,payloadPart,sig]=parts;
   if(!head||!payloadPart||!sig)throw new ClerkAuthenticationError();
   const header=decodePart(head),claims=decodePart(payloadPart);
   if(header.alg!=='RS256'||(header.typ!==undefined&&header.typ!=='JWT')||
      'crit' in header||'jku' in header||'jwk' in header||'x5u' in header||'x5c' in header)throw new ClerkAuthenticationError();
   let passed=false;
   try{passed=verifySignature('RSA-SHA256',Buffer.from(`${head}.${payloadPart}`),key,Buffer.from(sig,'base64url'));}
   catch{passed=false;}
   if(!passed)throw new ClerkAuthenticationError();
   const current=now();
   if(!Number.isSafeInteger(current)||!intTime(claims.exp)||!intTime(claims.iat)||
      (claims.nbf!==undefined&&!intTime(claims.nbf))||
      claims.iss!==settings.issuer||!validId(claims.sub,'user_')||!validId(claims.sid,'sess_')||
      claims.sts==='pending'||claims.exp<=current-5||claims.iat>current+5||
      (typeof claims.nbf==='number'&&claims.nbf>current+5)||claims.exp<=claims.iat||
      claims.exp-claims.iat>maxLifetime)throw new ClerkAuthenticationError();
   if(claims.azp===undefined){if(settings.requireAzp)throw new ClerkAuthenticationError();}
   else if(typeof claims.azp!=='string'||!parties.has(claims.azp))throw new ClerkAuthenticationError();
   if(settings.audience!==undefined){
    const aud=claims.aud;
    if(typeof aud==='string'?aud!==settings.audience:!Array.isArray(aud)||!aud.includes(settings.audience))throw new ClerkAuthenticationError();
   }
   const org=claims.org_id;
   if(org!==undefined&&org!==null&&!validId(org,'org_'))throw new ClerkAuthenticationError();
   return Object.freeze({
    platformUserId:claims.sub,
    sessionId:claims.sid,
    issuer:settings.issuer,
    organizationId:(org??null) as string|null,
    expiresAt:claims.exp,
   });
  },
 });
}