/* Deterministic OHLC simulation. This is never evidence of executed client trades. */
(()=>{
 'use strict';
 const ENGINE_VERSION='orbita-ohlc-1.0.0',MAX_PRICE=1e12,EPS=1e-8;
 const object=v=>v&&typeof v==='object'&&!Array.isArray(v),finite=(n,min,max)=>typeof n==='number'&&Number.isFinite(n)&&n>=min&&n<=max;
 const fail=message=>{throw Error(message);};
 function keys(value,allowed,label){if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail(label+': некорректные или неизвестные поля.');}
 function text(value,label,max=200){if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f]/.test(value))fail(label+': укажите непустой текст.');return value.trim();}
 function time(value,label){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))fail(label+': нужна ISO-дата с часовым поясом.');const at=Date.parse(value);if(!Number.isFinite(at))fail(label+': некорректная дата.');const raw=value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/),[y,m,d,h,mi,s]=raw.slice(1).map(Number);if(m<1||m>12||d<1||d>new Date(Date.UTC(y,m,0)).getUTCDate()||h>23||mi>59||s>59)fail(label+': некорректная календарная дата.');return at;}
 function price(value,label,tick){if(!finite(value,1e-8,MAX_PRICE))fail(label+': цена должна быть положительной и конечной.');const ticks=value/tick;if(!Number.isFinite(ticks)||ticks>1e14||Math.abs(ticks-Math.round(ticks))>Math.max(1e-7,Math.abs(ticks)*Number.EPSILON*4))fail(label+': цена не соответствует шагу инструмента.');return value;}
 function levels(direction,entry,stop,target,entered=false){if(direction==='LONG'?(target<=entry||stop>=target||!entered&&stop>=entry):(target>=entry||stop<=target||!entered&&stop<=entry))fail('Уровни сигнала противоречат направлению сделки.');}
 function validate(input){
  keys(input,['version','metadata','instrument','options','candles','signals'],'Файл');if(input.version!==1)fail('Поддерживается версия формата 1.');
  const meta=input.metadata;keys(meta,['source','sourceKind','timezone','strategyVersion','asOf','intervalSeconds'],'Метаданные');text(meta.source,'Источник',1000);text(meta.strategyVersion,'Версия стратегии');if(!['real','synthetic'].includes(meta.sourceKind)||meta.timezone!=='UTC')fail('Укажите sourceKind real/synthetic и timezone UTC.');const asOf=time(meta.asOf,'Дата снимка');if(!Number.isSafeInteger(meta.intervalSeconds)||meta.intervalSeconds<1||meta.intervalSeconds>2678400)fail('Укажите длительность свечи в секундах (1–2678400).');
  const inst=input.instrument;keys(inst,['ticker','market','currency','lotSize','pointValue','tickSize'],'Инструмент');text(inst.ticker,'Тикер',40);text(inst.currency,'Валюта',12);if(!['stocks','futures','crypto','forex'].includes(inst.market))fail('Неизвестный рынок.');if(!Number.isSafeInteger(inst.lotSize)||inst.lotSize<1||inst.lotSize>1e8||!finite(inst.pointValue,1e-8,1e8)||!finite(inst.tickSize,1e-8,1e8))fail('Проверьте размер лота, стоимость пункта и шаг цены.');
  const opts=input.options;keys(opts,['initialCapital','allocationPercent','feeBps','slippageBps','maxPendingBars'],'Условия');if(!finite(opts.initialCapital,1,1e12)||!finite(opts.allocationPercent,.001,100)||!finite(opts.feeBps,0,500)||!finite(opts.slippageBps,0,500)||!Number.isSafeInteger(opts.maxPendingBars)||opts.maxPendingBars<1||opts.maxPendingBars>10000)fail('Проверьте капитал, долю позиции, комиссию, проскальзывание и срок ожидания.');
  if(!Array.isArray(input.candles)||input.candles.length>100000||!Array.isArray(input.signals)||input.signals.length>5000)fail('Допускается до 100 000 свечей и 5 000 сигналов.');
  let previous=-Infinity;const interval=meta.intervalSeconds*1000,candles=input.candles.map((c,i)=>{keys(c,['time','open','high','low','close'],'Свеча '+i);const at=time(c.time,'Время свечи '+i);if(at<previous+interval)fail('Свечи должны идти по времени без повторов и перекрытия.');if(at+interval>asOf)fail('Незавершённая свеча или данные после даты снимка недопустимы.');previous=at;for(const name of ['open','high','low','close'])price(c[name],'Свеча '+i+' '+name,inst.tickSize);if(c.low>Math.min(c.open,c.close)||c.high<Math.max(c.open,c.close)||c.low>c.high)fail('Нарушена геометрия OHLC.');return {...c,at};});
  const ids=new Set(),signals=input.signals.map((s,i)=>{keys(s,['id','publishedAt','validFrom','direction','entryOrder','entry','stop','target','updates'],'Сигнал '+i);text(s.id,'ID сигнала',100);if(ids.has(s.id))fail('Повтор ID сигнала.');ids.add(s.id);const published=time(s.publishedAt,'Время публикации'),validFrom=s.validFrom===undefined?published:time(s.validFrom,'Начало действия');if(validFrom<published||published>asOf||validFrom>asOf)fail('Начало действия не может предшествовать публикации или быть после снимка.');if(!['LONG','SHORT'].includes(s.direction)||!['limit','stop'].includes(s.entryOrder))fail('Укажите направление LONG/SHORT и заявку limit/stop.');for(const name of ['entry','stop','target'])price(s[name],name,inst.tickSize);levels(s.direction,s.entry,s.stop,s.target);if(s.updates!==undefined&&(!Array.isArray(s.updates)||s.updates.length>100))fail('До 100 изменений на сигнал.');let previousUpdate=published,stop=s.stop,target=s.target;const updates=(s.updates||[]).map(u=>{keys(u,['knownAt','stop','target','cancel'],'Изменение');const knownAt=time(u.knownAt,'Время известности изменения');if(knownAt<=previousUpdate||knownAt>asOf)fail('Изменения должны следовать строго после публикации и друг друга, до даты снимка.');previousUpdate=knownAt;if(Object.keys(u).length<2||u.cancel!==undefined&&u.cancel!==true||u.cancel===true&&(u.stop!==undefined||u.target!==undefined))fail('Изменение должно задавать уровни либо отмену ожидающей заявки.');if(u.stop!==undefined)stop=price(u.stop,'Новый стоп',inst.tickSize);if(u.target!==undefined)target=price(u.target,'Новая цель',inst.tickSize);levels(s.direction,s.entry,stop,target,true);return {...u,at:knownAt};});return {...s,published,validFrom,updates};}).sort((a,b)=>a.validFrom-b.validFrom||a.id.localeCompare(b.id));
  return {metadata:{...meta},instrument:{...inst},options:{...opts},candles,signals,interval};
 }
 const iso=t=>new Date(t).toISOString();
 function run(input){
  const data=validate(input),{instrument:inst,options:opts,candles,signals,interval,metadata}=data,unit=inst.lotSize*inst.pointValue,fee=opts.feeBps/10000,slip=opts.slippageBps/10000;
  const warnings=new Set(['Источник и дата публикации заданы оператором. Движок проверяет согласованность, но не удостоверяет подлинность рыночных данных.']),assumptions=[
   'Гипотетическое исполнение заявок по OHLC, а не фактические сделки клиента или автора.',
   'Публикация и изменения действуют только со свечи, открывшейся строго после времени их известности.',
   'Все свечи завершены на дату снимка. Внутри свечи последовательность цен неизвестна: при конфликте выбирается стоп.',
   'Номинал позиции полностью резервируется без плеча; размер лота и стоимость пункта обязательны. Освободившийся в свече капитал доступен только со следующей свечи.',
   'Комиссия применяется к обеим сторонам оборота, проскальзывание — против позиции с округлением к шагу цены. Лимитные заявки не исполняются хуже лимита.',
   'Дивиденды, корпоративные действия, налоги, funding, заём бумаг, гарантийное обеспечение, ликвидность и объём торгов не моделируются. Все суммы в валюте инструмента без FX.',
   'Капитал и просадка переоцениваются по закрытию каждой свечи; внутрисвечная просадка может быть глубже. Открытые позиции не закрываются искусственно в конце данных.'
  ];
  if(metadata.sourceKind==='synthetic')warnings.add('СИНТЕТИЧЕСКИЙ ПРИМЕР: эти результаты не являются статистикой стратегии.');
  if(inst.market!=='stocks')warnings.add('Для этого рынка модель учитывает только номинальную стоимость. Специфические расходы и обеспечение не рассчитаны.');
  let cash=opts.initialCapital,reserved=0,totalFees=0,realized=0,next=0,work=0,ruined=false;
  const trades=[],active=[],equity=[],stats={ambiguousBars:0,missingIntervals:0};
  const adverse=(p,buy,limit=null)=>{let v=p*(1+(buy?slip:-slip)),ticks=v/inst.tickSize;v=(buy?Math.ceil(ticks-1e-9):Math.floor(ticks+1e-9))*inst.tickSize;if(limit!==null)v=buy?Math.min(v,limit):Math.max(v,limit);if(!finite(v,1e-8,MAX_PRICE))fail('Цена исполнения вне допустимого диапазона.');return v;};
  const currentEquity=close=>cash+reserved+active.filter(t=>t.status==='open').reduce((sum,t)=>sum+(close-t.entryFill)*t.units*t.sign,0);
  function fill(t,c){const long=t.sign===1,limit=t.entryOrder==='limit',atOpen=long?(limit?c.open<=t.entry:c.open>=t.entry):(limit?c.open>=t.entry:c.open<=t.entry),touched=long?(limit?c.low<=t.entry:c.high>=t.entry):(limit?c.high>=t.entry:c.low<=t.entry);if(!touched)return null;return {price:adverse(atOpen?c.open:t.entry,long,limit?t.entry:null),atOpen};}
  function exit(t,c,newEntry=false){const long=t.sign===1,openStop=long?c.open<=t.currentStop:c.open>=t.currentStop,openTarget=long?c.open>=t.currentTarget:c.open<=t.currentTarget;
   if(!newEntry||t.atOpen){if(openStop)return {price:adverse(c.open,!long),reason:'stop-gap',ambiguous:false};if(openTarget)return {price:adverse(t.currentTarget,!long,t.currentTarget),reason:'target',ambiguous:false};}
   const stop=long?c.low<=t.currentStop:c.high>=t.currentStop,target=long?c.high>=t.currentTarget:c.low<=t.currentTarget;
   if(stop){const ambiguous=target||newEntry&&!t.atOpen;if(ambiguous){stats.ambiguousBars++;t.flags.push('intrabar-order-unknown-stop-first');}return {price:adverse(t.currentStop,!long),reason:'stop',ambiguous};}
   if(target){const guaranteed=!newEntry||t.atOpen||t.entryOrder==='stop'||(long?c.close>=t.currentTarget:c.close<=t.currentTarget);if(guaranteed)return {price:adverse(t.currentTarget,!long,t.currentTarget),reason:'target',ambiguous:false};stats.ambiguousBars++;t.flags.push('target-may-have-preceded-entry');}
   return null;
  }
  function close(t,result,c){const exitFee=result.price*t.units*fee,gross=(result.price-t.entryFill)*t.units*t.sign,net=gross-t.entryFee-exitFee;cash+=t.notional+gross-exitFee;reserved-=t.notional;totalFees+=exitFee;realized+=net;Object.assign(t,{status:'closed',exitedAt:iso(c.at+interval),exitFill:result.price,exitReason:result.reason,exitFee,grossPnl:gross,netPnl:net,returnPercent:net/(t.notional+t.entryFee)*100});}
  let previousAt=null;
  for(const c of candles){
   if(previousAt!==null&&c.at>previousAt+interval)stats.missingIntervals++;previousAt=c.at;
   while(next<signals.length&&signals[next].validFrom<c.at){const s=signals[next++];const t={id:s.id,direction:s.direction,entryOrder:s.entryOrder,entry:s.entry,initialStop:s.stop,initialTarget:s.target,currentStop:s.stop,currentTarget:s.target,publishedAt:iso(s.published),validFrom:iso(s.validFrom),status:'pending',flags:[],pendingBars:0,sign:s.direction==='LONG'?1:-1,updates:s.updates,updateIndex:0};trades.push(t);active.push(t);}
   const exits=[];
   for(const t of active){if(++work>5000000)fail('Слишком большой объём моделирования. Разделите входной файл на более короткие периоды.');if(!['pending','open'].includes(t.status))continue;
    while(t.updateIndex<t.updates.length&&t.updates[t.updateIndex].at<c.at){const u=t.updates[t.updateIndex++];if(u.cancel){if(t.status==='pending')t.status='cancelled';else t.flags.push('cancel-after-entry-ignored');}else{if(u.stop!==undefined)t.currentStop=u.stop;if(u.target!==undefined)t.currentTarget=u.target;}}
    if(t.status==='cancelled')continue;
    if(t.status==='pending'){
     // A trailing stop beyond entry cannot be applied retroactively to an unfilled order.
     try{levels(t.direction,t.entry,t.currentStop,t.currentTarget);}catch{t.status='invalid-before-entry';t.flags.push('updated-stop-past-unfilled-entry');continue;}
     if(t.pendingBars++>=opts.maxPendingBars){t.status='expired';continue;}
     const f=fill(t,c);if(!f)continue;const budget=Math.min(cash,opts.initialCapital*opts.allocationPercent/100),lots=Math.floor(budget/(f.price*unit*(1+fee)));
     if(ruined||lots<1){t.status='skipped-capital';continue;}
     const units=lots*unit,notional=f.price*units,entryFee=notional*fee;cash-=notional+entryFee;reserved+=notional;totalFees+=entryFee;Object.assign(t,{status:'open',enteredAt:iso(c.at),entryFill:f.price,atOpen:f.atOpen,lots,units,notional,entryFee});const outcome=exit(t,c,true);if(outcome)exits.push([t,outcome]);
    }else{const outcome=exit(t,c);if(outcome)exits.push([t,outcome]);}
   }
   // Exit proceeds cannot finance another entry whose intrabar ordering is unknown.
   for(const [t,result]of exits)close(t,result,c);
   const value=currentEquity(c.close);if(![value,cash,reserved,totalFees,realized].every(Number.isFinite))fail('Числовой диапазон расчёта превышен.');if(value<=0)ruined=true;equity.push({time:iso(c.at+interval),value,cash,unrealizedPnl:value-cash-reserved});
  }
  for(;next<signals.length;next++){const s=signals[next];trades.push({id:s.id,direction:s.direction,publishedAt:iso(s.published),validFrom:iso(s.validFrom),status:'uncovered',flags:['no-complete-candle-after-publication']});}
  const eligible=trades.filter(t=>t.status!=='uncovered'),closed=trades.filter(t=>t.status==='closed'),opened=trades.filter(t=>t.status==='open'),waiting=trades.filter(t=>t.status==='pending');
  if(!eligible.length)warnings.add('Недостаточно завершённых свечей после публикаций. Результат не рассчитан.');
  if(stats.missingIntervals)warnings.add('В свечах есть разрывы. Они могут быть торговыми перерывами либо пропусками данных; календарь торгов не проверен.');
  if(stats.ambiguousBars)warnings.add('Внутрисвечная последовательность неизвестна. Использована консервативная политика; результаты с такими сделками требуют данных меньшего таймфрейма.');
  if(opened.length||waiting.length)warnings.add('В конце данных остались открытые позиции или ожидающие заявки. Это неполная история.');
  if(trades.some(t=>t.status==='invalid-before-entry'))warnings.add('Часть заявок исключена: изменение стопа до исполнения противоречит исходному входу.');
  if(trades.some(t=>t.status==='uncovered'))warnings.add('Часть публикаций не покрыта свечами после их времени известности.');
  if(ruined)warnings.add('В модели капитал исчерпан. Новые заявки больше не исполняются; гэп может привести к отрицательному капиталу.');
  let peak=opts.initialCapital,maxDrawdown=0,maxDrawdownPercent=0;for(const p of equity){peak=Math.max(peak,p.value);const d=peak-p.value;maxDrawdown=Math.max(maxDrawdown,d);if(peak>0)maxDrawdownPercent=Math.max(maxDrawdownPercent,d/peak*100);}
  const wins=closed.filter(t=>t.netPnl>EPS),losses=closed.filter(t=>t.netPnl<-EPS),grossProfit=wins.reduce((n,t)=>n+t.netPnl,0),grossLoss=Math.max(0,-losses.reduce((n,t)=>n+t.netPnl,0)),finalEquity=equity.at(-1)?.value??opts.initialCapital;
  const metrics=eligible.length?{initialCapital:opts.initialCapital,finalEquity,realizedPnl:realized,unrealizedPnl:opened.reduce((n,t)=>n+(candles.at(-1).close-t.entryFill)*t.units*t.sign,0),fees:totalFees,closedTrades:closed.length,openTrades:opened.length,wins:wins.length,losses:losses.length,breakeven:closed.length-wins.length-losses.length,winRate:closed.length?wins.length/closed.length*100:null,profitFactor:grossLoss>EPS?grossProfit/grossLoss:null,profitFactorStatus:grossLoss>EPS?'finite':grossProfit>EPS?'no-losses':'no-realized-results',grossProfit,grossLoss,averageReturnPercent:closed.length?closed.reduce((n,t)=>n+t.returnPercent,0)/closed.length:null,averageWin:wins.length?grossProfit/wins.length:null,averageLoss:losses.length?-grossLoss/losses.length:null,maxDrawdown,maxDrawdownPercent,drawdownBasis:'bar-close-mark-to-market',totalReturnPercent:(finalEquity/opts.initialCapital-1)*100}:null;
  if(metrics&&!Object.values(metrics).every(v=>typeof v!=='number'||Number.isFinite(v)))fail('Числовой диапазон метрик превышен.');
  const clean=trades.map(({updates,updateIndex,sign,...t})=>({...t,flags:[...new Set(t.flags)]}));
  return {version:1,engineVersion:ENGINE_VERSION,kind:'hypothetical-backtest',status:!eligible.length?'insufficient-data':opened.length||waiting.length||eligible.length<trades.length?'partial':'completed',sourceKind:metadata.sourceKind,metadata,instrument:inst,options:opts,assumptions,warnings:[...warnings],coverage:{candles:candles.length,signals:signals.length,eligibleSignals:eligible.length,uncoveredSignals:trades.length-eligible.length,openTrades:opened.length,pendingSignals:waiting.length,expiredSignals:trades.filter(t=>t.status==='expired').length,ambiguousBars:stats.ambiguousBars,gaps:stats.missingIntervals,from:candles.length?iso(candles[0].at):null,to:candles.length?iso(candles.at(-1).at+interval):null},metrics,trades:clean,equity};
 }
 function example(){return {version:1,metadata:{source:'Синтетический учебный пример; не биржевые данные',sourceKind:'synthetic',timezone:'UTC',strategyVersion:'example-only-v1',asOf:'2026-01-05T12:00:00Z',intervalSeconds:3600},instrument:{ticker:'EXAMPLE',market:'stocks',currency:'RUB',lotSize:10,pointValue:1,tickSize:.01},options:{initialCapital:100000,allocationPercent:10,feeBps:5,slippageBps:2,maxPendingBars:5},candles:[{time:'2026-01-05T09:00:00Z',open:102,high:103,low:99,close:101},{time:'2026-01-05T10:00:00Z',open:101,high:108,low:100,close:107},{time:'2026-01-05T11:00:00Z',open:107,high:111,low:106,close:110}],signals:[{id:'synthetic-example-1',publishedAt:'2026-01-05T08:59:00Z',direction:'LONG',entryOrder:'limit',entry:100,stop:95,target:110}]};}
 globalThis.OrbitaBacktest=Object.freeze({run,validate,example,ENGINE_VERSION});
})();
