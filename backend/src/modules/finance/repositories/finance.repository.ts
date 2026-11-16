import { randomUUID, createHash } from "node:crypto";
import type { PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { AppError } from "../../../core/errors/AppError";
import type { TenantContext } from "../../../core/tenant/tenantContext";
import { visibleDeal } from "../../sales/repositories/sales.repository";
import { dbId, parseQuote, scaled, decimal } from "../../sales/schemas/sales.schema";
import { revisionBody, approvalBody, issueBody, paymentBody } from "../schemas/finance.schema";

export type Db=Pick<PoolConnection,"execute"|"beginTransaction"|"commit"|"rollback"|"release"|"destroy">;
interface Quote extends RowDataPacket {id:string|number|bigint; deal_id:string|number|bigint|null; status:string; currency:string;}
interface Rev extends RowDataPacket {id:string|number|bigint; revision_no:number; subtotal:string; discount_total:string; tax_total:string; grand_total:string; status:string;}
interface Invoice extends RowDataPacket {id:string|number|bigint; company_id:string|number|bigint; issued_by_id:string|number|bigint; status:string; invoice_no:string; currency:string; grand_total:string; due_at:string|null;}
interface Totals extends RowDataPacket {paid:string; credits:string;}
const name=(tag:string)=>`${tag}-${randomUUID().replace(/-/g,"").slice(0,26)}`;
async function audit(db:Db,t:TenantContext,action:string,entity:string,entityId:string,detail:Record<string,unknown>,rid:string|null) {
 await db.execute(`INSERT INTO audit_logs(company_id,actor_user_id,action,entity_type,entity_id,outcome,request_id,details_json,occurred_at) VALUES(?,?,?,?,?,'success',?,?,UTC_TIMESTAMP(3))`,[t.companyId,t.actorUserId,action,entity,entityId,rid,JSON.stringify(detail)]);
}
async function quote(db:Db,t:TenantContext,quoteId:string,lock:boolean) {
 const [rows]=await db.execute<Quote[]>(`SELECT id,deal_id,status,currency FROM crm_quotations WHERE company_id=? AND id=? LIMIT 1 ${lock?'FOR UPDATE':''}`,[t.companyId,quoteId]);
 const q=rows[0];if(!q||!q.deal_id||dbId(q.id)!==quoteId)throw AppError.notFound();
 await visibleDeal(db,t,dbId(q.deal_id),lock);
 return {id:quoteId,dealId:dbId(q.deal_id),status:q.status,currency:q.currency};
}
async function newest(db:Db,t:TenantContext,quoteId:string,lock:boolean) {
 const [rows]=await db.execute<Rev[]>(`SELECT id,revision_no,subtotal,discount_total,tax_total,grand_total,status FROM crm_quotation_revisions WHERE company_id=? AND quotation_id=? ORDER BY revision_no DESC LIMIT 1 ${lock?'FOR UPDATE':''}`,[t.companyId,quoteId]);
 const rev=rows[0];if(!rev)throw AppError.notFound();
 return {...rev,id:dbId(rev.id)};
}
export async function quoteRevisions(db:Db,t:TenantContext,quoteId:string) {
 const q=await quote(db,t,quoteId,false);
 const [rows]=await db.execute<Rev[]>(`SELECT id,revision_no,subtotal,discount_total,tax_total,grand_total,status FROM crm_quotation_revisions WHERE company_id=? AND quotation_id=? ORDER BY revision_no DESC LIMIT 50`,[t.companyId,quoteId]);
 return {quoteId,status:q.status,revisions:rows.map(r=>({id:dbId(r.id),revisionNo:r.revision_no,subtotal:String(r.subtotal),taxTotal:String(r.tax_total),grandTotal:String(r.grand_total),status:r.status}))};
}
export async function reviseQuote(db:Db,t:TenantContext,quoteId:string,input:ReturnType<typeof revisionBody>,rid:string|null) {
 const q=await quote(db,t,quoteId,true);
 if(q.status!=="draft")throw AppError.conflict();
 const last=await newest(db,t,quoteId,true);
 if(last.revision_no!==input.expectedRevisionNo)throw AppError.conflict();
 const parsed=parseQuote({dealId:q.dealId,validUntil:input.validUntil,items:input.items,discountAmount:input.discountAmount});
 const next=last.revision_no+1;
 const [created]=await db.execute<ResultSetHeader>(`INSERT INTO crm_quotation_revisions(company_id,quotation_id,revision_no,subtotal,discount_total,tax_total,grand_total,status,created_by_id) VALUES(?,?,?,?,?,?,?,'draft',?)`,[t.companyId,quoteId,next,parsed.subtotal,parsed.discountAmount,parsed.taxes,parsed.grandTotal,t.actorUserId]);
 const revId=dbId(created.insertId);
 for(const item of parsed.items){await db.execute(`INSERT INTO crm_quotation_items(company_id,revision_id,description,quantity,unit_price,tax_rate,line_total) VALUES(?,?,?,?,?,?,?)`,[t.companyId,revId,item.description,item.quantity,item.unitPrice,item.taxRate,decimal(item.net,2)]);}
 await db.execute(`UPDATE crm_quotations SET valid_until=? WHERE company_id=? AND id=?`,[parsed.validUntil,t.companyId,quoteId]);
 await audit(db,t,"quote.revised","quotation",quoteId,{revisionNo:next,itemCount:parsed.items.length},rid);
 return {quoteId,revisionId:revId,revisionNo:next,subtotal:parsed.subtotal,taxTotal:parsed.taxes,grandTotal:parsed.grandTotal};
}
export async function approveQuote(db:Db,t:TenantContext,quoteId:string,input:ReturnType<typeof approvalBody>,rid:string|null) {
 const q=await quote(db,t,quoteId,true);
 if(q.status!=="draft")throw AppError.conflict();
 const latest=await newest(db,t,quoteId,true);
 if(latest.revision_no!==input.expectedRevisionNo)throw AppError.conflict();
 await db.execute(`UPDATE crm_quotations SET status='approved' WHERE company_id=? AND id=? AND status='draft'`,[t.companyId,quoteId]);
 await db.execute(`UPDATE crm_quotation_revisions SET status='approved' WHERE company_id=? AND id=? AND status='draft'`,[t.companyId,latest.id]);
 await audit(db,t,"quote.approved_internal","quotation",quoteId,{revisionId:latest.id,revisionNo:latest.revision_no},rid);
 return {quoteId,revisionNo:latest.revision_no,status:"approved"};
}
export async function createInvoice(db:Db,t:TenantContext,quoteId:string,rid:string|null) {
 const q=await quote(db,t,quoteId,true);
 if(q.status!=="approved")throw AppError.conflict();
 const rev=await newest(db,t,quoteId,true);
 if(rev.status!=="approved"||scaled(String(rev.grand_total),2)===0n)throw AppError.conflict();
 const [items]=await db.execute<RowDataPacket[]>(`SELECT description,quantity,unit_price,tax_rate,line_total FROM crm_quotation_items WHERE company_id=? AND revision_id=? ORDER BY id LIMIT 26`,[t.companyId,rev.id]);
 if(items.length<1||items.length>25)throw AppError.conflict();
 const calc=items.reduce((acc,row)=>{const net=scaled(String(row.line_total),2);const tax=(net*scaled(String(row.tax_rate),4)+500000n)/1000000n;return {gross:acc.gross+net+tax,tax:acc.tax+tax};},{gross:0n,tax:0n});
 if(calc.gross!==scaled(String(rev.grand_total),2)||calc.tax!==scaled(String(rev.tax_total),2))throw AppError.conflict();
 const invoiceNo=name("INV");
 const [result]=await db.execute<ResultSetHeader>(`INSERT INTO crm_invoices(company_id,invoice_no,issued_by_id,status,currency,grand_total) VALUES(?,?,?,'draft',?,?)`,[t.companyId,invoiceNo,t.actorUserId,q.currency,String(rev.grand_total)]);
 const invoiceId=dbId(result.insertId);
 for(const row of items){const net=scaled(String(row.line_total),2);const tax=(net*scaled(String(row.tax_rate),4)+500000n)/1000000n;await db.execute(`INSERT INTO crm_invoice_items(company_id,invoice_id,description,quantity,unit_price,tax_amount,line_total) VALUES(?,?,?,?,?,?,?)`,[t.companyId,invoiceId,row.description,String(row.quantity),String(row.unit_price),decimal(tax,2),decimal(net,2)]);}
 const [marked]=await db.execute<ResultSetHeader>(`UPDATE crm_quotations SET status='invoiced' WHERE company_id=? AND id=? AND status='approved'`,[t.companyId,quoteId]);
 if(marked.affectedRows!==1)throw AppError.conflict();
 await audit(db,t,"invoice.drafted_from_quote","invoice",invoiceId,{quoteId,revisionId:rev.id,invoiceNo},rid);
 return {id:invoiceId,invoiceNo,status:"draft",currency:q.currency,grandTotal:String(rev.grand_total),sourceQuoteId:quoteId};
}
async function invoice(db:Db,t:TenantContext,invoiceId:string,lock:boolean) {
 const [rows]=await db.execute<Invoice[]>(`SELECT id,company_id,issued_by_id,invoice_no,status,currency,grand_total,DATE_FORMAT(due_at,'%Y-%m-%d') AS due_at FROM crm_invoices WHERE company_id=? AND id=? LIMIT 1 ${lock?'FOR UPDATE':''}`,[t.companyId,invoiceId]);
 const row=rows[0];if(!row||dbId(row.id)!==invoiceId||dbId(row.company_id)!==t.companyId)throw AppError.notFound();
 if(t.role==='MANAGER'&&dbId(row.issued_by_id)!==t.actorUserId)throw AppError.notFound();
 if(t.role==='EMPLOYEE')throw AppError.forbidden();
 return row;
}
async function amounts(db:Db,t:TenantContext,invoiceId:string) {
 const [rows]=await db.execute<Totals[]>(`SELECT COALESCE((SELECT SUM(a.amount) FROM crm_payment_allocations a JOIN crm_payments p ON p.company_id=a.company_id AND p.id=a.payment_id WHERE a.company_id=? AND a.invoice_id=? AND p.status='received'),0) AS paid,COALESCE((SELECT SUM(c.amount) FROM crm_credit_notes c WHERE c.company_id=? AND c.invoice_id=? AND c.status='issued'),0) AS credits`,[t.companyId,invoiceId,t.companyId,invoiceId]);
 const row=rows[0];if(!row)throw new Error('Missing invoice totals');return {paid:scaled(String(row.paid),2),credits:scaled(String(row.credits),2)};
}
async function balance(db:Db,t:TenantContext,invoiceId:string,row:Invoice){
 const paidCredits=await amounts(db,t,invoiceId);
 const total=scaled(String(row.grand_total),2);
 const due=total-paidCredits.paid-paidCredits.credits;
 if(due<0n)throw AppError.conflict();
 return {id:invoiceId,invoiceNo:row.invoice_no,status:row.status,currency:row.currency,grandTotal:decimal(total,2),paid:decimal(paidCredits.paid,2),credits:decimal(paidCredits.credits,2),balance:decimal(due,2),dueAt:row.due_at};
}
export async function invoiceBalance(db:Db,t:TenantContext,invoiceId:string){const row=await invoice(db,t,invoiceId,false);return balance(db,t,invoiceId,row);}
export async function issueInvoice(db:Db,t:TenantContext,invoiceId:string,input:ReturnType<typeof issueBody>,rid:string|null){
 const row=await invoice(db,t,invoiceId,true);
 if(row.status!=='draft')throw AppError.conflict();
 const [result]=await db.execute<ResultSetHeader>(`UPDATE crm_invoices SET status='issued',issued_at=UTC_TIMESTAMP(3),due_at=STR_TO_DATE(?,'%Y-%m-%d') WHERE company_id=? AND id=? AND status='draft'`,[input.dueAt,t.companyId,invoiceId]);
 if(result.affectedRows!==1)throw AppError.conflict();
 await audit(db,t,'invoice.issued_internal','invoice',invoiceId,{invoiceNo:row.invoice_no,dueAt:input.dueAt},rid);
 return {id:invoiceId,status:'issued',dueAt:input.dueAt};
}
export async function receivePayment(db:Db,t:TenantContext,invoiceId:string,input:ReturnType<typeof paymentBody>,rid:string|null){
 const row=await invoice(db,t,invoiceId,true);
 if(!['issued','partially_paid'].includes(row.status))throw AppError.conflict();
 const current=await balance(db,t,invoiceId,row);
 if(current.balance!==input.expectedBalance)throw AppError.conflict();
 const amount=scaled(input.amount,2);
 if(amount>scaled(current.balance,2))throw AppError.conflict();
 // Unique (company_id,payment_no) is an idempotency fence for retried manual submissions.
 const paymentNo='PAY-'+createHash('sha256').update(`${t.companyId}:${invoiceId}:${input.idempotencyKey}`).digest('hex').slice(0,32);
 const [result]=await db.execute<ResultSetHeader>(`INSERT INTO crm_payments(company_id,payment_no,amount,currency,payment_method,provider_ref,status,received_at,recorded_by_id) VALUES(?,?,?,?,?,?,'received',UTC_TIMESTAMP(3),?)`,[t.companyId,paymentNo,input.amount,row.currency,input.method,input.reference,t.actorUserId]);
 const paymentId=dbId(result.insertId);
 await db.execute(`INSERT INTO crm_payment_allocations(company_id,payment_id,invoice_id,amount,allocated_by_id) VALUES(?,?,?,?,?)`,[t.companyId,paymentId,invoiceId,input.amount,t.actorUserId]);
 const after=scaled(current.balance,2)-amount;
 await db.execute(`UPDATE crm_invoices SET status=? WHERE company_id=? AND id=?`,[after===0n?'paid':'partially_paid',t.companyId,invoiceId]);
 await audit(db,t,'payment.manual_received','payment',paymentId,{invoiceId,amount:input.amount,method:input.method,manual:true},rid);
 return {id:paymentId,paymentNo,invoiceId,amount:input.amount,balance:decimal(after,2),invoiceStatus:after===0n?'paid':'partially_paid',verification:'manual_record'};
}
