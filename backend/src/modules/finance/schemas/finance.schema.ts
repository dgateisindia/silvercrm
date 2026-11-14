import { AppError } from "../../../core/errors/AppError";
import { id, obj, scaled, decimal } from "../../sales/schemas/sales.schema";

const bad=()=>{throw AppError.badRequest();};
export function money(value:unknown, positive=false):string {
 if(typeof value!=="string"||!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/.test(value)) return bad();
 const scaledValue=scaled(value,2);
 if(positive && scaledValue===0n) return bad();
 return decimal(scaledValue,2);
}
function natural(value:unknown):number {
 if(typeof value!=="number"||!Number.isSafeInteger(value)||value<1||value>100000) return bad();
 return value;
}
function date(value:unknown):string {
 if(typeof value!=="string"||!/^\d{4}-\d\d-\d\d$/.test(value))return bad();
 const d=new Date(value+"T00:00:00.000Z");
 if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==value)return bad();
 return value;
}
export function revisionBody(input:unknown) {
 const x=obj(input,["expectedRevisionNo","items","validUntil"]);
 const expectedRevisionNo=natural(x.expectedRevisionNo);
 if(!Array.isArray(x.items)||x.items.length<1||x.items.length>25)return bad();
 if(x.validUntil!==undefined&&x.validUntil!==null)date(x.validUntil);
 return {expectedRevisionNo,items:x.items,validUntil:x.validUntil===undefined?null:x.validUntil};
}
export function approvalBody(input:unknown) {
 const x=obj(input,["expectedRevisionNo"]);
 if(Object.keys(x).length!==1)return bad();
 return {expectedRevisionNo:natural(x.expectedRevisionNo)};
}
export function issueBody(input:unknown) {
 const x=obj(input,["dueAt"]);
 if(Object.keys(x).length!==1)return bad();
 return {dueAt:date(x.dueAt)};
}
export function paymentBody(input:unknown) {
 const x=obj(input,["amount","expectedBalance","method","reference","idempotencyKey"]);
 if(typeof x.method!=="string"||!["cash","bank_transfer","upi"].includes(x.method))return bad();
 if(typeof x.idempotencyKey!=="string"||!/^[A-Za-z0-9_-]{12,100}$/.test(x.idempotencyKey))return bad();
 if(x.reference!==undefined&&x.reference!==null&&(typeof x.reference!=="string"||x.reference.trim().length<2||x.reference.length>180))return bad();
 if(x.method!=="cash"&&typeof x.reference!=="string")return bad();
 const amount=money(x.amount,true);
 const expectedBalance=money(x.expectedBalance);
 if(scaled(amount,2)>scaled(expectedBalance,2))return bad();
 return {amount,expectedBalance,method:x.method,reference:typeof x.reference==="string"?x.reference.trim():null,idempotencyKey:x.idempotencyKey};
}
export function identifier(value:unknown):string {return id(value);}
