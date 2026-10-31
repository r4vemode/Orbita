import {fileURLToPath} from 'node:url';
import {createAccounts} from '../lib/accounts.mjs';
import {checkStorage} from '../lib/operations.mjs';
const [command,email]=process.argv.slice(2);
if(command!=='admin'||!email){console.error('Usage: node scripts/manage-access.mjs admin owner@example.com');process.exit(1);}
try{const directory=process.env.ORBITA_DATA_DIR||fileURLToPath(new URL('../data/',import.meta.url)),storage=await checkStorage({directory,publicDir:fileURLToPath(new URL('../public/',import.meta.url)),requirePrivate:true,rejectSymlinks:true});if(!storage.ok)throw Error('Проверьте приватный каталог ORBITA_DATA_DIR: '+storage.code);const accounts=await createAccounts(directory);const user=await accounts.promote(email);console.log(`Администратор назначен: ${user.email}. Подписки управляются в /admin.html после входа.`);}catch{console.error('Не удалось назначить администратора. Проверьте зарегистрированную почту и приватный каталог ORBITA_DATA_DIR вне public.');process.exitCode=1;}
