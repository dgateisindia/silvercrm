import {createHash} from 'node:crypto';
import {AppError} from '../../core/errors/AppError';

export type ReminderKind='due'|'escalation';
export interface ReminderPayload {readonly taskId:string;readonly recipientUserId:string;readonly dueAt:string;readonly kind:ReminderKind;}
export const DUE_JOB='crm.followup.due';
export const ESCALATION_JOB='crm.followup.escalation';
export const MAX_ATTEMPTS=5;
export function identifier(raw:unknown):string{
 if(typeof raw==='bigint'&&raw>0n)return String(raw);
 if(typeof raw==='number'&&Number.isSafeInteger(raw)&&raw>0)return String(raw);
 if(typeof raw==='string'&&/^[1-9][0-9]{0,19}$/.test(raw)&&BigInt(raw)<=18446744073709551615n)return raw;
 throw AppError.badRequest();
}
export function parsePayload(raw:unknown):ReminderPayload{
 let item:unknown=raw;
 if(typeof raw==='string'){
  try{item=JSON.parse(raw);}catch{throw Error('INVALID_REMINDER_PAYLOAD');}
 }
 if(!item||typeof item!=='object'||Array.isArray(item))throw Error('INVALID_REMINDER_PAYLOAD');
 const obj=item as Record<string,unknown>;
 if(Object.keys(obj).length!==4||Object.keys(obj).some(k=>!['taskId','recipientUserId','dueAt','kind'].includes(k)))throw Error('INVALID_REMINDER_PAYLOAD');
 try{identifier(obj.taskId);identifier(obj.recipientUserId);}catch{throw Error('INVALID_REMINDER_PAYLOAD');}
 if(typeof obj.dueAt!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}$/.test(obj.dueAt))throw Error('INVALID_REMINDER_PAYLOAD');
 if(obj.kind!=='due'&&obj.kind!=='escalation')throw Error('INVALID_REMINDER_PAYLOAD');
 return {taskId:obj.taskId as string,recipientUserId:obj.recipientUserId as string,dueAt:obj.dueAt,kind:obj.kind};
}
export function reminderKey(companyId:string,payload:ReminderPayload):string{
 return createHash('sha256').update([companyId,payload.taskId,payload.dueAt,payload.recipientUserId,payload.kind].join('|')).digest('hex');
}
export function jobLimit(raw:unknown):number{
 if(raw===undefined)return 25;
 if(typeof raw!=='string'||!/^[1-9][0-9]{0,2}$/.test(raw)||Number(raw)>100)throw AppError.badRequest();
 return Number(raw);
}