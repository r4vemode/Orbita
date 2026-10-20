import {fileURLToPath} from 'node:url';
import {createIdeas} from '../lib/ideas.mjs';

const directory=process.env.ORBITA_DATA_DIR||fileURLToPath(new URL('../data/',import.meta.url));
try{
  const store=await createIdeas(directory);
  const result=await store.importDemo({id:'local-demo-cli',role:'admin'});
  console.log(`Учебные идеи импортированы: ${result.imported}. Ревизия: ${result.revision}.`);
  console.log('Это вымышленные примеры. Импорт выполняется только этой явной командой или администратором.');
}catch(error){console.error(error.message);process.exitCode=1}
