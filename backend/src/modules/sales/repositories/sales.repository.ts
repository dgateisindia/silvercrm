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
export async function listDeals(db:Db,t:TenantContext,n:number) {
 const sc=ownerClause(t,"d");
 const [rows]=await db.execute<RowDataPacket[]>(`SELECT d.id,d.title,d.expected_amount,d.currency,d.owner_user_id,d.pipeline_id,d.stage_id,s.name AS stage_name,s.stage_type FROM deals d JOIN pipeline_stages s ON s.company_id=d.company_id AND s.pipeline_id=d.pipeline_id AND s.id=d.stage_id WHERE d.company_id=? AND ${sc.sql} ORDER BY d.id DESC LIMIT ?`,[t.companyId,...sc.args,n]);
 return rows.map(r=>({id:dbId(r.id),title:r.title,amount:String(r.expected_amount),currency:r.currency,ownerUserId:dbId(r.owner_user_id),pipelineId:dbId(r.pipeline_id),stageId:dbId(r.stage_id),stageName:r.stage_name,stageType:r.stage_type}));
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
 const [revision]=await db.execute<ResultSetHeader>(`INSERT INTO crm_quotation_revisions(company_id,quotation_id,revision_no,subtotal,discount_total,tax_total,grand_total,status,created_by_id) VALUES(?,?,1,?,0,?,?,'draft',?)`,[t.companyId,quoteId,v.subtotal,v.taxes,v.grandTotal,t.actorUserId]);
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
 return {id:quoteId,quoteNo:quote.quote_no,dealId:dbId(quote.deal_id),status:quote.status,currency:quote.currency,validUntil:quote.valid_until,revisionNo:rev.revision_no,subtotal:String(rev.subtotal),taxTotal:String(rev.tax_total),grandTotal:String(rev.grand_total),items:items.map(x=>({description:x.description,quantity:String(x.quantity),unitPrice:String(x.unit_price),taxRate:String(x.tax_rate),lineTotal:String(x.line_total)}))};
}
export async function pipelineInsights(db:Db,t:TenantContext){
 const sc=ownerClause(t,"d");
 const [rows]=await db.execute<RowDataPacket[]>(`SELECT d.pipeline_id,d.stage_id,s.name,s.stage_type,COUNT(*) AS total,CAST(SUM(d.expected_amount) AS CHAR) AS amount FROM deals d JOIN pipeline_stages s ON s.company_id=d.company_id AND s.pipeline_id=d.pipeline_id AND s.id=d.stage_id WHERE d.company_id=? AND ${sc.sql} GROUP BY d.pipeline_id,d.stage_id,s.name,s.stage_type ORDER BY d.pipeline_id,s.position LIMIT 500`,[t.companyId,...sc.args]);
 return rows.map(x=>({pipelineId:dbId(x.pipeline_id),stageId:dbId(x.stage_id),stageName:x.name,stageType:x.stage_type,count:Number(x.total),expectedAmount:String(x.amount)}));
}
