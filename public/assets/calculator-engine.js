/* Retrospective model of published, closed author ideas. Not broker executions or an OHLC backtest. */
(()=>{
 'use strict';
 const day=86400000;
 function timestamp(value,reference){const m=String(value||'').match(/^(\d{2})\.(\d{2})(?:\.(\d{4}))?\s*·\s*(\d{2}):(\d{2})$/);if(!m)return NaN;let year=m[3]?+m[3]:new Date(reference+10800000).getUTCFullYear();let t=Date.UTC(year,+m[2]-1,+m[1],+m[4]-3,+m[5]);if(!m[3]&&t<reference-day)t=Date.UTC(++year,+m[2]-1,+m[1],+m[4]-3,+m[5]);const local=new Date(t+10800000);if(local.getUTCMonth()!==+m[2]-1||local.getUTCDate()!==+m[1]||+m[4]>23||+m[5]>59)return NaN;return t;}
 function bounds(start,end){const parse=s=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(s))throw Error('Укажите обе даты.');const [y,m,d]=s.split('-').map(Number),t=Date.UTC(y,m-1,d),dt=new Date(t);if(dt.getUTCMonth()!==m-1||dt.getUTCDate()!==d)throw Error('Проверьте даты.');return t-10800000;};const a=parse(start),b=parse(end)+day;if(a>=b)throw Error('Начало периода должно быть не позже окончания.');return [a,b];}
 const precise=(value,fallback)=>value===undefined||value===null?fallback():typeof value==='string'?Date.parse(value):NaN;
 function normalize(record){
  if(!record||!record.published||record.erroneous||!record.d||!record.meta)return null;
  const d=record.d,m=record.meta,events=Array.isArray(m.events)?m.events:[],published=precise(m.publishedAt,()=>timestamp(m.published)),event=events.find(e=>Array.isArray(e)&&e[1]==='Вход подтверждён');
  const entered=event?precise(m.enteredAt??event[3]?.at,()=>timestamp(event[0],published)):NaN,closedEvent=[...events].reverse().find(e=>Array.isArray(e)&&/^(Закрыто|Цель достигнута|Стоп достигнут)/.test(e[1]));
  const exited=closedEvent?precise(m.closedAt??closedEvent[3]?.at,()=>timestamp(closedEvent[0],published)):NaN,levels=precise(m.levelsPublishedAt,()=>published);
  // Current records retain exact entry/exit snapshots. A mismatching final value
  // must not silently rewrite the price that was known when the event occurred.
  const entrySnapshot=event?.[3]?.after?.entry,exitSnapshot=closedEvent?.[3]?.after?.exit;
  const coherent=[published,levels,entered,exited].every(Number.isFinite)&&published<=levels&&levels<=entered&&entered<=exited&&['ЛОНГ','ШОРТ'].includes(d.dir)&&[d.entry,m.exit].every(n=>Number.isFinite(n)&&n>0)&&(entrySnapshot===undefined||entrySnapshot===d.entry)&&(exitSnapshot===undefined||exitSnapshot===m.exit);
  const change=coherent?(m.exit/d.entry-1)*(d.dir==='ШОРТ'?-1:1):NaN,valid=coherent&&Number.isFinite(change);
  return {id:record.id,ticker:d.ticker,strategy:d.strategy,market:d.market,dir:d.dir,entry:d.entry,exit:m.exit,published,entered,exited,state:d.state,valid,demo:record.demo===true||record.isDemo===true||/^(?:demo-|exclusive-)/.test(String(record.id)),change:valid?change:NaN};
 }
 function summarize(executed,curve){
  const wins=executed.filter(t=>t.net>0),losses=executed.filter(t=>t.net<0),grossProfit=wins.reduce((sum,t)=>sum+t.net,0),grossLoss=-losses.reduce((sum,t)=>sum+t.net,0);
  let peak=curve[0]?.value||0,maxDrawdown=0,maxDrawdownPercent=0;
  for(const point of curve){peak=Math.max(peak,point.value);const drawdown=peak-point.value;maxDrawdown=Math.max(maxDrawdown,drawdown);if(peak>0)maxDrawdownPercent=Math.max(maxDrawdownPercent,drawdown/peak*100);}
  const mean=rows=>rows.length?rows.reduce((sum,t)=>sum+t.net/(t.amount+t.entryFee)*100,0)/rows.length:null;
  return {wins:wins.length,losses:losses.length,breakeven:executed.length-wins.length-losses.length,winRate:executed.length?wins.length/executed.length*100:null,profitFactor:grossLoss>0?grossProfit/grossLoss:null,profitFactorStatus:!executed.length?'no-trades':grossLoss>0?'defined':'no-losses',grossProfit,grossLoss,maxDrawdown,maxDrawdownPercent,averageReturnPercent:mean(executed),averageWinPercent:mean(wins),averageLossPercent:mean(losses)};
 }
 function calculate(records,{capital,allocation,fee,slippage=0,start,end,strategy='all',compound=true,dataMode='published'}){
  if(!Number.isFinite(capital)||capital<1||capital>1e12)throw Error('Капитал: от 1 до 1 000 000 000 000 ₽.');
  if(!Number.isFinite(allocation)||allocation<=0||allocation>100)throw Error('Размер позиции: больше 0 и не больше 100%.');
  if(!Number.isFinite(fee)||fee<0||fee>5)throw Error('Комиссия за одну сторону: от 0 до 5%.');
  if(!Number.isFinite(slippage)||slippage<0||slippage>5)throw Error('Проскальзывание за одну сторону: от 0 до 5%.');
  if(!['published','demo'].includes(dataMode))throw Error('Выберите опубликованную или демонстрационную историю.');
  if(!Array.isArray(records)||records.length>100000)throw Error('Некорректный объём истории.');
  const [from,to]=bounds(start,end),normalized=records.map(normalize).filter(t=>t&&(strategy==='all'||t.strategy===strategy)),all=normalized.filter(t=>t.demo===(dataMode==='demo'));
  const closed=all.filter(t=>t.state==='closed'),eligible=closed.filter(t=>t.valid&&t.entered>=from&&t.exited<to).sort((a,b)=>a.entered-b.entered||a.id.localeCompare(b.id));
  let cash=capital,reserved=0,totalFees=0,ruined=false;const positions=new Map(),rows=[],curve=[{time:from,value:capital}],events=[];
  const ids=new Set();for(const t of eligible){if(ids.has(t.id))throw Error('В истории повторяется идентификатор идеи.');ids.add(t.id);events.push({time:t.entered,kind:1,t},{time:t.exited,kind:t.exited===t.entered?2:0,t});}
  events.sort((a,b)=>a.time-b.time||(a.kind-b.kind)||a.t.id.localeCompare(b.t.id));
  for(const event of events){const t=event.t;if(event.kind===1){
   const amount=(compound?cash+reserved:capital)*allocation/100/(1+fee/100),entryFee=amount*fee/100;
   if(ruined||amount<=0||amount+entryFee>cash+1e-7){rows.push({...t,skipped:true,reason:ruined?'Капитал исчерпан':'Не хватает свободного капитала'});continue;}
   cash-=amount+entryFee;reserved+=amount;totalFees+=entryFee;positions.set(t.id,{amount,entryFee});curve.push({time:event.time,value:cash+reserved});
  }else{
   const p=positions.get(t.id);if(!p)continue;
   const sign=t.dir==='ШОРТ'?-1:1,effectiveEntry=t.entry*(1+sign*slippage/100),effectiveExit=t.exit*(1-sign*slippage/100),exitRatio=effectiveExit/effectiveEntry,exitFee=p.amount*exitRatio*fee/100,gross=p.amount*(exitRatio-1)*sign,net=gross-p.entryFee-exitFee;
   cash+=p.amount+gross-exitFee;reserved-=p.amount;totalFees+=exitFee;positions.delete(t.id);rows.push({...t,...p,effectiveEntry,effectiveExit,exitFee,gross,net,skipped:false});curve.push({time:event.time,value:cash+reserved});if(cash+reserved<=0)ruined=true;
  }}
  const percent=(cash+reserved-capital)/capital*100;
  if(![cash,reserved,totalFees,percent,...curve.map(point=>point.value),...rows.flatMap(row=>row.skipped?[]:[row.amount,row.entryFee,row.exitFee,row.gross,row.net])].every(Number.isFinite))throw Error('Числовой диапазон модели превышен. Проверьте цены, капитал и выбранный период.');
  const executed=rows.filter(r=>!r.skipped);curve.push({time:to-1,value:cash+reserved});const metrics=summarize(executed,curve);
  if(Object.values(metrics).some(value=>typeof value==='number'&&!Number.isFinite(value)))throw Error('Числовой диапазон статистики превышен.');
  return {initial:capital,final:cash+reserved,profit:cash+reserved-capital,percent,totalFees,rows:rows.sort((a,b)=>a.entered-b.entered),curve,executed:executed.length,skipped:rows.length-executed.length,...metrics,invalid:closed.filter(t=>!t.valid).length,excluded:closed.filter(t=>t.valid&&!eligible.includes(t)).length,excludedDemo:normalized.filter(t=>t.demo).length,open:all.filter(t=>['active','waiting'].includes(t.state)).length,ruined,from,to,dataMode,slippage};
 }
 window.OrbitaCalculator={calculate,normalize,bounds,timestamp,summarize};
})();
