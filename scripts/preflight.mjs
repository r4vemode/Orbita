import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {checkStorage,inspectConfiguration} from '../lib/operations.mjs';
import {readFile} from 'node:fs/promises';
import {validateProductSettingsDatabase} from '../lib/product-settings.mjs';

const args=new Set(process.argv.slice(2));
if(args.has('--help')){console.log('Usage: npm run preflight -- [--production]');process.exit(0);}
if([...args].some(value=>value!=='--production')){console.error('Неизвестный параметр. Используйте --production для проверки перед запуском продаж.');process.exit(2);}
const production=args.has('--production'),root=fileURLToPath(new URL('../',import.meta.url)),publicDir=path.join(root,'public');
const directory=path.resolve(process.env.ORBITA_DATA_DIR||path.join(root,'data'));
const effectiveEnv={...process.env};
try{const db=JSON.parse(await readFile(path.join(directory,'product-settings.json'),'utf8'));if(validateProductSettingsDatabase(db)&&db.settings.supportEmail)effectiveEnv.ORBITA_SUPPORT_EMAIL=db.settings.supportEmail;}catch{}
const configuration=inspectConfiguration(effectiveEnv,{production,directory,publicDir}),storage=await checkStorage({directory,publicDir,write:true,validate:true,requirePrivate:production});
let backupStorage=null;
if(configuration.checks.find(check=>check.name==='ENCRYPTED_BACKUPS')?.status==='pass')backupStorage=await checkStorage({directory:path.resolve(process.env.ORBITA_BACKUP_DIR),publicDir,write:true,validate:false,requirePrivate:production,rejectSymlinks:production});
const labels={pass:'✓',warn:'!',fail:'✗'},reasons={supported:'Node.js поддерживается',requires_node_20:'нужен Node.js 20 или новее',missing:'не настроено',https_origin:'корректный HTTPS-адрес',invalid_https_origin:'нужен точный внешний HTTPS-origin',missing_or_invalid:'не задан или имеет неверный формат',valid:'формат корректен',configured:'настроено',partial_configuration:'заполнена только часть связанных переменных',invalid_boolean:'допустимы true/false или 1/0',must_be_explicit:'явно укажите false перед продажами',test_mode_enabled:'включён тестовый режим',test_mode:'тестовый режим',live_or_default:'рабочий режим',invalid_sender:'неверный адрес отправителя',true_required:'для рабочей среды требуется true',enabled:'включено',disabled:'отключено',passphrase_too_short:'фраза резервной копии короче 16 символов',backup_overlaps_data:'каталог копий пересекается с данными',backup_overlaps_public:'каталог копий находится в публичной области',optional_not_configured:'необязательно, пока отключено',invalid_format:'неверный формат',ok:'чтение, целостность и атомарная запись проверены',DATA_DIR_PERMISSIONS:'каталог доступен группе или другим пользователям',DIRECTORY_SYMLINK:'путь содержит символическую ссылку'};
console.log(`ORBITA preflight · ${production?'перед запуском продаж':'локальная/тестовая среда'}`);
for(const check of configuration.checks)console.log(`${labels[check.status]} ${check.name}: ${reasons[check.reason]||check.reason}`);
const storageStatus=storage.ok?'pass':'fail',storageReason=storage.ok?'ok':storage.store?`${storage.code} (${storage.store})`:storage.code;
console.log(`${labels[storageStatus]} ORBITA_DATA_DIR: ${reasons[storageReason]||storageReason}`);
if(backupStorage){const status=backupStorage.ok?'pass':'fail',reason=backupStorage.ok?'ok':backupStorage.code;console.log(`${labels[status]} ORBITA_BACKUP_DIR: ${reasons[reason]||reason}`);}
const failed=!configuration.ok||!storage.ok||(backupStorage&&!backupStorage.ok),warnings=configuration.checks.filter(check=>check.status==='warn').length;
console.log(failed?`Проверка не пройдена. Ошибок: ${configuration.checks.filter(check=>check.status==='fail').length+(storage.ok?0:1)+(backupStorage&&!backupStorage.ok?1:0)}.`:`Проверка пройдена${warnings?`; предупреждений: ${warnings}`:''}.`);
if(failed)process.exitCode=1;
