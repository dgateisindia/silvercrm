import type { RowDataPacket } from 'mysql2/promise';
import {AppError} from '../../../core/errors/AppError';
import type {TenantContext} from '../../../core/tenant/tenantContext';
import type {Db} from '../../finance/repositories/finance.repository';
import {scaled,decimal,dbId} from '../../sales/schemas/sales.schema';
import type {reportDates} from '../schemas/operations.schema';
interface Invoice extends RowDataPacket {id:string|number|bigint;invoice_no:string;status:string;grand_total:string;paid:string;credits:string;currency:string;issued_at:string;}
interface Task extends RowDataPacket{id:string|number|bigint;title:string;status:string;dueAt:string|null;lead_id:string|number|bigint|null;}
interface Notice extends RowDataPacket{id:string|number|bigint;notification_type:string;title:string;body:string|null;readAt:string|null;}
export async function financeReport(db:Db,t:TenantContext,range:ReturnType<typeof reportDates>){
 const args:string[]=[t.companyId,range.from,range.to];const ownerFilter=t.role==='MANAGER'?' AND i.issued_by_id=?':'';if(t.role==='MANAGER')args.push(t.actorUserId);
 const [rows]=await db.execute<Invoice[]>(`SELECT i.id,i.invoice_no,i.status,CAST(i.grand_total AS CHAR) AS grand_total,i.currency,DATE_FORMAT(i.issued_at,'%Y-%m-%d') AS issued_at, COALESCE((SELECT SUM(a.amount) FROM crm_payment_allocations a JOIN crm_payments p ON p.company_id=a.company_id AND p.id=a.payment_id WHERE a.company_id=i.company_id AND a.invoice_id=i.id AND p.status='received'),0) AS paid, COALESCE((SELECT SUM(c.amount) FROM crm_credit_notes c WHERE c.company_id=i.company_id AND c.invoice_id=i.id AND c.status='issued'),0) AS credits FROM crm_invoices i WHERE i.company_id=? AND i.issued_at>=STR_TO_DATE(?,'%Y-%m-%d') AND i.issued_at<DATE_ADD(STR_TO_DATE(?,'%Y-%m-%d'),INTERVAL 1 DAY) ${ownerFilter} ORDER BY i.id DESC LIMIT 2001`,args);
 if(rows.length>2000)throw AppError.conflict();
 let billed=0n,paid=0n,credits=0n;const items=rows.map(r=>{const value=scaled(String(r.grand_total),2),p=scaled(String(r.paid),2),c=scaled(String(r.credits),2);if(value-p-c<0n)throw AppError.conflict();billed+=value;paid+=p;credits+=c;return {id:dbId(r.id),number:r.invoice_no,issuedOn:r.issued_at,status:r.status,currency:r.currency,total:decimal(value,2),paid:decimal(p,2),credits:decimal(c,2),balance:decimal(value-p-c,2)};});
 return {from:range.from,to:range.to,items,totals:{invoices:items.length,billed:decimal(billed,2),paid:decimal(paid,2),credits:decimal(credits,2),outstanding:decimal(billed-paid-credits,2)},metric:'manual_receipts_and_issued_credits',limit:2000};
}
function csvCell(value:unknown){const s=String(value??'');const escaped=/^[\s]*[=+@-]/.test(s)?"'"+s:s;return '"'+escaped.replace(/"/g,'""')+'"';}
export function financeCsv(report:Awaited<ReturnType<typeof financeReport>>){const columns=['number','issuedOn','status','currency','total','paid','credits','balance'] as const;const lines=[columns.map(csvCell).join(',')];for(const item of report.items){lines.push(columns.map(key=>csvCell(item[key])).join(','));}return '\uFEFF'+lines.join('\r\n')+'\r\n';}
export async function dueTasks(db:Db,t:TenantContext){
 if(t.role==='OWNER')return {items:[],nextDays:7};
 const [rows]=await db.execute<Task[]>(`SELECT id,title,status,lead_id,DATE_FORMAT(due_at,'%Y-%m-%dT%H:%i:%s') AS dueAt FROM tasks WHERE company_id=? AND owner_user_id=? AND due_at IS NOT NULL AND due_at<=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 7 DAY) AND status<>'completed' ORDER BY due_at,id LIMIT 101`,[t.companyId,t.actorUserId]);if(rows.length>100)throw AppError.conflict();
 return {items:rows.map(r=>({id:dbId(r.id),title:r.title,status:r.status,leadId:r.lead_id?dbId(r.lead_id):null,dueAt:r.dueAt})),nextDays:7,mode:'on_demand_only'};
}
export async function notifications(db:Db,t:TenantContext){const [rows]=await db.execute<Notice[]>(`SELECT id,notification_type,title,body,DATE_FORMAT(read_at,'%Y-%m-%dT%H:%i:%s') AS readAt FROM notifications WHERE company_id=? AND recipient_user_id=? ORDER BY id DESC LIMIT 100`,[t.companyId,t.actorUserId]);return {items:rows.map(r=>({id:dbId(r.id),type:r.notification_type,title:r.title,body:r.body,readAt:r.readAt})),limit:100};}
export async function readNotification(db:Db,t:TenantContext,id:string){const [rows]=await db.execute<Notice[]>(`SELECT id FROM notifications WHERE company_id=? AND recipient_user_id=? AND id=? LIMIT 1 FOR UPDATE`,[t.companyId,t.actorUserId,id]);if(!rows[0])throw AppError.notFound();await db.execute(`UPDATE notifications SET read_at=COALESCE(read_at,UTC_TIMESTAMP(3)) WHERE company_id=? AND recipient_user_id=? AND id=?`,[t.companyId,t.actorUserId,id]);return {id,read:true};}