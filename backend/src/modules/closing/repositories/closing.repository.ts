import type { RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { AppError } from "../../../core/errors/AppError";
import type { TenantContext } from "../../../core/tenant/tenantContext";
import type { Db } from "../../finance/repositories/finance.repository";
import { dbId, scaled, decimal } from "../../sales/schemas/sales.schema";
import { targetDetail } from "../../operations/repositories/operations.targets.repository";
import type { rolloverBody, refundReviewBody, analyticsRange } from "../schemas/closing.schema";

interface TargetRow extends RowDataPacket { user_id: string|number|bigint|null; ends_on: string; }
interface AmountRow extends RowDataPacket { won_value: string; won_count: number|string; }
interface RefundRow extends RowDataPacket {
  id:string|number|bigint;payment_id:string|number|bigint;
  status:string;amount:string;payment_status:string;issued_by_id:string|number|bigint;
}
interface CountRow extends RowDataPacket { n:number|string; }
interface ReportRow extends RowDataPacket {
  id:string|number|bigint;user_id:string|number|bigint|null;
  starts_on:string;ends_on:string;target_amount:string;adjustment:string;
  won_value:string;won_count:string|number;currency:string;
}
interface AgingRow extends RowDataPacket {
  id:string|number|bigint;invoice_no:string;status:string;
  due_on:string|null;grand_total:string;paid:string;credits:string;
  currency:string;
}
interface TodayRow extends RowDataPacket { today:string; }

const fail = (): never => { throw AppError.conflict(); };
const limitMoney = (n: bigint):string => {
  if (n < 0n || n > 999999999999999999n) return fail();
  return decimal(n, 2);
};

async function audit(
  db:Db, t:TenantContext, action:string, kind:string,
  entityId:string, info:Record<string,unknown>, requestId:string|null
) {
  await db.execute(
    `INSERT INTO audit_logs
     (company_id,actor_user_id,action,entity_type,entity_id,outcome,request_id,details_json,occurred_at)
     VALUES (?,?,?,?,?,'success',?,?,UTC_TIMESTAMP(3))`,
    [t.companyId,t.actorUserId,action,kind,entityId,requestId,JSON.stringify(info)]
  );
}

// "Won deal amount" is an opportunity-value proxy; it is not recognized revenue or cash collected.
async function wonDeals(db:Db, t:TenantContext, ownerId:string, startsOn:string, endsOn:string) {
  const [rows] = await db.execute<AmountRow[]>(
    `SELECT CAST(COALESCE(SUM(d.expected_amount),0) AS CHAR) AS won_value,
            COUNT(*) AS won_count
     FROM deals d
     JOIN pipeline_stages s
       ON s.company_id=d.company_id AND s.pipeline_id=d.pipeline_id AND s.id=d.stage_id
     WHERE d.company_id=? AND d.owner_user_id=? AND d.currency='INR'
       AND s.stage_type='won'
       AND d.closed_at>=STR_TO_DATE(?,'%Y-%m-%d')
       AND d.closed_at<DATE_ADD(STR_TO_DATE(?,'%Y-%m-%d'),INTERVAL 1 DAY)`,
    [t.companyId,ownerId,startsOn,endsOn]
  );
  return {value:scaled(String(rows[0]?.won_value??'0'),2),count:Number(rows[0]?.won_count??0)};
}

export async function carryTarget(
  db:Db,t:TenantContext,targetId:string,input:ReturnType<typeof rolloverBody>,requestId:string|null
) {
  const previous = await targetDetail(db,t,targetId,true);
  if (previous.effective !== input.expectedEffective || previous.currency !== 'INR') return fail();
  const expectedNext = new Date(Date.parse(previous.endsOn + 'T00:00:00.000Z') + 86400000).toISOString().slice(0,10);
  if (input.nextStartsOn !== expectedNext) throw AppError.badRequest();

  // Lock the user row as the common serialization fence for overlapping periods.
  const [user] = await db.execute<TargetRow[]>(
    `SELECT id AS user_id, DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%d') AS ends_on
     FROM users WHERE company_id=? AND id=? AND role='employee' AND status='active'
     LIMIT 1 FOR UPDATE`,[t.companyId,previous.userId]
  );
  if (!user[0]) throw AppError.notFound();

  const [overlaps] = await db.execute<TargetRow[]>(
    `SELECT user_id FROM crm_target_periods
     WHERE company_id=? AND user_id=?
       AND starts_on<=STR_TO_DATE(?,'%Y-%m-%d')
       AND ends_on>=STR_TO_DATE(?,'%Y-%m-%d')
     LIMIT 1 FOR UPDATE`,
    [t.companyId,previous.userId,input.nextEndsOn,input.nextStartsOn]
  );
  if (overlaps.length) return fail();

  const won=await wonDeals(db,t,previous.userId,previous.startsOn,previous.endsOn);
  const outstanding=scaled(previous.effective,2)-won.value;
  const carried=outstanding>0n?outstanding:0n;
  const nextTotal=scaled(input.baseAmount,2)+carried;
  const nextAmount=limitMoney(nextTotal);

  const [result] = await db.execute<ResultSetHeader>(
    `INSERT INTO crm_target_periods
      (company_id,user_id,starts_on,ends_on,target_amount,currency)
     VALUES (?,?,STR_TO_DATE(?,'%Y-%m-%d'),STR_TO_DATE(?,'%Y-%m-%d'),?,'INR')`,
    [t.companyId,previous.userId,input.nextStartsOn,input.nextEndsOn,nextAmount]
  );
  const nextId=dbId(result.insertId);
  await audit(db,t,'target.carried_forward','target',nextId,{
    priorTargetId:targetId,priorEffective:previous.effective,
    wonDealValue:decimal(won.value,2),unmetTarget:decimal(carried,2),
    baseAmount:input.baseAmount,metric:'won_deal_expected_amount_not_realized_revenue'
  },requestId);
  return {id:nextId,userId:previous.userId,sourceTargetId:targetId,
    baseAmount:input.baseAmount,wonDealValue:decimal(won.value,2),
    shortfallCarried:decimal(carried,2),amount:nextAmount,
    startsOn:input.nextStartsOn,endsOn:input.nextEndsOn,
    metric:'won_deal_expected_amount_not_realized_revenue'};
}

export async function reviewRefund(
  db:Db,t:TenantContext,refundId:string,input:ReturnType<typeof refundReviewBody>,requestId:string|null
) {
  const [rows] = await db.execute<RefundRow[]>(
    `SELECT r.id,r.payment_id,r.status,CAST(r.amount AS CHAR) AS amount,
            p.status AS payment_status,i.issued_by_id
     FROM crm_payment_refunds r
     JOIN crm_payments p ON p.company_id=r.company_id AND p.id=r.payment_id
     JOIN crm_payment_allocations a ON a.company_id=p.company_id AND a.payment_id=p.id
     JOIN crm_invoices i ON i.company_id=a.company_id AND i.id=a.invoice_id
     WHERE r.company_id=? AND r.id=?
     LIMIT 1 FOR UPDATE`,[t.companyId,refundId]
  );
  const refund=rows[0];
  if (!refund || dbId(refund.id)!==refundId) throw AppError.notFound();
  if (t.role!=='MANAGER' || dbId(refund.issued_by_id)!==t.actorUserId) throw AppError.notFound();
  if (refund.status!=='pending') return fail();
  if (refund.payment_status!=='received') return fail();
  const [alloc] = await db.execute<CountRow[]>(
    `SELECT COUNT(DISTINCT invoice_id) AS n FROM crm_payment_allocations
     WHERE company_id=? AND payment_id=?`,[t.companyId,dbId(refund.payment_id)]
  );
  if (Number(alloc[0]?.n??0)!==1) return fail();
  const [changed]=await db.execute<ResultSetHeader>(
    `UPDATE crm_payment_refunds SET status=?
     WHERE company_id=? AND id=? AND status='pending'`,
    [input.decision,t.companyId,refundId]
  );
  if (changed.affectedRows!==1) return fail();
  await audit(db,t,'payment.refund_reviewed','payment_refund',refundId,{
    decision:input.decision,reason:input.reason,paymentId:dbId(refund.payment_id),
    amount:String(refund.amount),cashReturned:false,
    approvalNotCashDisbursement:true
  },requestId);
  return {id:refundId,status:input.decision,amount:String(refund.amount),
    paymentId:dbId(refund.payment_id),cashReturned:false,
    statusMeaning:input.decision==='approved'?'approved_for_external_settlement':'request_rejected'};
}

export async function targetPerformance(db:Db,t:TenantContext,range:ReturnType<typeof analyticsRange>) {
  const roleScope=t.role==='OWNER'?'':t.role==='EMPLOYEE'?' AND tp.user_id=?':
    ` AND EXISTS (SELECT 1 FROM team_members tm JOIN teams a
          ON a.company_id=tm.company_id AND a.id=tm.team_id
          WHERE tm.company_id=tp.company_id AND tm.user_id=tp.user_id
            AND tm.left_at IS NULL AND tm.joined_at<=UTC_TIMESTAMP(3)
            AND a.status='active' AND a.manager_user_id=?)`;
  const args=[t.companyId,range.to,range.from];
  if(t.role!=='OWNER')args.push(t.actorUserId);
  const [rows]=await db.execute<ReportRow[]>(
    `SELECT tp.id,tp.user_id,DATE_FORMAT(tp.starts_on,'%Y-%m-%d') AS starts_on,
       DATE_FORMAT(tp.ends_on,'%Y-%m-%d') AS ends_on,tp.currency,
       CAST(tp.target_amount AS CHAR) AS target_amount,
       CAST(COALESCE((SELECT SUM(adj.delta_amount) FROM crm_target_adjustments adj
         WHERE adj.company_id=tp.company_id AND adj.target_period_id=tp.id),0) AS CHAR) AS adjustment,
       CAST(COALESCE((SELECT SUM(d.expected_amount)
         FROM deals d JOIN pipeline_stages s
         ON s.company_id=d.company_id AND s.pipeline_id=d.pipeline_id AND s.id=d.stage_id
         WHERE d.company_id=tp.company_id AND d.owner_user_id=tp.user_id
           AND d.currency=tp.currency AND s.stage_type='won'
           AND d.closed_at>=tp.starts_on AND d.closed_at<DATE_ADD(tp.ends_on,INTERVAL 1 DAY)),0) AS CHAR) AS won_value,
       (SELECT COUNT(*) FROM deals d JOIN pipeline_stages s
         ON s.company_id=d.company_id AND s.pipeline_id=d.pipeline_id AND s.id=d.stage_id
         WHERE d.company_id=tp.company_id AND d.owner_user_id=tp.user_id
           AND d.currency=tp.currency AND s.stage_type='won'
           AND d.closed_at>=tp.starts_on AND d.closed_at<DATE_ADD(tp.ends_on,INTERVAL 1 DAY)) AS won_count
     FROM crm_target_periods tp
     WHERE tp.company_id=? AND tp.starts_on<=STR_TO_DATE(?,'%Y-%m-%d')
       AND tp.ends_on>=STR_TO_DATE(?,'%Y-%m-%d') ${roleScope}
     ORDER BY tp.id DESC LIMIT 1001`,args
  );
  if(rows.length>1000) return fail();
  const items=rows.map(row=>{
    if(row.user_id===null) return fail();
    const effective=scaled(String(row.target_amount),2)+
      (String(row.adjustment).startsWith('-')?-scaled(String(row.adjustment).slice(1),2):scaled(String(row.adjustment),2));
    const won=scaled(String(row.won_value),2);
    if(effective<0n) return fail();
    return {id:dbId(row.id),userId:dbId(row.user_id),startsOn:row.starts_on,endsOn:row.ends_on,
      currency:row.currency,target:limitMoney(effective),wonDealValue:limitMoney(won),
      shortfall:limitMoney(effective>won?effective-won:0n),wonDeals:Number(row.won_count)};
  });
  return {from:range.from,to:range.to,items,limit:1000,
    metric:'won_deal_expected_amount_not_realized_revenue'};
}

export async function invoiceAging(db:Db,t:TenantContext) {
  if(t.role==='EMPLOYEE') throw AppError.forbidden();
  const [todayRows]=await db.execute<TodayRow[]>(
    `SELECT DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%d') AS today`);
  const today=todayRows[0]?.today;
  if(!today) throw new Error('Missing database clock');
  const filter=t.role==='MANAGER'?' AND i.issued_by_id=?':'';
  const args=t.role==='MANAGER'?[t.companyId,t.actorUserId]:[t.companyId];
  const [rows]=await db.execute<AgingRow[]>(
    `SELECT i.id,i.invoice_no,i.status,i.currency,
       DATE_FORMAT(i.due_at,'%Y-%m-%d') AS due_on,
       CAST(i.grand_total AS CHAR) AS grand_total,
       CAST(COALESCE((SELECT SUM(a.amount) FROM crm_payment_allocations a
         JOIN crm_payments p ON p.company_id=a.company_id AND p.id=a.payment_id
         WHERE a.company_id=i.company_id AND a.invoice_id=i.id AND p.status='received'),0) AS CHAR) AS paid,
       CAST(COALESCE((SELECT SUM(c.amount) FROM crm_credit_notes c
         WHERE c.company_id=i.company_id AND c.invoice_id=i.id AND c.status='issued'),0) AS CHAR) AS credits
     FROM crm_invoices i
     WHERE i.company_id=? AND i.status IN ('issued','partially_paid','paid','settled')
       ${filter} ORDER BY i.id DESC LIMIT 2001`,args
  );
  if(rows.length>2000) return fail();
  const total={current:0n,days1to30:0n,days31to60:0n,days61plus:0n};
  const items=[];
  const now=Date.parse(today+'T00:00:00.000Z');
  for(const row of rows){
    const balance=scaled(String(row.grand_total),2)-scaled(String(row.paid),2)-scaled(String(row.credits),2);
    if(balance<0n) return fail();
    if(balance===0n) continue;
    const diff=row.due_on===null?0:Math.floor((now-Date.parse(row.due_on+'T00:00:00.000Z'))/86400000);
    const bucket=diff<=0?'current':diff<=30?'days1to30':diff<=60?'days31to60':'days61plus';
    total[bucket]+=balance;
    items.push({id:dbId(row.id),invoiceNo:row.invoice_no,status:row.status,
      dueOn:row.due_on,currency:row.currency,balance:limitMoney(balance),ageDays:Math.max(0,diff),bucket});
  }
  return {asOf:today,items,totals:{current:limitMoney(total.current),
    days1to30:limitMoney(total.days1to30),days31to60:limitMoney(total.days31to60),
    days61plus:limitMoney(total.days61plus)},limit:2000,
    method:'current_book_balance_by_invoice_due_date'};
}

// Quote every cell and neutralize spreadsheet formula payloads.
function cell(value:unknown){const raw=String(value??'');const guarded=/^\s*[=+@-]/.test(raw)?"'"+raw:raw;
  return '"'+guarded.replace(/"/g,'""')+'"';}
export function targetCsv(report:Awaited<ReturnType<typeof targetPerformance>>){
  const fields=['userId','startsOn','endsOn','currency','target','wonDealValue','shortfall','wonDeals'] as const;
  return '\uFEFF'+[fields.map(cell).join(','),...report.items.map(item=>fields.map(k=>cell(item[k])).join(','))].join('\r\n')+'\r\n';
}
export function agingCsv(report:Awaited<ReturnType<typeof invoiceAging>>){
  const fields=['invoiceNo','status','dueOn','currency','balance','ageDays','bucket'] as const;
  return '\uFEFF'+[fields.map(cell).join(','),...report.items.map(item=>fields.map(k=>cell(item[k])).join(','))].join('\r\n')+'\r\n';
}