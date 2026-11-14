// Separate worker. Never import/start this from the CRM API server.
import {getDbPool} from '../core/database/pool';
import {createWorkforceService} from '../modules/workforce/workforce.service';
async function main():Promise<void>{
 if(process.env.CRM_COVERAGE_WORKER_ENABLED!=='true')throw Error('Set CRM_COVERAGE_WORKER_ENABLED=true explicitly');
 const args=process.argv.slice(2),once=args.includes('--once'),watch=args.includes('--watch');
 if(once===watch||args.some(x=>x!=='--once'&&x!=='--watch'&&!x.startsWith('--interval-sec=')))throw Error('Usage: coverage.worker.js --once | --watch [--interval-sec=60]');
 const raw=args.find(x=>x.startsWith('--interval-sec='))?.split('=')[1]??'60';
 if(!/^[1-9][0-9]{0,3}$/.test(raw)||Number(raw)<15||Number(raw)>3600)throw Error('Interval must be 15-3600 seconds');
 const service=createWorkforceService();let stopping=false;
 process.on('SIGINT',()=>{stopping=true;});process.on('SIGTERM',()=>{stopping=true;});
 try{
  do{
   try{const report=await service.tick(100);console.log(JSON.stringify({event:'crm.coverage_worker.tick',...report}));}
   catch(e){console.error(JSON.stringify({event:'crm.coverage_worker.error',message:'Coverage worker cycle failed'}));if(once)throw e;}
   if(once||stopping)break;
   const until=Date.now()+Number(raw)*1000;
   while(!stopping&&Date.now()<until)await new Promise<void>(resolve=>setTimeout(resolve,Math.min(1000,until-Date.now())));
  }while(!stopping);
 }finally{await getDbPool().end();}
}
main().catch(()=>{process.exitCode=1;});