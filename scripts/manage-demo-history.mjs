import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkStorage} from '../lib/operations.mjs';
import {getDemoHistoryStatus,importDemoHistory,loadDemoHistoryFixture,rollbackDemoHistory} from '../lib/demo-history.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
const usage='Использование: node scripts/manage-demo-history.mjs import [файл.json] | status | rollback [ревизия]';
async function main(args){
  if(args.length===1&&['--help','-h'].includes(args[0])){console.log(usage);return;}
  const [command='import',argument,...rest]=args;
  if(!['import','status','rollback'].includes(command)||rest.length||(command==='status'&&argument!==undefined)||(command==='rollback'&&argument!==undefined&&!/^\d+$/.test(argument)))throw Error(usage);

  const directory=path.resolve(process.env.ORBITA_DATA_DIR||path.join(project,'data'));
  const storage=await checkStorage({directory,publicDir:path.join(project,'public'),write:false,validate:false,requirePrivate:true});
  if(!storage.ok)throw Error('Проверьте приватный каталог ORBITA_DATA_DIR: '+storage.code);
  let result;
  if(command==='status')result=await getDemoHistoryStatus(directory);
  else if(command==='rollback')result=await rollbackDemoHistory(directory,argument===undefined?undefined:Number(argument));
  else result=await importDemoHistory(directory,await loadDemoHistoryFixture(argument===undefined?undefined:path.resolve(argument)));
  console.log(JSON.stringify(result,null,2));
}

main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
