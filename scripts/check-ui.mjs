import {createRequire} from 'node:module';
import {access,mkdir,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {startLocalBeta} from './beta-local.mjs';
import {runAuthFlows} from './qa-auth-flows.mjs';
import {runAdminFlows} from './qa-admin-flows.mjs';
import {runClientFlows} from './qa-client-flows.mjs';
import {runLayoutFlows} from './qa-layout-flows.mjs';
import {runLegalFlows} from './qa-legal-flows.mjs';
import {runRadarFlows} from './qa-radar-flows.mjs';
import {runRadarAdminFlows} from './qa-radar-admin-flows.mjs';
import {runIdeaAlertFlows} from './qa-idea-alerts-flows.mjs';
import {runParticipantsFlows} from './qa-participants-flows.mjs';
import {runAdminRaceFlows} from './qa-admin-race-flows.mjs';
import {runSecurityRaceFlows} from './qa-security-race-flows.mjs';
import {runMemberSessionFlows} from './qa-member-session-flows.mjs';
import {runAdminPrivacyFlows} from './qa-admin-privacy-flows.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
export async function runUiAcceptance(args=process.argv.slice(2)){
  const allowed=new Set(['--help','--headed','--browser=chromium','--browser=firefox','--browser=webkit']);
  if(args.some(value=>!allowed.has(value))||args.filter(value=>value.startsWith('--browser=')).length>1){console.error('Используйте --headed и/или --browser=chromium|firefox|webkit.');process.exitCode=2;return;}
  if(args.includes('--help')){console.log('npm run check:ui -- [--headed] [--browser=chromium|firefox|webkit]\nИзолированная браузерная приёмка четырёх учебных ролей. Нужны npm ci и npx playwright install chromium. Отчёт: qa-artifacts/<запуск>/report.md. Реальные письма, платежи и устройства не проверяются.');return;}
  let playwright;try{playwright=createRequire(import.meta.url)('playwright');}catch{console.error('Для браузерной приёмки выполните npm ci, затем npx playwright install chromium. Обычный npm start этого не требует.');process.exitCode=1;return;}
  const engine=args.find(value=>value.startsWith('--browser='))?.split('=')[1]||'chromium';
  let executablePath=process.env.ORBITA_BROWSER_EXECUTABLE_PATH;
  if(!executablePath&&engine==='chromium'){
    const candidates=[playwright.chromium.executablePath(),'/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome'];
    for(const candidate of candidates)try{await access(candidate,constants.X_OK);executablePath=candidate;break;}catch{}
  }
  const report={startedAt:new Date().toISOString(),engine,locale:'ru-RU',timezone:'Europe/Moscow',mode:args.includes('--headed')?'headed':'headless',synthetic:true,checks:[],suites:[],screenshots:[],pending:['Реальные iPhone/Safari и Android/Chrome','Доставка почты и ссылки на публичном домене','CloudPayments и Telegram с реальными настройками','Бета с участниками и проверка будущего хостинга']};
  const runId=report.startedAt.replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8),outputDir=path.join(project,'qa-artifacts',runId);await mkdir(outputDir,{recursive:true});
  const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
  let browser,failed=false;
  try{
    browser=await playwright[engine].launch({headless:!args.includes('--headed'),...(executablePath?{executablePath}:{})});report.browserVersion=browser.version();
    for(const [name,run]of [['Аккаунт',runAuthFlows],['Редакция',runAdminFlows],['Редакция — параллельные действия',runAdminRaceFlows],['Безопасность — смена аккаунта',runSecurityRaceFlows],['Редакция — приватность',runAdminPrivacyFlows],['Кабинеты клиентов',runClientFlows],['Открытые кабинеты — смена доступа',runMemberSessionFlows],['Документы и реквизиты',runLegalFlows],['Radar',runRadarFlows],['Редакция Radar',runRadarAdminFlows],['Уведомления идей',runIdeaAlertFlows],['Позиции участников',runParticipantsFlows],['Адаптивность',runLayoutFlows]]){
      controller.signal.throwIfAborted();let session;const suite={name,status:'running',checks:0};report.suites.push(suite);
      try{
        session=await startLocalBeta({signal:controller.signal});
        const record=async(title,work)=>{
          controller.signal.throwIfAborted();const started=Date.now();
          try{const value=await work();report.checks.push({suite:name,title,status:'passed',durationMs:Date.now()-started});suite.checks++;console.log('✓ '+title);return value;}
          catch(cause){report.checks.push({suite:name,title,status:'failed',durationMs:Date.now()-started,error:safeError(cause,session)});suite.checks++;throw cause;}
        };
        const result=await run({session,browser,record,outputDir});if(result?.screenshots)report.screenshots.push(...result.screenshots);suite.status='passed';
      }catch(cause){failed=true;suite.status=controller.signal.aborted?'interrupted':'failed';suite.error=safeError(cause,session);console.error('✗ '+name+': '+suite.error);}
      finally{await session?.close();}
    }
  }catch{failed=true;console.error(controller.signal.aborted?'Приёмка остановлена.':'Не удалось завершить браузерную приёмку. Проверьте установку браузера: npx playwright install '+engine);}
  finally{
    await browser?.close();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
    report.finishedAt=new Date().toISOString();report.status=controller.signal.aborted?'interrupted':failed?'failed':'passed';report.passed=report.checks.filter(check=>check.status==='passed').length;report.failed=report.checks.filter(check=>check.status==='failed').length;
    await writeFile(path.join(outputDir,'report.json'),JSON.stringify(report,null,2)+'\n');
    const lines=['# ORBITA — браузерная приёмка','',`Статус: **${report.status}**. Успешно: ${report.passed}, ошибок сценариев: ${report.failed}.`,`${engine} ${report.browserVersion||'не запущен'}; ${report.mode}. Время UTC: ${report.startedAt}.`,'','Использованы отдельные временные базы и вымышленные аккаунты; рабочие данные и провайдеры не использовались.','',...report.suites.map(suite=>`- ${suite.name}: ${suite.status}, проверок ${suite.checks}${suite.error?' — '+suite.error:''}`),'','## Сценарии','',...report.checks.map(check=>`- ${check.status==='passed'?'✓':'✗'} ${check.title}${check.error?' — '+check.error:''}`),'','## Не проверено этим запуском','',...report.pending.map(item=>'- '+item),'','## Снимки учебного интерфейса','',...report.screenshots.map(name=>`- [${name}](${name})`),''];
    await writeFile(path.join(outputDir,'report.md'),lines.join('\n'));console.log(`Отчёт: ${path.relative(project,path.join(outputDir,'report.md'))}`);
    if(failed||controller.signal.aborted)process.exitCode=controller.signal.aborted?130:1;
  }
  return report;
}
function safeError(cause,session){
  let message=String(cause?.message||cause?.name||'Ошибка сценария');
  for(const account of session?.accounts||[])for(const value of [account.password,account.email])if(value)message=message.split(value).join('[учебные данные скрыты]');
  if(session?.directory)message=message.split(session.directory).join('[временная база]');
  return message.replace(/([?&#](?:password|token|challenge|code|email)=)[^\s&#"']+/gi,'$1[скрыто]').replace(/[\r\n]+/g,' ').slice(0,1200);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await runUiAcceptance();
