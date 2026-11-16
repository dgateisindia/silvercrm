import { randomUUID } from "node:crypto";
import type { PoolConnection,RowDataPacket,ResultSetHeader } from "mysql2/promise";
import { AppError } from "../../../core/errors/AppError";
import type { TenantContext } from "../../../core/tenant/tenantContext";
import { scopedLead } from "../../leads/repositories/lead_workflows.common";
import { dbId,scaled,decimal } from "../schemas/sales.schema";

export type Db = Pick<PoolConnection,"execute"|"beginTransaction"|"commit"|"rollback"|"release"|"destroy">;
interface Row extends RowDataPacket {id:string|number|bigint;company_id?:string|number|bigint;owner_user_id?:string|number|bigint;pipeline_id?:string|number|bigint;stage_id?:string|number|bigint;lead_id?:string|number|bigint|null;stage_type?:string;expected_amount?:string;currency?:string;revision?:string;status?:string;active?:number;name?:string}
function ownerClause(t:TenantContext,alias:string):{sql:string;args:string[]} {
 if(t.role==="OWNER")return {sql:"1=1",args:[]};
 if(t.role==="EMPLOYEE")return {sql:`${alias}.owner_user_id=?`,args:[t.actorUserId]};
 return {sql:`(${alias}.owner_user_id=? OR EXISTS(SELECT 1 FROM team_members tm JOIN teams te ON te.company_id=tm.company_id AND te.id=tm.team_id WHERE tm.company_id=${alias}.company_id AND tm.user_id=${alias}.owner_user_id AND tm.left_at IS NULL AND tm.joined_at<=UTC_TIMESTAMP(3) AND te.manager_user_id=? AND te.status='active'))`,args:[t.actorUserId,t.actorUserId]};
}
export async function visibleDeal(db:Db,t:TenantContext,dealId:string,lock=false) {
 const [rows]=await db.execute<Row[]>(`SELECT d.id,d.company_id,d.owner_user_id,d.lead_id,d.pipeline_id,d.stage_id,d.expected_amount,d.currency,s.stage_type,DATE_FORMAT(d.updated_at,'%Y-%m-%dT%H:%i:%s.%f') AS revision FROM deals d JOIN pipeline_stages s ON s.company_id=d.company_id AND s.pipeline_id=d.pipeline_id AND s.id=d.stage_id WHERE d.company_id=? AND d.id=? LIMIT 1 ${lock?"FOR UPDATE":""}`,[t.companyId,dealId]);
 const d=rows[0];if(!d||dbId(d.id)!==dealId||dbId(d.company_id)!==t.companyId||!d.owner_user_id)throw AppError.notFound();
 const owner=dbId(d.owner_user_id);
 if(t.role==="EMPLOYEE"&&owner!==t.actorUserId)throw AppError.notFound();
 if(t.role==="MANAGER"&&owner!==t.actorUserId){const [m]=await db.execute<RowDataPacket[]>(`SELECT tm.id FROM team_members tm JOIN teams te ON te.company_id=tm.company_id AND te.id=tm.team_id WHERE tm.company_id=? AND tm.user_id=? AND tm.left_at IS NULL AND tm.joined_at<=UTC_TIMESTAMP(3) AND te.manager_user_id=? AND te.status='active' LIMIT 1`,[t.companyId,owner,t.actorUserId]);if(!m.length)throw AppError.notFound();}
 return {id:dealId,ownerUserId:owner,leadId:d.lead_id===null||d.lead_id===undefined?null:dbId(d.lead_id),pipelineId:dbId(d.pipeline_id),stageId:dbId(d.stage_id),stageType:d.stage_type,amount:String(d.expected_amount),currency:d.currency,revision:d.revision};
}
async function audit(db:Db,t:TenantContext,action:string,entity:string,entityId:string,detail:Record<string,unknown>,requestId:string|null) {
 await db.execute(`INSERT INTO audit_logs(company_id,actor_user_id,action,entity_type,entity_id,outcome,request_id,details_json,occurred_at) VALUES(?,?,?,?,?,'success',?,?,UTC_TIMESTAMP(3))`,[t.companyId,t.actorUserId,action,entity,entityId,requestId,JSON.stringify(detail)]);
}
export async function listPipelines(db:Db,t:TenantContext) {
 const [p]=await db.execute<RowDataPacket[]>(`SELECT id,name,is_default,active FROM pipelines WHERE company_id=? AND active=1 ORDER BY id LIMIT 100`,[t.companyId]);
 const [s]=await db.execute<RowDataPacket[]>(`SELECT id,pipeline_id,name,position,stage_type FROM pipeline_stages WHERE company_id=? ORDER BY pipeline_id,position LIMIT 1000`,[t.companyId]);
 return p.map(x=>({id:dbId(x.id),name:x.name,isDefault:Boolean(x.is_default),stages:s.filter(y=>dbId(y.pipeline_id)===dbId(x.id)).map(y=>({id:dbId(y.id),name:y.name,type:y.stage_type,position:y.position}))}));
}
export async function createPipeline(db:Db,t:TenantContext,v:ReturnType<typeof import("../schemas/sales.schema").parsePipeline>,rid:string|null) {
 const [p]=await db.execute<ResultSetHeader>(`INSERT INTO pipelines(company_id,name,is_default,active) VALUES(?,?,0,1)`,[t.companyId,v.name]);
 const pipe=dbId(p.insertId);const stages=[];
 for(const [i,s] of v.stages.entries()){
  const [r]=await db.execute<ResultSetHeader>(`INSERT INTO pipeline_stages(company_id,pipeline_id,name,position,stage_type) VALUES(?,?,?,?,?)`,[t.companyId,pipe,s.name,i+1,s.type]);
  stages.push({id:dbId(r.insertId),name:s.name,type:s.type});
 }
 await audit(db,t,"pipeline.created","pipeline",pipe,{stageCount:stages.length},rid);
 return {id:pipe,name:v.name,stages};
}
async function companyCurrency(db:Db,t:TenantContext):Promise<string> {
 const [rows]=await db.execute<RowDataPacket[]>(`SELECT currency FROM companies WHERE id=? LIMIT 1`,[t.companyId]);
 const c=rows[0]?.currency;
 if(typeof c!=="string"||!/^[A-Z]{3}$/.test(c))throw AppError.forbidden();
 return c;
}
export async function listProducts(db:Db,t:TenantContext,n:number) {
 const [rows]=await db.execute<RowDataPacket[]>(`SELECT id,sku,name,item_type,unit,list_price,currency,tax_rate FROM crm_products WHERE company_id=? AND active=1 ORDER BY id DESC LIMIT ?`,[t.companyId,n]);
 return rows.map(r=>({id:dbId(r.id),sku:r.sku,name:r.name,itemType:r.item_type,unit:r.unit,price:String(r.list_price),currency:r.currency,taxRate:String(r.tax_rate)}));
}
export async function createProduct(db:Db,t:TenantContext,v:ReturnType<typeof import("../schemas/sales.schema").parseProduct>,rid:string|null) {
 const currency=await companyCurrency(db,t);
 const [r]=await db.execute<ResultSetHeader>(`INSERT INTO crm_products(company_id,sku,name,item_type,unit,list_price,currency,tax_rate) VALUES(?,?,?,?,?,?,?,?)`,[t.companyId,v.sku,v.name,v.itemType,v.unit,v.price,currency,v.taxRate]);
 const productId=dbId(r.insertId);await audit(db,t,"product.created","product",productId,{itemType:v.itemType},rid);
 return {id:productId,...v,currency};
}
async function approvedStage(db:Db,t:TenantContext,pipelineId:string,stageId:string) {
 const [stages]=await db.execute<Row[]>(`SELECT s.id,s.stage_type FROM pipeline_stages s JOIN pipelines p ON p.company_id=s.company_id AND p.id=s.pipeline_id WHERE s.company_id=? AND s.pipeline_id=? AND s.id=? AND p.active=1 LIMIT 1 FOR UPDATE`,[t.companyId,pipelineId,stageId]);
 if(!stages[0])throw AppError.badRequest();
 return stages[0].stage_type!;
}
export async function createDeal(db:Db,t:TenantContext,v:ReturnType<typeof import("../schemas/sales.schema").parseDeal>,rid:string|null) {
 const lead=await scopedLead(db,t,v.leadId,true);
 const stageType=await approvedStage(db,t,v.pipelineId,v.stageId);
 if(stageType!=="open")throw AppError.badRequest();
 const currency=await companyCurrency(db,t);
 const [r]=await db.execute<ResultSetHeader>(`INSERT INTO deals(company_id,lead_id,pipeline_id,stage_id,owner_user_id,title,expected_amount,currency,expected_close_date) VALUES(?,?,?,?,?,?,?,?,?)`,[t.companyId,v.leadId,v.pipelineId,v.stageId,lead.ownerUserId,v.title,v.amount,currency,v.expectedCloseDate]);
 const dealId=dbId(r.insertId);
 await audit(db,t,"deal.created","deal",dealId,{leadId:v.leadId,pipelineId:v.pipelineId},rid);
 return {id:dealId,ownerUserId:lead.ownerUserId,pipelineId:v.pipelineId,stageId:v.stageId};
}
/** STEP13Y3_CUSTOMER_ACCOUNT_PROJECTION: Authorized deal or its linked lead account. */
export async function listDeals(db:Db,t:TenantContext,n:number) {
 const sc=ownerClause(t,"d");
 const [rows]=await db.execute<RowDataPacket[]>(`SELECT d.id,COALESCE(d.account_id,l.account_id,dc.account_id,lc.account_id) AS account_id,d.contact_id,d.lead_id,d.title,d.expected_amount,d.currency,d.owner_user_id,d.pipeline_id,d.stage_id,s.name AS stage_name,s.stage_type FROM deals d LEFT JOIN leads l ON l.company_id=d.company_id AND l.id=d.lead_id
 LEFT JOIN contacts dc ON dc.company_id=d.company_id AND dc.id=d.contact_id
 LEFT JOIN contacts lc ON lc.company_id=l.company_id AND lc.id=l.contact_id JOIN pipeline_stages s ON s.company_id=d.company_id AND s.pipeline_id=d.pipeline_id AND s.id=d.stage_id WHERE d.company_id=? AND ${sc.sql} ORDER BY d.id DESC LIMIT ?`,[t.companyId,...sc.args,n]);
 return rows.map(r=>({id:dbId(r.id),accountId:r.account_id==null?null:dbId(r.account_id),contactId:r.contact_id==null?null:dbId(r.contact_id),leadId:r.lead_id==null?null:dbId(r.lead_id),title:r.title,amount:String(r.expected_amount),currency:r.currency,ownerUserId:dbId(r.owner_user_id),pipelineId:dbId(r.pipeline_id),stageId:dbId(r.stage_id),stageName:r.stage_name,stageType:r.stage_type}));
}
export async function updateStage(db:Db,t:TenantContext,dealId:string,v:ReturnType<typeof import("../schemas/sales.schema").parseStage>,rid:string|null) {
 const before=await visibleDeal(db,t,dealId,true);
 if(before.revision!==v.expectedRevision)throw AppError.conflict();
 if(before.stageType==="won"||before.stageType==="lost")throw AppError.conflict();
 if(before.stageId===v.stageId)throw AppError.conflict();
 const next=await approvedStage(db,t,before.pipelineId,v.stageId);
 if(next==="won" && scaled(before.amount,2)===0n)throw AppError.badRequest();
 const [r]=await db.execute<ResultSetHeader>(`UPDATE deals SET stage_id=?,closed_at=CASE WHEN ? IN ('won','lost') THEN UTC_TIMESTAMP(3) ELSE NULL END,updated_at=GREATEST(DATE_ADD(updated_at,INTERVAL 1000 MICROSECOND),UTC_TIMESTAMP(3)) WHERE company_id=? AND id=? AND stage_id=?`,[v.stageId,next,t.companyId,dealId,before.stageId]);
 if(r.affectedRows!==1)throw AppError.conflict();
 await audit(db,t,"deal.stage_changed","deal",dealId,{previousStageId:before.stageId,nextStageId:v.stageId,nextType:next},rid);
 return {id:dealId,previousStageId:before.stageId,stageId:v.stageId,stageType:next};
}
export async function createQuote(db:Db,t:TenantContext,v:ReturnType<typeof import("../schemas/sales.schema").parseQuote>,rid:string|null) {
 const deal=await visibleDeal(db,t,v.dealId,true);
 if(deal.stageType!=="open")throw AppError.conflict();
 const quoteNo=`Q-${randomUUID().replace(/-/g,"").slice(0,24)}`;
 const [created]=await db.execute<ResultSetHeader>(`INSERT INTO crm_quotations(company_id,quote_no,deal_id,created_by_id,status,currency,valid_until) VALUES(?,?,?,?,'draft',?,?)`,[t.companyId,quoteNo,v.dealId,t.actorUserId,deal.currency??"INR",v.validUntil]);
 const quoteId=dbId(created.insertId);
 const [revision]=await db.execute<ResultSetHeader>(`INSERT INTO crm_quotation_revisions(company_id,quotation_id,revision_no,subtotal,discount_total,tax_total,grand_total,status,created_by_id) VALUES(?,?,1,?,?,?,?,'draft',?)`,[t.companyId,quoteId,v.subtotal,v.discountAmount,v.taxes,v.grandTotal,t.actorUserId]);
 const revisionId=dbId(revision.insertId);
 for(const line of v.items){
  await db.execute(`INSERT INTO crm_quotation_items(company_id,revision_id,description,quantity,unit_price,tax_rate,line_total) VALUES(?,?,?,?,?,?,?)`,[t.companyId,revisionId,line.description,line.quantity,line.unitPrice,line.taxRate,decimal(line.net,2)]);
 }
 await audit(db,t,"quote.draft_created","quotation",quoteId,{dealId:v.dealId,revisionNo:1,itemCount:v.items.length},rid);
 return {id:quoteId,quoteNo,revisionId,revisionNo:1,subtotal:v.subtotal,taxTotal:v.taxes,grandTotal:v.grandTotal,currency:deal.currency};
}
export async function getQuote(db:Db,t:TenantContext,quoteId:string){
 const [q]=await db.execute<RowDataPacket[]>(`SELECT id,deal_id,quote_no,status,currency,valid_until FROM crm_quotations WHERE company_id=? AND id=? LIMIT 1`,[t.companyId,quoteId]);
 const quote=q[0];if(!quote||!quote.deal_id)throw AppError.notFound();
 await visibleDeal(db,t,dbId(quote.deal_id));
 const [revisions]=await db.execute<RowDataPacket[]>(`SELECT id,revision_no,subtotal,discount_total,tax_total,grand_total,status FROM crm_quotation_revisions WHERE company_id=? AND quotation_id=? ORDER BY revision_no DESC LIMIT 1`,[t.companyId,quoteId]);
 const rev=revisions[0];if(!rev)throw AppError.notFound();
 const [items]=await db.execute<RowDataPacket[]>(`SELECT description,quantity,unit_price,tax_rate,line_total FROM crm_quotation_items WHERE company_id=? AND revision_id=? ORDER BY id LIMIT 50`,[t.companyId,dbId(rev.id)]);
 return {id:quoteId,quoteNo:quote.quote_no,dealId:dbId(quote.deal_id),status:quote.status,currency:quote.currency,validUntil:quote.valid_until,revisionNo:rev.revision_no,subtotal:String(rev.subtotal),discountTotal:String(rev.discount_total),taxTotal:String(rev.tax_total),grandTotal:String(rev.grand_total),items:items.map(x=>({description:x.description,quantity:String(x.quantity),unitPrice:String(x.unit_price),taxRate:String(x.tax_rate),lineTotal:String(x.line_total)}))};
}
export async function pipelineInsights(db:Db,t:TenantContext){
 const sc=ownerClause(t,"d");
 const [rows]=await db.execute<RowDataPacket[]>(`SELECT d.pipeline_id,d.stage_id,s.name,s.stage_type,COUNT(*) AS total,CAST(SUM(d.expected_amount) AS CHAR) AS amount FROM deals d JOIN pipeline_stages s ON s.company_id=d.company_id AND s.pipeline_id=d.pipeline_id AND s.id=d.stage_id WHERE d.company_id=? AND ${sc.sql} GROUP BY d.pipeline_id,d.stage_id,s.name,s.stage_type ORDER BY d.pipeline_id,s.position LIMIT 500`,[t.companyId,...sc.args]);
 return rows.map(x=>({pipelineId:dbId(x.pipeline_id),stageId:dbId(x.stage_id),stageName:x.name,stageType:x.stage_type,count:Number(x.total),expectedAmount:String(x.amount)}));
}

/** Paged persisted quotations, scoped identically to the existing Deals list. No writes. */
/** STEP13Y4_LINK_ACCOUNT: Explicit, audited Manager-only linkage of an unlinked Deal. */
export async function linkDealToCustomerAccount(db:Db,t:TenantContext,dealId:string,accountId:string,rid:string|null) {
  if(t.role!=="MANAGER"||t.accessMode!=="FULL")throw AppError.forbidden();
  // Reuse the established deal/team visibility rule and obtain the transaction lock.
  await visibleDeal(db,t,dealId,true);
  const [accounts]=await db.execute<RowDataPacket[]>(
    `SELECT id,status FROM accounts WHERE company_id=? AND id=? LIMIT 1`,
    [t.companyId,accountId]);
  const account=accounts[0];
  if(!account||String(account.status).toLowerCase()!=="active")throw AppError.notFound();
  const [relationships]=await db.execute<RowDataPacket[]>(
    `SELECT d.account_id AS deal_account_id,
      l.account_id AS lead_account_id, dc.account_id AS deal_contact_account_id,
      lc.account_id AS lead_contact_account_id
      FROM deals d
      LEFT JOIN leads l ON l.company_id=d.company_id AND l.id=d.lead_id
      LEFT JOIN contacts dc ON dc.company_id=d.company_id AND dc.id=d.contact_id
      LEFT JOIN contacts lc ON lc.company_id=l.company_id AND lc.id=l.contact_id
      WHERE d.company_id=? AND d.id=? LIMIT 1 FOR UPDATE`,
    [t.companyId,dealId]);
  const found=relationships[0];
  if(!found)throw AppError.notFound();
  // Reject a conflicting customer reference instead of silently reassigning history.
  for(const key of ["deal_account_id","lead_account_id","deal_contact_account_id","lead_contact_account_id"]){
    const linked=found[key];
    if(linked!==null&&linked!==undefined&&dbId(linked)!==accountId)throw AppError.conflict();
  }
  if(found.deal_account_id!==null&&found.deal_account_id!==undefined){
    return {dealId,accountId,status:"already_linked"};
  }
  const [changed]=await db.execute<ResultSetHeader>(
    `UPDATE deals SET account_id=? WHERE company_id=? AND id=? AND account_id IS NULL`,
    [accountId,t.companyId,dealId]);
  if(changed.affectedRows!==1)throw AppError.conflict();
  await audit(db,t,"deal.customer_account_linked","deal",dealId,{accountId},rid);
  return {dealId,accountId,status:"linked"};
}

export async function listQuotationSummaries(db:Db,t:TenantContext,n:number,before:string|null){
 const sc=ownerClause(t,"d");
 const [rows]=await db.execute<RowDataPacket[]>(`SELECT q.id,q.quote_no,q.deal_id,q.status,q.currency,q.valid_until,
 DATE_FORMAT(q.created_at,'%Y-%m-%dT%H:%i:%s.%f') AS created_at,
 d.title AS deal_title, COALESCE(d.account_id,l.account_id,dc.account_id,lc.account_id) AS customer_account_id, rev.revision_no, CAST(rev.grand_total AS CHAR) AS grand_total
 FROM crm_quotations q
 JOIN deals d ON d.company_id=q.company_id AND d.id=q.deal_id
 LEFT JOIN leads l ON l.company_id=d.company_id AND l.id=d.lead_id
 LEFT JOIN contacts dc ON dc.company_id=d.company_id AND dc.id=d.contact_id
 LEFT JOIN contacts lc ON lc.company_id=l.company_id AND lc.id=l.contact_id
 LEFT JOIN crm_quotation_revisions rev ON rev.company_id=q.company_id AND rev.quotation_id=q.id
 AND rev.revision_no=(SELECT MAX(r2.revision_no) FROM crm_quotation_revisions r2
 WHERE r2.company_id=q.company_id AND r2.quotation_id=q.id)
 WHERE q.company_id=? AND ${sc.sql} ${before?'AND q.id < ?':''}
 ORDER BY q.id DESC LIMIT ?`,[t.companyId,...sc.args,...(before?[before]:[]),n+1]);
 const page=rows.slice(0,n);
 const lastPageRow=page[page.length-1];
 if(page.some(row=>!row.revision_no||row.grand_total===null))throw AppError.conflict();
 return {items:page.map(row=>({id:dbId(row.id),quoteNo:String(row.quote_no),dealId:dbId(row.deal_id),
  dealTitle:String(row.deal_title),accountId:row.customer_account_id==null?null:dbId(row.customer_account_id),status:String(row.status),currency:String(row.currency),
  validUntil:row.valid_until,createdAt:String(row.created_at),
  revisionNo:Number(row.revision_no),grandTotal:String(row.grand_total)})),
  nextCursor:rows.length>n && lastPageRow ? dbId(lastPageRow.id) : null};
}

/** Record a received customer PO against the exact approved quotation revision. */
export async function createCustomerPurchaseOrder(db:Db,t:TenantContext,input:ReturnType<typeof import('../schemas/sales.schema').parseCustomerPurchaseOrder>,rid:string|null){
  const [quotes]=await db.execute<RowDataPacket[]>(`SELECT id,deal_id,status,quote_no,currency FROM crm_quotations WHERE company_id=? AND id=? LIMIT 1 FOR UPDATE`,[t.companyId,input.quotationId]);
  const q=quotes[0];if(!q||!q.deal_id)throw AppError.notFound();
  await visibleDeal(db,t,dbId(q.deal_id),true);
  if(q.status!=='approved')throw AppError.conflict();
  const [revisions]=await db.execute<RowDataPacket[]>(`SELECT id,revision_no,status,subtotal,discount_total,tax_total,grand_total FROM crm_quotation_revisions WHERE company_id=? AND quotation_id=? ORDER BY revision_no DESC LIMIT 1 FOR UPDATE`,[t.companyId,input.quotationId]);
  const r=revisions[0];if(!r||r.status!=='approved')throw AppError.conflict();
  const revisionId=dbId(r.id);
  const [existing]=await db.execute<RowDataPacket[]>(`SELECT id FROM crm_purchase_orders WHERE company_id=? AND quotation_revision_id=? LIMIT 1 FOR UPDATE`,[t.companyId,revisionId]);
  if(existing.length)throw AppError.conflict();
  const [dealRows]=await db.execute<RowDataPacket[]>(`SELECT owner_user_id,account_id,contact_id FROM deals WHERE company_id=? AND id=? LIMIT 1 FOR UPDATE`,[t.companyId,dbId(q.deal_id)]);
  const deal=dealRows[0];if(!deal||!deal.owner_user_id)throw AppError.notFound();
  const orderNo='CPO-'+randomUUID().replace(/-/g,'').slice(0,24);
  const [created]=await db.execute<ResultSetHeader>(`INSERT INTO crm_purchase_orders(company_id,order_no,customer_po_number,customer_po_date,received_at,buyer_document_key,quotation_revision_id,contact_id,account_id,owner_user_id,status,currency,order_total) VALUES(?,?,?,?,UTC_TIMESTAMP(3),NULL,?,?,?,?,'received',?,?)`,
    [t.companyId,orderNo,input.customerPoNumber,input.customerPoDate,revisionId,deal.contact_id??null,deal.account_id??null,deal.owner_user_id,q.currency,String(r.grand_total)]);
  const orderId=dbId(created.insertId);
  // Line items preserve original pretax prices; final order total uses the revision's discount + tax.
  await db.execute(`INSERT INTO crm_purchase_order_items(company_id,order_id,product_id,description,quantity,unit_price,line_total)
    SELECT ?,?,qi.product_id,qi.description,qi.quantity,qi.unit_price,qi.line_total FROM crm_quotation_items qi
    WHERE qi.company_id=? AND qi.revision_id=? ORDER BY qi.id`,[t.companyId,orderId,t.companyId,revisionId]);
  await audit(db,t,'customer_po.recorded','purchase_order',orderId,{quotationId:input.quotationId,revisionNo:r.revision_no,customerPoNumber:input.customerPoNumber},rid);
  return {id:orderId,orderNo,customerPoNumber:input.customerPoNumber,customerPoDate:input.customerPoDate,
    quotationId:input.quotationId,revisionNo:Number(r.revision_no),status:'received',currency:String(q.currency),orderTotal:String(r.grand_total)};
}

/** List uses the existing ownerClause used for Opportunity list; no cross-team disclosure. */
export async function listCustomerPurchaseOrders(db:Db,t:TenantContext,n:number,before:string|null){
  const sc=ownerClause(t,'d');
  const args: Array<string|number>=[t.companyId,...sc.args];
  const beforeSql=before?' AND po.id < ?':'';
  if(before)args.push(before);
  args.push(n+1);
  const [rows]=await db.execute<RowDataPacket[]>(`SELECT po.id,po.order_no,po.customer_po_number,DATE_FORMAT(po.customer_po_date,'%Y-%m-%d') AS customer_po_date,
    po.status,po.currency,po.order_total,po.created_at,q.id AS quotation_id,q.quote_no,r.revision_no,d.title AS deal_title
    FROM crm_purchase_orders po
    JOIN crm_quotation_revisions r ON r.company_id=po.company_id AND r.id=po.quotation_revision_id
    JOIN crm_quotations q ON q.company_id=r.company_id AND q.id=r.quotation_id
    JOIN deals d ON d.company_id=q.company_id AND d.id=q.deal_id
    WHERE po.company_id=? AND ${sc.sql}${beforeSql} ORDER BY po.id DESC LIMIT ?`,args);
  const page=rows.slice(0,n),last=page.length?page[page.length-1]:undefined;
  return {items:page.map(row=>({id:dbId(row.id),orderNo:String(row.order_no),customerPoNumber:String(row.customer_po_number),
    customerPoDate:String(row.customer_po_date),status:String(row.status),currency:String(row.currency),orderTotal:String(row.order_total),
    quotationId:dbId(row.quotation_id),quoteNo:String(row.quote_no),revisionNo:Number(row.revision_no),dealTitle:String(row.deal_title),
    createdAt:row.created_at instanceof Date?row.created_at.toISOString():String(row.created_at)})),
    nextCursor:rows.length>n&&last?dbId(last.id):null};
}

/** Detail always checks current Deal visibility before returning commercial data. */
export async function getCustomerPurchaseOrder(db:Db,t:TenantContext,orderId:string){
  const [rows]=await db.execute<RowDataPacket[]>(`SELECT po.id,po.order_no,po.customer_po_number,DATE_FORMAT(po.customer_po_date,'%Y-%m-%d') AS customer_po_date,
    po.received_at,po.created_at,po.status,po.currency,po.order_total,
    q.id AS quotation_id,q.quote_no,q.deal_id,r.id AS revision_id,r.revision_no,r.subtotal,r.discount_total,r.tax_total,d.title AS deal_title
    FROM crm_purchase_orders po
    JOIN crm_quotation_revisions r ON r.company_id=po.company_id AND r.id=po.quotation_revision_id
    JOIN crm_quotations q ON q.company_id=r.company_id AND q.id=r.quotation_id
    JOIN deals d ON d.company_id=q.company_id AND d.id=q.deal_id
    WHERE po.company_id=? AND po.id=? LIMIT 1`,[t.companyId,orderId]);
  const row=rows[0];if(!row||!row.deal_id)throw AppError.notFound();
  await visibleDeal(db,t,dbId(row.deal_id));
  const [items]=await db.execute<RowDataPacket[]>(`SELECT description,quantity,unit_price,line_total FROM crm_purchase_order_items
    WHERE company_id=? AND order_id=? ORDER BY id LIMIT 26`,[t.companyId,orderId]);
  return {id:orderId,orderNo:String(row.order_no),customerPoNumber:String(row.customer_po_number),
    customerPoDate:String(row.customer_po_date),receivedAt:row.received_at instanceof Date?row.received_at.toISOString():null,
    status:String(row.status),currency:String(row.currency),orderTotal:String(row.order_total),
    quotationId:dbId(row.quotation_id),quoteNo:String(row.quote_no),revisionNo:Number(row.revision_no),dealTitle:String(row.deal_title),
    createdAt:row.created_at instanceof Date?row.created_at.toISOString():String(row.created_at),
    subtotal:String(row.subtotal),discountTotal:String(row.discount_total),taxTotal:String(row.tax_total),
    items:items.map(x=>({description:String(x.description),quantity:String(x.quantity),unitPrice:String(x.unit_price),lineTotal:String(x.line_total)}))};
}
