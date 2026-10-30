import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {checkStorage,checkLegalPublication,inspectConfiguration} from '../lib/operations.mjs';
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
const legal=await checkLegalPublication(directory);
let backupStorage=null;
if(configuration.checks.find(check=>check.name==='ENCRYPTED_BACKUPS')?.status==='pass')backupStorage=await checkStorage({directory:path.resolve(process.env.ORBITA_BACKUP_DIR),publicDir,write:true,validate:false,requirePrivate:production,rejectSymlinks:production});
const labels={pass:'✓',warn:'!',fail:'✗'},reasons={supported:'версия Node.js соответствует минимуму; используйте актуальный LTS-релиз',requires_node_22:'нужен Node.js 22 или новее; рекомендуется 24 LTS',exact_proxy_ips:'заданы точные IP доверенных прокси',proxy_ips_required_before_deploy:'перед размещением укажите IP доверенного HTTPS-прокси',invalid_proxy_ips:'нужны отдельные IPv4/IPv6-адреса без масок и имён',missing:'не настроено',https_origin:'корректный HTTPS-адрес',invalid_https_origin:'нужен точный внешний HTTPS-origin',missing_or_invalid:'не задан или имеет неверный формат',valid:'формат корректен',configured:'настроено',partial_configuration:'заполнена только часть связанных переменных',invalid_boolean:'допустимы true/false или 1/0',must_be_explicit:'явно укажите false перед продажами',test_mode_enabled:'включён тестовый режим',test_mode:'тестовый режим',live_or_default:'рабочий режим',invalid_sender:'неверный адрес отправителя',true_required:'для рабочей среды требуется true',enabled:'включено',disabled:'отключено',passphrase_too_short:'фраза резервной копии короче 16 символов',backup_overlaps_data:'каталог копий пересекается с данными',backup_overlaps_public:'каталог копий находится в публичной области',optional_not_configured:'необязательно, пока отключено',invalid_format:'неверный формат',ok:'чтение, целостность и атомарная запись проверены',DATA_DIR_PERMISSIONS:'каталог доступен группе или другим пользователям',DIRECTORY_SYMLINK:'путь содержит символическую ссылку'};
Object.assign(reasons,{live_payments_enabled:'приём рабочих оплат явно включён оператором',live_payments_disabled:'рабочие оплаты пока не разрешены',receipts_operator_confirmed:'оператор подтвердил порядок выдачи чеков; фактическая доставка этой командой не проверяется',receipts_unconfirmed:'порядок выдачи чеков ещё не подтверждён оператором',legal_published:'есть опубликованная редакция документов',legal_missing:'документы ещё не подготовлены',legal_unpublished:'есть только черновик документов',legal_invalid:'хранилище документов повреждено или имеет неверный формат',legal_unavailable:'не удалось прочитать хранилище документов'});
Object.assign(reasons,{radar_disabled:'модуль отключён',radar_sources_off:'опрос источников отключён; доступна сохранённая история',radar_demo:'включён явно учебный источник',radar_live_configured:'настройки корректны; реальное получение проверьте в редакции Radar',invalid_radar_configuration:'неверные флаги, тарифы или параметры источников Radar'});
console.log(`ORBITA preflight · ${production?'перед запуском продаж':'локальная/тестовая среда'}`);
for(const check of configuration.checks)console.log(`${labels[check.status]} ${check.name}: ${reasons[check.reason]||check.reason}`);
const storageStatus=storage.ok?'pass':'fail',storageReason=storage.ok?'ok':storage.store?`${storage.code} (${storage.store})`:storage.code;
console.log(`${labels[storageStatus]} ORBITA_DATA_DIR: ${reasons[storageReason]||storageReason}`);
if(backupStorage){const status=backupStorage.ok?'pass':'fail',reason=backupStorage.ok?'ok':backupStorage.code;console.log(`${labels[status]} ORBITA_BACKUP_DIR: ${reasons[reason]||reason}`);}
const legalStatus=legal.ok?'pass':production?'fail':'warn';console.log(`${labels[legalStatus]} LEGAL_DOCUMENTS: ${reasons[legal.reason]||legal.reason}`);
const failed=!configuration.ok||!storage.ok||(backupStorage&&!backupStorage.ok)||(production&&!legal.ok),warnings=configuration.checks.filter(check=>check.status==='warn').length+(legalStatus==='warn'?1:0);
console.log(failed?`Проверка не пройдена. Ошибок: ${configuration.checks.filter(check=>check.status==='fail').length+(storage.ok?0:1)+(backupStorage&&!backupStorage.ok?1:0)+(production&&!legal.ok?1:0)}.`:`Проверка пройдена${warnings?`; предупреждений: ${warnings}`:''}.`);
if(failed)process.exitCode=1;
