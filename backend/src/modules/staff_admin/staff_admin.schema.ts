import {AppError} from '../../core/errors/AppError';

export function id(v:unknown):string{
 if(typeof v==='bigint'&&v>0n&&v<=18446744073709551615n)return String(v);
 if(typeof v==='number'&&Number.isSafeInteger(v)&&v>0)return String(v);
 if(typeof v==='string'&&/^[1-9][0-9]{0,19}$/.test(v)&&BigInt(v)<=18446744073709551615n)return v;
 throw AppError.badRequest();
}
export function strict(v:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!v||typeof v!=='object'||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))throw AppError.badRequest();
 const x=v as Record<string,unknown>;
 if(Object.keys(x).some(k=>!keys.includes(k)))throw AppError.badRequest();
 return x;
}
function word(v:unknown,max:number):string{
 if(typeof v!=='string'||!v.trim()||v.trim().length>max||/[\x00-\x1f\x7f]/.test(v))throw AppError.badRequest();
 return v.trim();
}
export function teamCreate(v:unknown){
 const x=strict(v,['name','managerUserId']);
 return {name:word(x.name,140),managerUserId:id(x.managerUserId)};
}
export function teamChange(v:unknown){
 const x=strict(v,['managerUserId']);
 return {managerUserId:id(x.managerUserId)};
}
export function membershipBody(v:unknown){
 const x=strict(v,['userId']);return {userId:id(x.userId)};
}
export function statusBody(v:unknown){
 const x=strict(v,['status','expectedRevision']);
 if(x.status!=='active'&&x.status!=='inactive')throw AppError.badRequest();
 if(typeof x.expectedRevision!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}$/.test(x.expectedRevision))throw AppError.badRequest();
 return {status:x.status as 'active'|'inactive',expectedRevision:x.expectedRevision};
}
export function invitePreview(v:unknown){
 const x=strict(v,['email','fullName','role','teamId']);
 const fullName=word(x.fullName,180);
 const email=word(x.email,254).toLowerCase();
 if(!/^[^\s@]{1,64}@[^\s@]{1,185}\.[a-z]{2,24}$/.test(email))throw AppError.badRequest();
 if(x.role!=='manager'&&x.role!=='employee')throw AppError.badRequest();
 const teamId=x.teamId===undefined?null:id(x.teamId);
 return {fullName,email,role:x.role as 'manager'|'employee',teamId};
}
export function listQuery(q:Record<string,unknown>){
 if(Object.keys(q).some(k=>k!=='limit'))throw AppError.badRequest();
 const limit=q.limit===undefined?50:Number(q.limit);
 if(q.limit!==undefined&&(typeof q.limit!=='string'||!/^[1-9][0-9]{0,2}$/.test(q.limit)))throw AppError.badRequest();
 if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw AppError.badRequest();
 return limit;
}