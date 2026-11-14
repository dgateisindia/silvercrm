import { createHash } from "node:crypto";
import type { RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { AppError } from "../../../core/errors/AppError";
import type { TenantContext } from "../../../core/tenant/tenantContext";
import { dbId, scaled, decimal } from "../../sales/schemas/sales.schema";
import { invoiceBalance, type Db } from "../../finance/repositories/finance.repository";
import type { creditBody, refundBody, scheduleBody } from "../schemas/operations.schema";
export type FinanceDb=Db;
interface InvoiceRow extends RowDataPacket {status:string;currency:string;grand_total:string;issued_by_id:string|number|bigint;due_at:string|null;}
interface PaymentRow extends RowDataPacket {id:string|number|bigint;amount:string;currency:string;status:string;issued_by_id:string|number|bigint;}
interface SumRow extends RowDataPacket {total:string;}
interface AllocationRow extends RowDataPacket {invoices:number|string;allocated:string;}
interface SchRow extends RowDataPacket {id:string|number|bigint;dueOn:string;amount:string;status:string;}
async function audit(db:Db,t:TenantContext,action:string,type:string,id:string,details:Record<string,unknown>,rid:string|null){await db.execute(`INSERT INTO audit_logs(company_id,actor_user_id,action,entity_type,entity_id,outcome,request_id,details_json,occurred_at) VALUES(?,?,?,?,?,'success',?,?,UTC_TIMESTAMP(3))`,[t.companyId,t.actorUserId,action,type,id,rid,JSON.stringify(details)]);}
async function invoiceLock(db:Db,t:TenantContext,invoiceId:string){
 const [rows]=await db.execute<InvoiceRow[]>(`SELECT status,currency,grand_total,issued_by_id,DATE_FORMAT(due_at,'%Y-%m-%d') AS due_at FROM crm_invoices WHERE company_id=? AND id=? LIMIT 1 FOR UPDATE`,[t.companyId,invoiceId]);
 const inv=rows[0];if(!inv)throw AppError.notFound();if(t.role==='MANAGER'&&dbId(inv.issued_by_id)!==t.actorUserId)throw AppError.notFound();return inv;
}
export async function issueCredit(db:Db,t:TenantContext,invoiceId:string,body:ReturnType<typeof creditBody>,rid:string|null){
 const inv=await invoiceLock(db,t,invoiceId);if(!['issued','partially_paid'].includes(inv.status))throw AppError.conflict();
 const current=await invoiceBalance(db,t,invoiceId);if(current.balance!==body.expectedBalance||scaled(body.amount,2)>scaled(current.balance,2))throw AppError.conflict();
 const creditNo='CRED-'+createHash('sha256').update(`${t.companyId}:${invoiceId}:${body.key}`).digest('hex').slice(0,34);
 const [result]=await db.execute<ResultSetHeader>(`INSERT INTO crm_credit_notes(company_id,credit_no,invoice_id,amount,currency,reason,status,issued_by_id) VALUES(?,?,?,?,?,?,'issued',?)`,[t.companyId,creditNo,invoiceId,body.amount,inv.currency,body.reason,t.actorUserId]);
 const creditId=dbId(result.insertId);const remaining=scaled(current.balance,2)-scaled(body.amount,2);
 if(remaining===0n)await db.execute(`UPDATE crm_invoices SET status='settled' WHERE company_id=? AND id=?`,[t.companyId,invoiceId]);
 await audit(db,t,'invoice.credit_issued','credit_note',creditId,{invoiceId,amount:body.amount},rid);
 return {id:creditId,creditNo,invoiceId,creditAmount:body.amount,balance:decimal(remaining,2),invoiceStatus:remaining===0n?'settled':inv.status};
}
export async function requestRefund(db:Db,t:TenantContext,paymentId:string,body:ReturnType<typeof refundBody>,rid:string|null){
 const [payments]=await db.execute<PaymentRow[]>(`SELECT p.id,p.amount,p.currency,p.status,i.issued_by_id FROM crm_payments p INNER JOIN crm_payment_allocations a ON a.company_id=p.company_id AND a.payment_id=p.id INNER JOIN crm_invoices i ON i.company_id=a.company_id AND i.id=a.invoice_id WHERE p.company_id=? AND p.id=? LIMIT 1 FOR UPDATE`,[t.companyId,paymentId]);
 const payment=payments[0];if(!payment||dbId(payment.id)!==paymentId)throw AppError.notFound();if(t.role==='MANAGER'&&dbId(payment.issued_by_id)!==t.actorUserId)throw AppError.notFound();if(payment.status!=='received')throw AppError.conflict();
 // Only refund receipts fully allocated to one invoice under this manager.
 const [allocationRows]=await db.execute<AllocationRow[]>(`SELECT COUNT(DISTINCT invoice_id) AS invoices, COALESCE(SUM(amount),0) AS allocated FROM crm_payment_allocations WHERE company_id=? AND payment_id=?`,[t.companyId,paymentId]);
 if(Number(allocationRows[0]?.invoices)!==1||scaled(String(allocationRows[0]?.allocated??'0'),2)!==scaled(String(payment.amount),2))throw AppError.conflict();
 const [existing]=await db.execute<SumRow[]>(`SELECT COALESCE(SUM(amount),0) AS total FROM crm_payment_refunds WHERE company_id=? AND payment_id=? AND status IN ('pending','approved','processed')`,[t.companyId,paymentId]);
 const available=scaled(String(payment.amount),2)-scaled(String(existing[0]?.total??'0'),2);if(available<0n||decimal(available,2)!==body.expectedAvailable||scaled(body.amount,2)>available)throw AppError.conflict();
 const [result]=await db.execute<ResultSetHeader>(`INSERT INTO crm_payment_refunds(company_id,payment_id,amount,reason,status) VALUES(?,?,?,?,'pending')`,[t.companyId,paymentId,body.amount,body.reason]);const refundId=dbId(result.insertId);
 await audit(db,t,'payment.refund_requested','payment_refund',refundId,{paymentId,amount:body.amount,manualReview:true},rid);
 return {id:refundId,paymentId,amount:body.amount,status:'pending',availableAfterRequest:decimal(available-scaled(body.amount,2),2),cashReturned:false};
}
export async function addSchedules(db:Db,t:TenantContext,invoiceId:string,body:ReturnType<typeof scheduleBody>,rid:string|null){
 const inv=await invoiceLock(db,t,invoiceId);if(inv.status!=='issued'||!inv.due_at)throw AppError.conflict();
 const cur=await invoiceBalance(db,t,invoiceId);if(scaled(cur.paid,2)!==0n||scaled(cur.credits,2)!==0n)throw AppError.conflict();
 const [existing]=await db.execute<SumRow[]>(`SELECT COUNT(*) AS total FROM crm_invoice_due_schedules WHERE company_id=? AND invoice_id=?`,[t.companyId,invoiceId]);if(BigInt(existing[0]?.total??'0')!==0n)throw AppError.conflict();
 const total=body.items.reduce((acc,item)=>acc+scaled(item.amount,2),0n);
 if(total!==scaled(String(inv.grand_total),2)||body.items.some(item=>item.dueOn>inv.due_at!))throw AppError.badRequest();
 for(const item of body.items)await db.execute(`INSERT INTO crm_invoice_due_schedules(company_id,invoice_id,due_at,amount_due,status) VALUES(?,?,STR_TO_DATE(?,'%Y-%m-%d'),?,'unpaid')`,[t.companyId,invoiceId,item.dueOn,item.amount]);
 await audit(db,t,'invoice.due_schedule_created','invoice',invoiceId,{installments:body.items.length},rid);
 return {invoiceId,items:body.items,total:decimal(total,2)};
}
export async function dueSchedules(db:Db,t:TenantContext,invoiceId:string){
 await invoiceLock(db,t,invoiceId);
 const [rows]=await db.execute<SchRow[]>(`SELECT id,DATE_FORMAT(due_at,'%Y-%m-%d') AS dueOn,CAST(amount_due AS CHAR) AS amount,status FROM crm_invoice_due_schedules WHERE company_id=? AND invoice_id=? ORDER BY due_at,id LIMIT 25`,[t.companyId,invoiceId]);
 const cur=await invoiceBalance(db,t,invoiceId); const today=new Date().toISOString().slice(0,10);let accrued=0n;
 const paidAndCredited=scaled(cur.paid,2)+scaled(cur.credits,2);let coverage=paidAndCredited;
 const items=rows.map(r=>{const due=scaled(String(r.amount),2);if(r.dueOn<today)accrued+=due;const coverageStatus=coverage>=due?'covered':coverage>0n?'partial':'unpaid';coverage=coverage>due?coverage-due:0n;return {id:dbId(r.id),dueOn:r.dueOn,amount:String(r.amount),storedStatus:r.status,coverageStatus};});
 const overdue=accrued>paidAndCredited?accrued-paidAndCredited:0n;
 return {invoiceId,items,overdue:decimal(overdue,2),balance:cur.balance,asOf:today,method:'cumulative_due_less_received_and_credited'};
}