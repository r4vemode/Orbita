import {spawn} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
// Test fixtures must never inherit live provider settings or private data paths.
// Tests that exercise a configuration construct it explicitly in their process.
const cwd=fileURLToPath(new URL('../',import.meta.url)),env={...process.env};
for(const key of Object.keys(env))if(/^(ORBITA_|CLOUDPAYMENTS_|RESEND_|TELEGRAM_|RADAR_|MOEX_|MARKETS_)/.test(key)||['NODE_ENV','HOST','PORT'].includes(key))delete env[key];
env.MARKETS_MODE='off';
const args=process.argv.slice(2),telegramOnly=args.includes('--scope=telegram');
const files=(await readdir(new URL('../test/',import.meta.url))).filter(name=>name.endsWith('.test.mjs')&&(!telegramOnly||name.startsWith('telegram-')||name==='radar-admin-workflow.test.mjs')).sort().map(name=>'test/'+name);
const child=spawn(process.execPath,['--test',...args.filter(arg=>arg!=='--scope=telegram'),...files],{cwd,env,stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('error',()=>{console.error('Не удалось запустить изолированные тесты.');process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
