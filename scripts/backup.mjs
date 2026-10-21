import {fileURLToPath} from 'node:url';
import {createBackup,listBackups,verifyBackup,restoreBackup} from '../lib/backups.mjs';

async function main(){
  const [command,...arguments_]=process.argv.slice(2),options={};
  if(!['create','list','verify','restore'].includes(command))throw Error('Использование: node scripts/backup.mjs create|list|verify|restore [--directory PATH] [--data-dir PATH] [--file FILE] [--restore EMPTY_DIRECTORY] [--keep N]');
  for(let index=0;index<arguments_.length;index+=2){const flag=arguments_[index],value=arguments_[index+1];if(!['--directory','--data-dir','--file','--restore','--keep'].includes(flag)||!value||value.startsWith('--')||Object.hasOwn(options,flag))throw Error('Некорректные параметры команды резервного копирования.');options[flag]=value;}
  const passphrase=process.env.ORBITA_BACKUP_PASSPHRASE;
  if(typeof passphrase!=='string'||passphrase.length<16||passphrase.length>4096)throw Error('Задайте ORBITA_BACKUP_PASSPHRASE: от 16 до 4096 символов. Пароль не передаётся в аргументах командной строки.');
  const dataDir=options['--data-dir']||process.env.ORBITA_DATA_DIR||fileURLToPath(new URL('../data/',import.meta.url));
  const backupDir=options['--directory']||process.env.ORBITA_BACKUP_DIR;
  if(command==='create'){
    if(options['--file']||options['--restore'])throw Error('Создание не принимает --file или --restore.');
    const keep=options['--keep']===undefined?undefined:Number(options['--keep']);
    const result=await createBackup({dataDir,backupDir,passphrase,keep});
    console.log(JSON.stringify({file:result.file,createdAt:result.createdAt,files:result.files.length,bytes:result.bytes,skipped:result.skipped,retention:result.retention},null,2));
  }else if(command==='list'){
    if(options['--file']||options['--restore']||options['--keep'])throw Error('Список не принимает --file, --restore или --keep.');
    console.log(JSON.stringify(await listBackups({backupDir,dataDir}),null,2));
  }else{
    if(options['--keep']||options['--directory'])throw Error('Проверка и восстановление принимают --file и, для восстановления, --restore.');
    if(!options['--file'])throw Error('Укажите --file FILE.');
    if(command==='verify'){if(options['--restore'])throw Error('Для восстановления используйте команду restore.');console.log(JSON.stringify(await verifyBackup({file:options['--file'],passphrase}),null,2));}
    else console.log(JSON.stringify(await restoreBackup({file:options['--file'],destination:options['--restore'],passphrase}),null,2));
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
