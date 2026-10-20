import {fileURLToPath} from 'node:url';
import {createAccounts} from '../lib/accounts.mjs';
const [command,email]=process.argv.slice(2);
if(command!=='admin'||!email){console.error('Usage: node scripts/manage-access.mjs admin owner@example.com');process.exit(1);}
try{const accounts=await createAccounts(process.env.ORBITA_DATA_DIR||fileURLToPath(new URL('../data/',import.meta.url)));const user=await accounts.promote(email);console.log(`Администратор назначен: ${user.email}. Подписки управляются в /admin.html после входа.`);}catch(e){console.error(e.message);process.exitCode=1;}
