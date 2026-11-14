// Standalone worker: NEVER auto-start this in the CRM web/API server.
// Run intentionally with CRM_NOTIFICATION_WORKER_ENABLED=true and --once or --watch.
import {getDbPool} from '../core/database/pool';
import {createAutomationService} from '../modules/automation/automation.service';

async function main():Promise<void>{
 if(process.env.CRM_NOTIFICATION_WORKER_ENABLED!=='true'){
  throw Error('Set CRM_NOTIFICATION_WORKER_ENABLED=true to enable database-writing background worker');
 }
 const args=process.argv.slice(2);
 const mode=args.includes('--once')?'once':args.includes('--watch')?'watch':null;
 if(!mode||args.some(x=>x!=='--once'&&x!=='--watch'&&!x.startsWith('--interval-sec='))||
   (args.includes('--once')&&args.includes('--watch'))){
  throw Error('Usage: reminder.worker.js --once | --watch [--interval-sec=60]');
 }
 const intervalArg=args.find(x=>x.startsWith('--interval-sec='));
 const raw=intervalArg?.slice('--interval-sec='.length)??'60';
 if(!/^[1-9][0-9]{0,3}$/.test(raw)||Number(raw)<15||Number(raw)>3600){
  throw Error('interval-sec must be between 15 and 3600');
 }
 const service=createAutomationService();
 let stopping=false;
 process.once('SIGINT',()=>{stopping=true;});
 process.once('SIGTERM',()=>{stopping=true;});
 try{
  do{
   try{
    const report=await service.tick(100);
    console.log(JSON.stringify({event:'crm.notification_worker.tick',...report}));
   }catch(error){
    // Avoid logging SQL values or notification bodies.
    console.error(JSON.stringify({event:'crm.notification_worker.error',message:'Cycle failed; check server logs'}));
    if(mode==='once')throw error;
   }
   if(mode==='once'||stopping)break;
   const deadline=Date.now()+Number(raw)*1000;
   while(!stopping&&Date.now()<deadline){
    await new Promise<void>(resolve=>setTimeout(resolve,Math.min(1000,deadline-Date.now())));
   }
  }while(!stopping);
 }finally{await getDbPool().end();}
}
main().catch(()=>{process.exitCode=1;});