import { AppError } from '../../../core/errors/AppError';
import { id, obj, scaled } from '../../sales/schemas/sales.schema';
import { email, phone } from '../../customers/schemas/customer.schema';

function clean(raw: unknown, max: number): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > max || /[\x00-\x08\x0B\x0E-\x1F\x7F]/.test(raw)) throw AppError.badRequest();
  return raw.trim();
}
function optionalText(raw: unknown, max: number): string|null {
  if (raw === undefined || raw === null || raw === '') return null;
  return clean(raw, max);
}
function amount(raw: unknown): string {
  if (typeof raw !== 'string' || !/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/.test(raw)) throw AppError.badRequest();
  if (scaled(raw,2) > 999999999999999999n) throw AppError.badRequest();
  return raw;
}
function date(raw:unknown):string|null {
  if(raw===undefined||raw===null)return null;
  if(typeof raw!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(raw))throw AppError.badRequest();
  const parsed=new Date(`${raw}T00:00:00.000Z`);
  if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==raw)throw AppError.badRequest();
  return raw;
}
export function conversionBody(raw: unknown) {
  const v=obj(raw,['expectedRevision','contact','account','deal']);
  if(typeof v.expectedRevision!=='string'||!/^[0-9]{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}$/.test(v.expectedRevision))throw AppError.badRequest();
  const c=obj(v.contact,['mode','contactId','firstName','lastName','email','phone']);
  let contact:{mode:'existing';contactId:string}|{mode:'new';firstName:string;lastName:string|null;email:string|null;phone:string|null};
  if(c.mode==='existing'){
    if(Object.keys(c).some(x=>!['mode','contactId'].includes(x)))throw AppError.badRequest();
    contact={mode:'existing',contactId:id(c.contactId)};
  }else if(c.mode==='new'){
    if(Object.keys(c).some(x=>!['mode','firstName','lastName','email','phone'].includes(x)))throw AppError.badRequest();
    const e=email(c.email),p=phone(c.phone);
    if(!e&&!p)throw AppError.badRequest();
    contact={mode:'new',firstName:clean(c.firstName,120),lastName:optionalText(c.lastName,120),email:e,phone:p};
  }else throw AppError.badRequest();
  let account:{mode:'existing';accountId:string}|{mode:'new';name:string;email:string|null;phone:string|null}|null=null;
  if(v.account!==undefined && v.account!==null){
    const a=obj(v.account,['mode','accountId','name','email','phone']);
    if(a.mode==='existing'){
      if(Object.keys(a).some(x=>!['mode','accountId'].includes(x)))throw AppError.badRequest();
      account={mode:'existing',accountId:id(a.accountId)};
    }else if(a.mode==='new'){
      if(Object.keys(a).some(x=>!['mode','name','email','phone'].includes(x)))throw AppError.badRequest();
      account={mode:'new',name:clean(a.name,200),email:email(a.email),phone:phone(a.phone)};
    }else throw AppError.badRequest();
  }
  let deal:{pipelineId:string;stageId:string;amount:string;expectedCloseDate:string|null}|null=null;
  if(v.deal!==undefined && v.deal!==null){
    const d=obj(v.deal,['pipelineId','stageId','amount','expectedCloseDate']);
    deal={pipelineId:id(d.pipelineId),stageId:id(d.stageId),amount:amount(d.amount),expectedCloseDate:date(d.expectedCloseDate)};
  }
  return {expectedRevision:v.expectedRevision,contact,account,deal};
}
export function negotiationBody(raw:unknown){
  const v=obj(raw,['note','proposedAmount','quotationId']);
  const note=clean(v.note,2000);
  const proposedAmount=v.proposedAmount===undefined||v.proposedAmount===null?null:amount(v.proposedAmount);
  const quotationId=v.quotationId===undefined||v.quotationId===null?null:id(v.quotationId);
  return {note,proposedAmount,quotationId};
}
export function pagination(raw:unknown):number{
  if(raw===undefined)return 30;
  if(typeof raw!=='string'|| !/^[1-9]\d{0,2}$/.test(raw) ||Number(raw)>100)throw AppError.badRequest();
  return Number(raw);
}