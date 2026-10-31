import {readFile,writeFile,rename,rm,lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {validateNews} from '../lib/news.mjs';
import {checkStorage} from '../lib/operations.mjs';

export async function importNews(source,{directory=process.env.ORBITA_DATA_DIR||fileURLToPath(new URL('../data/',import.meta.url)),publicDir=fileURLToPath(new URL('../public/',import.meta.url))}={}){
 const info=await lstat(source);if(!info.isFile()||info.isSymbolicLink()||info.size>1048576)throw Error('Нужен обычный JSON-файл ленты размером до 1 МиБ.');
 const raw=await readFile(source);if(raw.length>1048576)throw Error('Файл ленты превышает 1 МиБ.');
 const items=validateNews(JSON.parse(raw));
 const storage=await checkStorage({directory,publicDir,validate:false,requirePrivate:true,rejectSymlinks:true});
 if(!storage.ok)throw Error('Проверьте приватный каталог ORBITA_DATA_DIR вне public.');
 const target=path.join(directory,'news.json');
 try{const existing=await lstat(target);if(!existing.isFile()||existing.isSymbolicLink())throw Error('Файл ленты должен быть обычным приватным файлом.');}catch(cause){if(cause.code!=='ENOENT')throw cause;}
 const temp=target+'.tmp-'+randomUUID();
 try{await writeFile(temp,JSON.stringify({items}),{mode:0o600,flag:'wx'});await rename(temp,target);}finally{await rm(temp,{force:true});}
 return {imported:items.length};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const source=process.argv[2];
 if(!source||process.argv.length!==3){console.error('Usage: node scripts/import-news.mjs /path/to/approved-feed.json');process.exitCode=1;}
 else try{const result=await importNews(source);console.log(`Imported ${result.imported} news records.`);}catch{console.error('Не удалось импортировать ленту. Проверьте JSON до 1 МиБ и приватный ORBITA_DATA_DIR вне public.');process.exitCode=1;}
}
