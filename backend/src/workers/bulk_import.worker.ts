// Separate bounded background worker. Never auto-started from the CRM API server.
import {getDbPool} from '../core/database/pool';
import {createBulkImportService} from '../modules/bulk_import/bulk_import.service';

async function main(){
 if(process.env.CRM_BULK_IMPORT_WORKER_ENABLED!=='true')throw Error('Bulk import worker disabled; set CRM_BULK_IMPORT_WORKER_ENABLED=true to opt in');
 const mode=process.argv[2];if(mode!=='--once'&&mode!=='--watch')throw Error('Use --once or --watch');
 const service=createBulkImportService();
 try{
  do{
   const result=await service.tick(20);
   console.log(JSON.stringify({event:'crm.bulk_import.tick',...result}));
   if(mode==='--once')break;
   await new Promise<void>(resolve=>setTimeout(resolve,30000));
  }while(true);
 }finally{await getDbPool().end();}
}
main().catch(err=>{console.error('Bulk import worker failed:',err instanceof Error?err.message:'unknown');process.exitCode=1;});