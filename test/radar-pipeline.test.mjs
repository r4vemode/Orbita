import test from 'node:test';
import assert from 'node:assert/strict';
import {DEMO_COMPANIES,EVENT_TYPES,IMPACTS,matchCompany,plainText,validateAnalysis} from '../lib/radar/model.mjs';
import {analyzeRadarEvent,createRadarAnalysisService,createConfiguredAnalysis} from '../lib/radar/analysis.mjs';
import {createPipeline,normalizeRawEvent,deduplicateEvent} from '../lib/radar/pipeline.mjs';
import {createMockProvider,MockMarketDataProvider} from '../lib/radar/providers/index.mjs';
const now=()=>Date.parse('2026-10-30T12:00:00Z');
const raw=(extra={})=>({provider:'edisclosure',externalId:'source-1',sourceUrl:'https://www.moex.com/disclosure/1',publishedAt:'2026-10-30T11:59:00Z',title:'Дивиденды Сбербанка',rawText:'ПАО Сбербанк: совет директоров рекомендовал выплатить 38,4 ₽ на акцию.',...extra});

test('Radar company aliases, ticker and ISIN converge while ambiguous issuers stay unassigned',()=>{
 const expected=DEMO_COMPANIES.find(company=>company.ticker==='SBER');
 for(const companyName of ['ПАО Сбербанк','Сбербанк России','Сбер','Sberbank','SBER'])assert.equal(matchCompany({companyName},DEMO_COMPANIES)?.id,expected.id);
 assert.equal(matchCompany({ticker:'sber'})?.id,expected.id);assert.equal(matchCompany({isin:expected.isin})?.id,expected.id);
 assert.equal(matchCompany({title:'Сбер и Лукойл объявили соглашение'}),null);
 assert.equal(matchCompany({companyName:'Неизвестный эмитент',title:'Событие компании'}),null);
 assert.equal(matchCompany({title:'Отчет иностранной компании: t'}),null);
 assert.equal(matchCompany({companyName:'Сбер'},[{...expected,active:false}]),null);
});

test('Radar distinguishes dividend agenda, recommendation and cancellation without a BUY recommendation',()=>{
 const agenda=analyzeRadarEvent(raw({title:'Совет директоров рассмотрит дивиденды',rawText:'Повестка заседания совета директоров Сбербанка содержит вопрос о рекомендации дивидендов.'}));
 assert.equal(agenda.eventType,'BOARD_MEETING');assert.ok(agenda.tags.includes('dividend'));assert.ok(agenda.importanceScore>=6&&agenda.importanceScore<=8);assert.equal(agenda.impact,'NEUTRAL');
 const recommendation=analyzeRadarEvent(raw());assert.equal(recommendation.eventType,'DIVIDEND');assert.equal(recommendation.extractedData.dividendPerShare,38.4);assert.equal(recommendation.impact,'POSITIVE');assert.ok(!/BUY|SELL/.test(recommendation.headline+recommendation.summary));
 const cancellation=analyzeRadarEvent(raw({rawText:'ПАО Сбербанк: совет директоров решил не выплачивать дивиденды за период.'}));assert.equal(cancellation.eventType,'DIVIDEND');assert.equal(cancellation.impact,'NEGATIVE');assert.ok(cancellation.importanceScore>=9);
 assert.equal(analyzeRadarEvent({title:'Технический дефолт не допущен',rawText:'Не допущен технический дефолт по выпуску.'}).eventType,'OTHER');
 assert.equal(analyzeRadarEvent({title:'Дефолт не наступил',rawText:'Дефолт не наступил, обязательства исполнены.'}).eventType,'OTHER');
 assert.equal(analyzeRadarEvent(raw({title:'Дивиденды не отменены',rawText:'Дивиденды Сбербанка не отменены.'})).impact,'NEUTRAL');
 assert.equal(analyzeRadarEvent({title:'Кредитный рейтинг не понижен',rawText:'Рейтинг не понижен.'}).impact,'NEUTRAL');
});

test('Radar classifies credit, equity and bond events and preserves neutral CAPEX assessment',()=>{
 const cases=[['Технический дефолт по купону','TECHNICAL_DEFAULT','NEGATIVE'],['Дефолт эмитента','DEFAULT','NEGATIVE'],['Возбуждено дело о банкротстве','BANKRUPTCY','NEGATIVE'],['Дополнительная эмиссия акций','SHARE_ISSUE','NEGATIVE'],['Вторичное размещение SPO','SPO','NEGATIVE'],['Программа обратного выкупа','BUYBACK','POSITIVE'],['Кредитный рейтинг понижен','CREDIT_RATING','NEGATIVE'],['Оферта по облигации','BOND_OFFER','NEUTRAL'],['Погашение облигации','BOND_REDEMPTION','NEUTRAL'],['Выплата купона по облигации','BOND_COUPON','NEUTRAL'],['Капитальные затраты CAPEX обновлены','CAPEX','NEUTRAL'],['Прогноз EBITDA повышен','GUIDANCE','POSITIVE']];
 for(const [title,eventType,impact]of cases){const result=analyzeRadarEvent({title,rawText:title});assert.equal(result.eventType,eventType,title);assert.equal(result.impact,impact,title);assert.ok(EVENT_TYPES.includes(result.eventType));assert.ok(IMPACTS.includes(result.impact));}
});

test('Radar surprise requires supplied expectations and uses the actual baseline rather than invented consensus',async()=>{
 const pipeline=createPipeline({now}),without=await pipeline.process(raw({title:'Дивиденды выше ожиданий'}));assert.equal(without.expectedValue,null);assert.equal(without.surprisePercent,null);assert.ok(!without.headline.includes('выше ожиданий'));
 const withBaseline=await pipeline.process(raw({actualValue:55,expectedValue:50,previousValue:45}));assert.equal(withBaseline.surprisePercent,10);assert.equal(withBaseline.actualValue,55);assert.equal(withBaseline.previousValue,45);assert.ok(withBaseline.importanceScore>=9);
 const zero=await pipeline.process(raw({actualValue:55,expectedValue:0}));assert.equal(zero.surprisePercent,null);
});

test('Radar normalization discards external detection times, strips markup, validates URLs and quarantines unknown companies',async()=>{
 const normalized=normalizeRawEvent(raw({detectedAt:'2001-01-01',title:'<b>Сбер</b><script>alert(1)</script>',rawText:'<p>Описание&nbsp;события</p>'}),{now});assert.equal(normalized.detectedAt,new Date(now()).toISOString());assert.equal(normalized.title,'Сбер');assert.equal(normalized.rawText,'Описание события');
 assert.equal(plainText('<img src=x onerror=alert(1)>Текст'),'Текст');
 for(const sourceUrl of ['javascript:alert(1)','http://www.moex.com/','https://127.0.0.1/','https://10.0.0.1/','https://[::ffff:127.0.0.1]/','https://localhost/','https://user:secret@www.moex.com/'])assert.throws(()=>normalizeRawEvent(raw({sourceUrl}),{now}));
 assert.throws(()=>normalizeRawEvent(raw({publishedAt:'2027-01-01T00:00:00Z'}),{now}));
 const unknown=await createPipeline({now}).process(raw({title:'Новое раскрытие',rawText:'Неизвестный эмитент изменил устав.',companyName:'Неизвестный эмитент'}));assert.equal(unknown.companyId,null);assert.equal(unknown.status,'draft');assert.ok(unknown.trace.some(item=>item.stage==='company_unmatched'));
 const long=await createPipeline({now}).process(raw({title:'Корпоративное раскрытие',rawText:'Условия корпоративного действия. '.repeat(400)+' ПАО Сбербанк: заседание совета директоров.'}));assert.equal(long.companyId,'sber');assert.equal(long.status,'published');
});

test('Radar deduplicates source repeats and cross-provider copies without merging decisions, changed amounts or negations',async()=>{
 const pipeline=createPipeline({now}),first=await pipeline.process(raw()),copy=await pipeline.process(raw({provider:'company-ir',externalId:'ir-1'}));assert.equal(deduplicateEvent(copy,[first]),first);
 const idRepeat=await pipeline.process(raw({title:'Исправленный заголовок'}));assert.equal(deduplicateEvent(idRepeat,[first]),first);
 const changed=await pipeline.process(raw({externalId:'new',rawText:'ПАО Сбербанк: совет директоров рекомендовал выплатить 40,4 ₽ на акцию.'}));assert.equal(deduplicateEvent(changed,[first]),null);
 const agenda=await pipeline.process(raw({externalId:'agenda',title:'Совет директоров рассмотрит дивиденды',rawText:'Повестка заседания совета директоров Сбербанка: рекомендация дивидендов.'}));assert.equal(deduplicateEvent(agenda,[first]),null);
 const boilerplate='Сбербанк опубликовал решение совета директоров об утверждении условий и внутренних процедур исполнения ранее утвержденной программы в соответствии с установленными законодательством требованиями и действующими внутренними положениями компании. Лимит ';
 const one=await pipeline.process(raw({externalId:'limit1',title:'Решение совета директоров',rawText:boilerplate+'100000000 рублей.'})),two=await pipeline.process(raw({externalId:'limit2',title:'Решение совета директоров',rawText:boilerplate+'900000000 рублей.'}));assert.equal(deduplicateEvent(two,[one]),null);
 const negated=await pipeline.process(raw({externalId:'limit3',title:'Решение совета директоров',rawText:boilerplate+'100000000 рублей. Нет разрешения.'}));assert.equal(deduplicateEvent(negated,[one]),null);
});

test('Radar keeps demonstration and live source identities separate in both matching directions',async()=>{
 const pipeline=createPipeline({now}),live=await pipeline.process(raw()),demo=await pipeline.process(raw({isDemo:true}));
 assert.equal(deduplicateEvent(live,[demo]),null);assert.equal(deduplicateEvent(demo,[live]),null);
 const copy=await pipeline.process(raw({provider:'company-ir',externalId:'ir-copy'}));assert.equal(deduplicateEvent(copy,[demo,live]),live);
 assert.equal(deduplicateEvent({...demo,id:'another-demo'},[live,demo]),demo);
});

test('Radar AI boundary rejects unsupported schema, fabricated consensus and unsafe objects; failures fall back to explicit rules',async()=>{
 const baseline=analyzeRadarEvent(raw());
 for(const ai of [async()=>({...baseline,importanceScore:99}),async()=>({...baseline,headline:'Дивиденды выше ожиданий'}),async()=>({...baseline,summary:'Рекомендовано 999 рублей на акцию.'}),async()=>({...baseline,headline:'BUY SBER'}),async()=>{throw Error('private token must not escape');}]){const service=createRadarAnalysisService({enabled:true,ai});assert.equal((await service.analyze(raw())).analysisMethod,'rules');}
 const accepted=await createRadarAnalysisService({enabled:true,ai:async()=>({...baseline,headline:'Рекомендованы дивиденды',extractedData:{actualValue:999,expectedValue:500}})}).analyze(raw());assert.equal(accepted.analysisMethod,'ai');assert.equal(accepted.extractedData.expectedValue,undefined);assert.equal(accepted.extractedData.dividendPerShare,38.4);
 assert.throws(()=>validateAnalysis({...baseline,extractedData:JSON.parse('{"__proto__":{"secret":1}}')}));
 assert.throws(()=>validateAnalysis({...baseline,headline:'<script>bad</script>'}));
});

test('Radar configured AI bridge sends only backend input and uses rules when configuration or validated response is unavailable',async()=>{
 let sent;const baseline=analyzeRadarEvent(raw()),service=createConfiguredAnalysis({env:{RADAR_AI_ENABLED:'true',RADAR_AI_ENDPOINT:'https://analysis.moex.com/radar',RADAR_AI_API_KEY:'isolated-test-key'},requestImpl:async(url,options)=>{sent={url,options};return {contentType:'application/json',body:JSON.stringify({analysis:{...baseline,headline:'Рекомендация дивидендов'}})};}});
 const result=await service.analyze(raw());assert.equal(result.analysisMethod,'ai');assert.equal(sent.options.body.task,'radar-analysis');assert.equal(sent.options.body.input.rawText,raw().rawText);assert.equal(sent.options.apiKey,'isolated-test-key');assert.ok(!JSON.stringify(result).includes('isolated-test-key'));
 assert.equal((await createConfiguredAnalysis({env:{RADAR_AI_ENABLED:'true'}}).analyze(raw())).analysisMethod,'rules');
 const invalid=createConfiguredAnalysis({env:{RADAR_AI_ENABLED:'true',RADAR_AI_ENDPOINT:'https://analysis.moex.com/radar'},requestImpl:async()=>({contentType:'text/html',body:'private failure'})});assert.equal((await invalid.analyze(raw())).analysisMethod,'rules');
 assert.throws(()=>createConfiguredAnalysis({env:{RADAR_AI_ENABLED:'yes'}}));assert.throws(()=>createConfiguredAnalysis({env:{RADAR_AI_ENDPOINT:'https://127.0.0.1/'}}));
});
test('Radar markup normalization scans malformed input linearly and treats encoded markup as inert text',()=>{
 const started=performance.now();for(const input of ['<'.repeat(60000),'<script'.repeat(8500),'<script>'+('<script>'.repeat(5000)),'<title'.repeat(8500)]){const text=plainText(input,20000);assert.equal(typeof text,'string');assert.ok(text.length<=20000);}
 assert.equal(plainText('<script>discard</script><b>Keep</b>'),'Keep');assert.equal(plainText('&lt;script&gt;inert&lt;/script&gt;'),'<script>inert</script>');
 assert.ok(performance.now()-started<1000,'Malformed markup should not trigger a backtracking scan');
});
test('Radar job cancellation reaches external AI and prevents fallback from continuing a cancelled batch',async()=>{
 const controller=new AbortController();let requests=0;const service=createConfiguredAnalysis({env:{RADAR_AI_ENABLED:'true',RADAR_AI_ENDPOINT:'https://analysis.moex.com/radar'},requestImpl:async(url,{signal,body})=>{requests++;assert.equal(signal,controller.signal);assert.equal(JSON.stringify(body).includes('AbortSignal'),false);return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('Cancelled')),{once:true}));}});
 const pipeline=createPipeline({now,analysis:service}),pending=pipeline.process(raw(),{signal:controller.signal});controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(requests,1);await assert.rejects(pipeline.process(raw(),{signal:controller.signal}),{name:'AbortError'});assert.equal(requests,1);
});

test('Radar demo fixtures cover at least fifteen persisted-ready events and never attach mock prices to real source events',async()=>{
 const provider=createMockProvider({now}),batch=await provider.fetchEvents(),pipeline=createPipeline({now,marketDataProvider:new MockMarketDataProvider()});assert.ok(batch.events.length>=15);
 const results=[];for(const item of batch.events){const event=await pipeline.process(item);assert.equal(event.isDemo,true);assert.equal(event.marketReaction.isDemo,true);assert.equal(event.status,'published');assert.ok(event.sources[0].url.startsWith('https://'));assert.ok(event.trace.length>=5);results.push(event);}
 assert.equal(new Set(results.map(event=>event.id)).size,results.length);assert.ok(results.some(event=>event.assetType==='bond'));assert.ok(results.some(event=>event.importanceScore<5));assert.equal((await provider.fetchEvents({cursor:batch.cursor})).events.length,0);
 const real=await pipeline.process(raw());assert.equal(real.marketReaction,null);assert.equal(real.analysisMethod,'rules');assert.equal(real.notificationSentAt,null);
});
