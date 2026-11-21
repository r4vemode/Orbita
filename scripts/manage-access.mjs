import {fileURLToPath} from 'node:url';
import {createAccounts} from '../lib/accounts.mjs';
import {checkStorage} from '../lib/operations.mjs';
import {telegramLoginConfiguration} from '../lib/telegram-admin/login.mjs';
// admin <email>            — назначить администратором зарегистрированный аккаунт
// create-admin <email>     — создать администратора (или сбросить ему пароль).
//   Пароль не передаётся аргументом (он попал бы в историю shell): задайте
//   ORBITA_ADMIN_PASSWORD или введите его в stdin.
const [command,email,telegramId,...extra]=process.argv.slice(2);
if(!['admin','create-admin','admin-telegram','admin-telegram-off'].includes(command)||!email||extra.length||Boolean(telegramId)!==(command==='admin-telegram')){
 console.error('Команды:\n  node scripts/manage-access.mjs admin owner@example.com\n  node scripts/manage-access.mjs admin-telegram owner@example.com 123456789\n  node scripts/manage-access.mjs admin-telegram-off owner@example.com\n  ORBITA_ADMIN_PASSWORD=... node scripts/manage-access.mjs create-admin owner@example.com');
 process.exit(1);
}
async function readPassword(){
 if(process.env.ORBITA_ADMIN_PASSWORD)return process.env.ORBITA_ADMIN_PASSWORD;
 if(process.stdin.isTTY)process.stderr.write('Пароль администратора: ');
 let data='';for await(const chunk of process.stdin)data+=chunk;return data.replace(/\r?\n$/,'');
}
try{
 const directory=process.env.ORBITA_DATA_DIR||fileURLToPath(new URL('../data/',import.meta.url)),storage=await checkStorage({directory,publicDir:fileURLToPath(new URL('../public/',import.meta.url)),requirePrivate:true,rejectSymlinks:true});
 if(!storage.ok&&!(command==='create-admin'&&storage.code==='DATA_DIR_MISSING'))throw Error('Проверьте приватный каталог ORBITA_DATA_DIR: '+storage.code);
 const accounts=await createAccounts(directory);
 if(command==='admin'){const user=await accounts.promote(email);console.log(`Администратор назначен: ${user.email}. Подписки управляются в /admin.html после входа.`);}
 else if(command==='admin-telegram'){
  if(!telegramLoginConfiguration().enabled)throw Error('Включите TELEGRAM_ADMIN_LOGIN_ENABLED и задайте токен бота.');
  const user=await accounts.promote(email,{telegramId});
  console.log(`Администратор ${user.email} привязан для входа через Telegram. Откройте личный чат с ботом и нажмите «Старт».`);
 }
 else if(command==='admin-telegram-off'){
  const user=await accounts.removeAdminTelegram(email);
  console.log(`Привязка для входа через Telegram снята у ${user.email}.`);
 }
 else{const user=await accounts.createAdmin(email,await readPassword());console.log(`${user.created?'Создан администратор':'Пароль администратора обновлён'}: ${user.email}. Вход через /account.html.`);}
}catch(cause){console.error('Не удалось выполнить команду: '+(cause?.message||'ошибка')+'. Проверьте email, пароль (10–128 символов) и каталог ORBITA_DATA_DIR вне public.');process.exitCode=1;}
