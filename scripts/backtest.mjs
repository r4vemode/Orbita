import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {runBacktest,example} from '../lib/backtest.mjs';
const args=process.argv.slice(2);
try{
 if(args.length===1&&args[0]==='--example'){process.stdout.write(JSON.stringify(example(),null,2)+'\n');}
 else if(args.length<1||args.length>2||args.some(arg=>arg.startsWith('--'))){console.error('Использование: node scripts/backtest.mjs input.json [report.json]\nУчебный формат: node scripts/backtest.mjs --example\nРезультаты всегда гипотетические. Файл отчёта создаётся без перезаписи.');process.exitCode=2;}
 else{const report=runBacktest(await readFile(resolve(args[0]),'utf8')),json=JSON.stringify(report,null,2)+'\n';if(args[1]){await writeFile(resolve(args[1]),json,{flag:'wx',mode:0o600});console.error('Отчёт сохранён. Статус: '+report.status+'. Источник: '+report.sourceKind+'.');}else process.stdout.write(json);}
}catch(cause){console.error('Бэктест не выполнен: '+cause.message);process.exitCode=1;}
