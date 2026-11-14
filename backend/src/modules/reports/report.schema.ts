import {AppError} from '../../core/errors/AppError';
function date(value:unknown):string{
 if(typeof value!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value))throw AppError.badRequest();
 const d=new Date(`${value}T00:00:00.000Z`);
 if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==value)throw AppError.badRequest();
 return value;
}
export function period(query:Record<string,unknown>):{from:string;to:string;days:number}{
 if(Object.keys(query).some(k=>!['from','to'].includes(k)))throw AppError.badRequest();
 if((query.from===undefined)!==(query.to===undefined))throw AppError.badRequest();
 const now=new Date();
 const to=date(query.to??now.toISOString().slice(0,10));
 const previous=new Date(Date.parse(`${to}T00:00:00Z`)-29*86400000).toISOString().slice(0,10);
 const from=date(query.from??previous);
 const days=Math.round((Date.parse(`${to}T00:00:00Z`)-Date.parse(`${from}T00:00:00Z`))/86400000)+1;
 if(days<1||days>93)throw AppError.badRequest();
 return {from,to,days};
}
