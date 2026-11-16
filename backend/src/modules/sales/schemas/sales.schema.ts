import { AppError } from "../../../core/errors/AppError";

export function id(input: unknown): string {
  if (typeof input !== "string" || !/^[1-9][0-9]{0,19}$/.test(input) || BigInt(input) > 18446744073709551615n) throw AppError.badRequest();
  return input;
}
export function dbId(input: unknown): string {
  if (typeof input === "bigint" && input > 0n && input <= 18446744073709551615n) return String(input);
  if (typeof input === "number" && Number.isSafeInteger(input) && input > 0) return String(input);
  if (typeof input === "string") return id(input);
  throw new Error("Invalid SQL identifier");
}
export function obj(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw AppError.badRequest();
  const input = value as Record<string,unknown>;
  if (Object.keys(input).some(k => !allowed.includes(k))) throw AppError.badRequest();
  return input;
}
function text(v: unknown, max: number): string {
  if (typeof v !== "string" || !v.trim() || v.trim().length > max || /[\x00-\x08\x0B\x0E-\x1F]/.test(v)) throw AppError.badRequest();
  return v.trim();
}
function optionalDate(value: unknown): string|null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\d$/.test(value)) throw AppError.badRequest();
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== value) throw AppError.badRequest();
  return value;
}
function money(v: unknown, scale: 2|3|4, maxDigits=16): string {
  const re = new RegExp(`^(?:0|[1-9]\\d{0,${maxDigits-1}})(?:\\.\\d{1,${scale}})?$`);
  if (typeof v !== "string" || !re.test(v)) throw AppError.badRequest();
  return v;
}
export function scaled(value: string, places: number): bigint {
  const [whole, frac=""] = value.split(".");
  return BigInt(whole!) * 10n ** BigInt(places) + BigInt((frac.padEnd(places,"0") || "0"));
}
export function decimal(value: bigint, places: number): string {
  const divisor = 10n ** BigInt(places);
  return `${value/divisor}.${(value%divisor).toString().padStart(places,"0")}`;
}
export function parsePipeline(value:unknown) {
  const x=obj(value,["name","stages"]);
  const name=text(x.name,140);
  if (!Array.isArray(x.stages) || x.stages.length<1 || x.stages.length>16) throw AppError.badRequest();
  const stages=x.stages.map(s=>{
    const v=obj(s,["name","type"]);
    if (v.type!=="open" && v.type!=="won" && v.type!=="lost") throw AppError.badRequest();
    return {name:text(v.name,120),type:v.type};
  });
  if (!stages.some(s=>s.type==="open") || new Set(stages.map(s=>s.name.toLowerCase())).size!==stages.length) throw AppError.badRequest();
  return {name,stages};
}
export function parseProduct(value:unknown) {
  const v=obj(value,["name","sku","itemType","unit","price","taxRate"]);
  if (v.itemType!=="product" && v.itemType!=="service") throw AppError.badRequest();
  const sku=v.sku===undefined||v.sku===null?null:text(v.sku,100);
  const price=money(v.price,2);const tax=money(v.taxRate,4,3);
  if (scaled(tax,4)>1000000n) throw AppError.badRequest();
  return {name:text(v.name,200),sku,itemType:v.itemType,unit:v.unit===undefined?"each":text(v.unit,30),price,taxRate:tax};
}
export function parseDeal(value:unknown) {
  const v=obj(value,["title","leadId","pipelineId","stageId","amount","expectedCloseDate"]);
  return {title:text(v.title,200),leadId:id(v.leadId),pipelineId:id(v.pipelineId),stageId:id(v.stageId),amount:money(v.amount,2),expectedCloseDate:optionalDate(v.expectedCloseDate)};
}
export function parseStage(value:unknown) {
  const v=obj(value,["expectedRevision","stageId"]);
  if (typeof v.expectedRevision!=="string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}$/.test(v.expectedRevision)) throw AppError.badRequest();
  return {expectedRevision:v.expectedRevision,stageId:id(v.stageId)};
}
export function parseQuote(value:unknown) {
  const v=obj(value,["dealId","validUntil","items","discountAmount"]);
  if (!Array.isArray(v.items)||!v.items.length||v.items.length>25) throw AppError.badRequest();
  const items=v.items.map(item=>{
    const row=obj(item,["description","quantity","unitPrice","taxRate"]);
    const quantity=money(row.quantity,3,9);const unitPrice=money(row.unitPrice,2,14);const taxRate=money(row.taxRate,4,3);
    if (scaled(quantity,3)===0n || scaled(taxRate,4)>1000000n) throw AppError.badRequest();
    const net=(scaled(quantity,3)*scaled(unitPrice,2)+500n)/1000n;
    if (net>999999999999999999n) throw AppError.badRequest();
    return {description:text(row.description,250),quantity,unitPrice,taxRate,net};
  });
  const subtotal=items.reduce((a,b)=>a+b.net,0n);
  const discountAmount=v.discountAmount===undefined?'0.00':money(v.discountAmount,2);
  const discount=scaled(discountAmount,2);
  if (discount>subtotal) throw AppError.badRequest();
  // Proportionally apportion a quotation-level discount to taxable items, to the exact cent.
  const distributed=items.map(row=>subtotal===0n?0n:(discount*row.net)/subtotal);
  const candidates=items.map((row,index)=>({index,part:subtotal===0n?0n:(discount*row.net)%subtotal}));
  candidates.sort((a,b)=>a.part===b.part?a.index-b.index:a.part>b.part?-1:1);
  let remaining=discount-distributed.reduce((sum,x)=>sum+x,0n);
  for (const c of candidates){if(remaining===0n)break;const portion=distributed[c.index],item=items[c.index];if(portion!==undefined&&item&&portion<item.net){distributed[c.index]=portion+1n;remaining-=1n;}}
  if(remaining!==0n)throw AppError.badRequest();
  const adjusted=items.map((row,index)=>{
    const taxable=row.net-distributed[index]!;
    const tax=(taxable*scaled(row.taxRate,4)+500000n)/1000000n;
    if(tax>999999999999999999n)throw AppError.badRequest();
    return {...row,tax};
  });
  const taxes=adjusted.reduce((sum,row)=>sum+row.tax,0n);
  if(subtotal>999999999999999999n||taxes>999999999999999999n||subtotal-discount+taxes>999999999999999999n)throw AppError.badRequest();
  return {dealId:id(v.dealId),validUntil:optionalDate(v.validUntil),items:adjusted,
    subtotal:decimal(subtotal,2),discountAmount:decimal(discount,2),taxes:decimal(taxes,2),grandTotal:decimal(subtotal-discount+taxes,2)};
}

export function limit(input:unknown):number {
  if (input===undefined) return 30;
  if (typeof input!=="string" || !/^[1-9]\d{0,2}$/.test(input) || Number(input)>100) throw AppError.badRequest();
  return Number(input);
}

/** The customer-supplied number/date; amount and role scope are never accepted from the browser. */
export function parseCustomerPurchaseOrder(value:unknown){
 const v=obj(value,['quotationId','customerPoNumber','customerPoDate']);
 const customerPoDate=optionalDate(v.customerPoDate);
 if(customerPoDate===null)throw AppError.badRequest();
 return {quotationId:id(v.quotationId),customerPoNumber:text(v.customerPoNumber,100),customerPoDate};
}
export function parseCustomerPurchaseOrderId(value:unknown):string{return id(value);}
export function parseCustomerPurchaseOrderCursor(value:unknown):string|null{return value===undefined||value===null?null:id(value);}
