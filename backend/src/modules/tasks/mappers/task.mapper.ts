import type {TaskRow} from '../repositories/task.repository';

function date(value:Date|string|null):string|null {
 if(value===null)return null;
 if(value instanceof Date)return value.toISOString();
 if(typeof value==='string')return value.includes('T')?value:value.replace(' ','T')+'Z';
 return String(value);
}
export function taskView(row:TaskRow){
 return {
  id:String(row.id), title:row.title, description:row.description,
  ownerUserId:String(row.owner_user_id),
  dealId:row.deal_id===null?null:String(row.deal_id),
  contactId:row.contact_id===null?null:String(row.contact_id),
  status:row.status,priority:row.priority,
  dueAt:date(row.due_at),completedAt:date(row.completed_at),
  revision:row.revision,
 };
}
