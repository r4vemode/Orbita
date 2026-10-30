import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {mkdir,realpath,lstat} from 'node:fs/promises';
import {createRadar} from '../lib/radar/service.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
export async function seedRadar(args=process.argv.slice(2)){
  if(args.length){if(args.length===1&&args[0]==='--help'){console.log('npm run seed:radar\nДобавляет явно учебные события в пустое или учебное хранилище. Не запускайте на рабочей базе. ORBITA_DATA_DIR задаёт отдельный приватный каталог.');return;}throw Error('Допустим только параметр --help.');}
  if(process.env.ORBITA_PUBLIC_ORIGIN||process.env.NODE_ENV==='production')throw Error('Учебное наполнение разрешено только в локальной среде без публичного origin.');
  const configured=path.resolve(process.env.ORBITA_DATA_DIR||path.join(project,'data')),publicDir=await realpath(path.join(project,'public'));
  let parent=path.parse(configured).root;for(const segment of configured.slice(parent.length).split(path.sep).filter(Boolean)){parent=path.join(parent,segment);try{if((await lstat(parent)).isSymbolicLink())throw Error('Символические ссылки в пути данных не поддерживаются.');}catch(cause){if(cause.code!=='ENOENT')throw cause;}}
  await mkdir(configured,{recursive:true,mode:0o700});const directory=await realpath(configured);
  if(directory===publicDir||directory.startsWith(publicDir+path.sep))throw Error('Каталог данных должен находиться вне public.');
  const radar=await createRadar(directory,{accounts:{identify:async()=>null,checkRequest:()=>{}},env:{RADAR_PROVIDER_MODE:'off'}});
  try{const result=await radar.seedDemo();console.log(`Radar: добавлено учебных событий ${result.inserted}, повторов ${result.duplicates}. Реальные источники не подключены.`);}finally{await radar.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))try{await seedRadar();}catch{console.error('Не удалось наполнить Radar. Используйте отдельную локальную базу без рабочих публикаций и проверьте доступ к каталогу.');process.exitCode=1;}
