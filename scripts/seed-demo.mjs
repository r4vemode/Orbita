import {fileURLToPath} from 'node:url';
import {createIdeas} from '../lib/ideas.mjs';
import {checkStorage} from '../lib/operations.mjs';

const directory=process.env.ORBITA_DATA_DIR||fileURLToPath(new URL('../data/',import.meta.url));
try{
  if(process.env.ORBITA_PUBLIC_ORIGIN||process.env.NODE_ENV==='production')throw Error('Учебное наполнение разрешено только в локальной среде без публичного origin.');
  const storage=await checkStorage({directory,publicDir:fileURLToPath(new URL('../public/',import.meta.url)),requirePrivate:true,rejectSymlinks:true});
  if(!storage.ok)throw Error('Проверьте приватный каталог ORBITA_DATA_DIR вне public.');
  const store=await createIdeas(directory);
  const result=await store.importDemo({id:'local-demo-cli',role:'admin'});
  console.log(`Учебные идеи импортированы: ${result.imported}. Ревизия: ${result.revision}.`);
  console.log('Это вымышленные примеры. Импорт выполняется только этой явной командой или администратором.');
}catch(error){console.error(error.message);process.exitCode=1}
