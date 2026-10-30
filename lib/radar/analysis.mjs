import {plainText,validateAnalysis} from './model.mjs';
import {safeSourceUrl} from './model.mjs';
import {safeHttpPost} from './providers/http.mjs';
const n=value=>{const result=Number(String(value).replace(/\s/g,'').replace(',','.'));return Number.isFinite(result)?result:null;};
const numberPattern='([0-9]+(?:[ \\u00a0][0-9]{3})*(?:[.,][0-9]+)?)';
const descriptions={DIVIDEND:['Дивиденды','Размер и условия выплаты могут изменить ожидания денежных поступлений акционерам. Решение совета директоров ещё требует выполнения указанных в раскрытии процедур.'],EARNINGS:['Финансовая отчётность','Результаты показывают состояние бизнеса. Для оценки нужны сравнимый период, долговая нагрузка и ожидания рынка.'],GUIDANCE:['Прогноз компании','Обновлённые ориентиры могут повлиять на ожидания будущих результатов. Прогноз не гарантирует его исполнения.'],BUYBACK:['Обратный выкуп','Выкуп может повлиять на количество акций в обращении и распределение капитала. Важны размер и условия программы.'],SPO:['Вторичное размещение','Размещение может увеличить предложение бумаг. Условия, цена и продавец определяют последствия для акционеров.'],SECONDARY_OFFERING:['Продажа пакета акций','Продажа существующих акций может изменить предложение бумаг и структуру акционеров.'],SHARE_ISSUE:['Дополнительная эмиссия','Новый выпуск акций может изменить доли акционеров и структуру капитала.'],M_AND_A:['Корпоративная сделка','Сделка может изменить структуру бизнеса, долговую нагрузку и будущие денежные потоки.'],CONTRACT:['Новый контракт','Контракт может повлиять на будущую выручку. Его вклад зависит от суммы, срока и рентабельности.'],BOARD_MEETING:['Заседание совета директоров','Это повестка предстоящего заседания, а не принятое решение. Следует дождаться результатов и условий.'],BOARD_DECISION:['Решение совета директоров','Принятое решение следует оценивать по конкретным условиям и срокам реализации.'],MANAGEMENT_CHANGE:['Изменение руководства','Смена руководства может повлиять на стратегию и исполнение планов компании.'],CREDIT_RATING:['Кредитный рейтинг','Рейтинговое действие отражает оценку кредитного риска и может влиять на условия финансирования.'],DEFAULT:['Дефолт','Неисполнение обязательств увеличивает кредитный риск. Важны выпуск, сумма задолженности и условия урегулирования.'],TECHNICAL_DEFAULT:['Технический дефолт','Нарушение срока выплаты требует проверки причин, льготного периода и последующего исполнения обязательств.'],BANKRUPTCY:['Банкротство','Событие может существенно повысить риск потерь кредиторов и акционеров. Следует проверить стадию процедуры.'],DEBT:['Долговые обязательства','Изменение долга влияет на финансовую устойчивость и будущие выплаты.'],BOND_COUPON:['Купон по облигации','Размер и срок купона определяют денежный поток по конкретному выпуску.'],BOND_OFFER:['Оферта по облигации','Условия оферты определяют возможность предъявления облигаций и сроки действий владельца.'],BOND_REDEMPTION:['Погашение облигации','Погашение изменяет денежный поток и срок обращения выпуска.'],CAPEX:['Капитальные затраты','Инвестиции влияют на развитие бизнеса и свободный денежный поток; высокий CAPEX сам по себе не означает негатив.'],CORPORATE_ACTION:['Корпоративное действие','Изменение параметров бумаг может потребовать действий владельца.'],LEGAL:['Правовое событие','Правовой спор или ограничение может повлиять на обязательства и деятельность компании.'],OTHER:['Корпоративное сообщение','Событие требует проверки первоисточника. Его влияние пока не определено.']};
function classify(text){
 if(/(?:не\s+(?:допущен|зафиксирован|выявлен)|отсутстви[ея]|без)\s+(?:техническ\S*\s+)?дефолт|дефолт[^.\n]{0,25}не\s+(?:допущен|зафиксирован|наступил|произошел)/.test(text))return 'OTHER';
 if(/(?:заседани\S*\s+совета|совет\S*\s+директор\S*\s+(?:рассмотрит|обсудит)|повестк[аи])/.test(text)&&!/(?:рекомендовал|принял решение|утвердил|решено|решени[ея] совета)/.test(text))return 'BOARD_MEETING';
 if(/техническ\S*\s+дефолт/.test(text))return 'TECHNICAL_DEFAULT';
 if(/дефолт|не\s+исполнил\S*\s+(?:обязательств|выплат)|неисполнени\S*\s+обязательств/.test(text))return 'DEFAULT';
 if(/банкротств/.test(text))return 'BANKRUPTCY';
 if(/дополнительн\S*\s+эмисси|допэмисси|дополнительн\S*\s+выпуск\S*\s+акци/.test(text))return 'SHARE_ISSUE';
 if(/\bspo\b|вторичн\S*\s+размещени/.test(text))return 'SPO';
 if(/продаж\S*\s+пакет\S*\s+акци/.test(text))return 'SECONDARY_OFFERING';
 if(/дивиденд/.test(text))return 'DIVIDEND';
 if(/обратн\S*\s+выкуп|buyback/.test(text))return 'BUYBACK';
 if(/купон/.test(text))return 'BOND_COUPON';
 if(/оферт\S*\s+(?:по\s+)?облигац|облигац\S*[\s\S]{0,35}оферт/.test(text))return 'BOND_OFFER';
 if(/погашени\S*\s+облигац/.test(text))return 'BOND_REDEMPTION';
 if(/рейтинг|рейтингов/.test(text))return 'CREDIT_RATING';
 if(/приобретени\S*\s+(?:компани|бизнес)|слияни|поглощени|\bm&a\b/.test(text))return 'M_AND_A';
 if(/guidance|прогноз|ориентир/.test(text))return 'GUIDANCE';
 if(/отчетност|отчётност|финансов\S*\s+результат|ebitda|выручк|чист\S*\s+прибыл/.test(text))return 'EARNINGS';
 if(/capex|капитальн\S*\s+затрат/.test(text))return 'CAPEX';
 if(/контракт|договор\S*\s+поставк/.test(text))return 'CONTRACT';
 if(/руководств|генеральн\S*\s+директор|смен\S*\s+менеджмент/.test(text))return 'MANAGEMENT_CHANGE';
 if(/решени\S*\s+совета|совет\S*\s+директор\S*\s+(?:принял|утвердил)/.test(text))return 'BOARD_DECISION';
 if(/суд|иск\b|арбитраж|правов/.test(text))return 'LEGAL';
 if(/долг|кредит|обязательств|залог/.test(text))return 'DEBT';
 if(/дроблени|консолидаци|конвертаци|корпоративн\S*\s+действи/.test(text))return 'CORPORATE_ACTION';
 return 'OTHER';
}
export function analyzeRadarEvent(input){
 const title=plainText(input.title||'',300),body=plainText(input.rawText||'',20000),text=(title+' '+body).toLocaleLowerCase('ru-RU').replace(/ё/g,'е'),eventType=classify(text),[label,whyImportant]=descriptions[eventType];
 const extractedData={};let impact='NEUTRAL',score=({DIVIDEND:7.8,EARNINGS:7,GUIDANCE:7.2,BUYBACK:8,SPO:9,SECONDARY_OFFERING:7.8,SHARE_ISSUE:9,M_AND_A:8.2,CONTRACT:6.6,BOARD_MEETING:4,BOARD_DECISION:5,MANAGEMENT_CHANGE:6.2,CREDIT_RATING:7,DEFAULT:10,TECHNICAL_DEFAULT:9.6,BANKRUPTCY:10,DEBT:6.5,BOND_COUPON:5.2,BOND_OFFER:6.3,BOND_REDEMPTION:5.2,CAPEX:6.5,CORPORATE_ACTION:5.5,LEGAL:6,OTHER:3})[eventType];
 const tags=[];if(/дивиденд/.test(text))tags.push('dividend');if(/облигац|купон/.test(text)||input.assetType==='bond')tags.push('bonds');
 if(eventType==='BOARD_MEETING'&&tags.includes('dividend'))score=7;
 if(eventType==='DIVIDEND'){
  const match=text.match(new RegExp('(?:дивиденд[^.\\n]{0,70}?(?:в размере|составит|выплатить|выплату|рекомендовал[а-я ]*)[: ]*|рекомендовано[: ]*)'+numberPattern+'\\s*(?:₽|руб)'))||text.match(new RegExp(numberPattern+'\\s*(?:₽|руб(?:л[еяй])?)\\s*(?:на|за)\\s*(?:одну\\s+)?акци'));
  if(match){extractedData.dividendPerShare=n(match[1]);extractedData.currency='RUB';}
  if(!/не\s+отмен/.test(text)&&/(?:отмен[а-я]*|не\s+(?:рекомендовал[а-я]*|выплачивать|выплатит|будет выплачивать)|отказ[а-я]*)[^.\n]{0,70}дивиденд|дивиденд[^.\n]{0,70}(?:отмен[а-я]*|не\s+выплачивать)/.test(text)){impact='NEGATIVE';score=9.3;extractedData.cancelled=true;}
  else impact=extractedData.dividendPerShare>0?'POSITIVE':'NEUTRAL';
 }
 if(['DEFAULT','TECHNICAL_DEFAULT','BANKRUPTCY','SPO','SHARE_ISSUE'].includes(eventType))impact='NEGATIVE';
 if(eventType==='BUYBACK')impact='POSITIVE';
 if(eventType==='CREDIT_RATING'){if(!/не\s+(?:пони[зж]|сниж)/.test(text)&&/пони[зж]|сниж|негативн/.test(text))impact='NEGATIVE';else if(!/не\s+повы[сш]/.test(text)&&/повы[сш]|позитивн/.test(text))impact='POSITIVE';}
 if(eventType==='GUIDANCE'){if(/пони[зж]|сниж|сократ/.test(text))impact='NEGATIVE';else if(/повы[сш]|увелич/.test(text))impact='POSITIVE';}
 if(eventType==='EARNINGS'){if(/(?:выручк|прибыл|ebitda)[^.\n]{0,45}(?:вырос|увелич|рост)/.test(text))impact='POSITIVE';if(/(?:убыток|снизил|снижен|упал)/.test(text))impact=impact==='POSITIVE'?'MIXED':'NEGATIVE';}
 const actual=Number.isFinite(input.actualValue)?input.actualValue:extractedData.dividendPerShare??null,expected=Number.isFinite(input.expectedValue)?input.expectedValue:null,previous=Number.isFinite(input.previousValue)?input.previousValue:null;
 if(actual!==null)extractedData.actualValue=actual;if(expected!==null)extractedData.expectedValue=expected;if(previous!==null)extractedData.previousValue=previous;
 if(actual!==null&&expected!==null&&expected!==0){extractedData.surprisePercent=(actual-expected)/Math.abs(expected)*100;if(Math.abs(extractedData.surprisePercent)>=10&&['DIVIDEND','EARNINGS','GUIDANCE'].includes(eventType)){score=Math.max(score,9.1);impact=extractedData.surprisePercent>0?'POSITIVE':'NEGATIVE';}}
 let headline=title||label;
 if(!Number.isFinite(expected)&&/(?:выше|ниже)\s+(?:ожидани[яй]|прогноз)/i.test(headline))headline=label+' — опубликованы условия';
 const summary=body?body.slice(0,600):title||label;
 return validateAnalysis({eventType,importanceScore:score,impact,confidence:eventType==='OTHER'?.35:.72,headline:headline.slice(0,180),summary,whyImportant,extractedData,tags});
}
export function createRadarAnalysisService({ai=null,enabled=false}={}){
 return {async analyze(input){input.signal?.throwIfAborted();const fallback=analyzeRadarEvent(input);if(!enabled||typeof ai!=='function')return {...fallback,analysisMethod:'rules'};
  try{const output=validateAnalysis(await ai({...input,rawText:plainText(input.rawText||'',20000)}));
   // Expectations and facts are obtained from the source, never invented by a model.
   output.extractedData=fallback.extractedData;
   const narrative=output.headline+' '+output.summary+' '+output.whyImportant,numbers=text=>[...String(text).matchAll(/\d+(?:[.,]\d+)?/g)].map(match=>Number(match[0].replace(',','.'))),knownNumbers=new Set(numbers(input.title+' '+input.rawText));
   for(const value of [input.actualValue,input.expectedValue,input.previousValue,fallback.extractedData.surprisePercent])if(Number.isFinite(value))knownNumbers.add(value);
   if(numbers(narrative).some(value=>!knownNumbers.has(value))||!Number.isFinite(input.expectedValue)&&/(?:выше|ниже)[^.\n]{0,35}ожидани|превыс[^.\n]{0,35}ожидани|(?:консенсус|consensus)\s*[:=]/i.test(narrative)||/\bBUY\b|\bSELL\b|покупайте|продавайте/i.test(narrative))return {...fallback,analysisMethod:'rules'};
   return {...output,analysisMethod:'ai'};
  }catch{input.signal?.throwIfAborted();return {...fallback,analysisMethod:'rules'};}
 }};
}
// A generic, backend-only adapter: the operator supplies a compliant analysis
// service. No external AI vendor or key is presumed by the local MVP.
export function createConfiguredAnalysis({env=process.env,requestImpl=safeHttpPost}={}){
 const flag=env.RADAR_AI_ENABLED;if(flag!==undefined&&!['','true','false','1','0'].includes(flag))throw Error('RADAR_AI_ENABLED: используйте true или false.');
 const enabled=['true','1'].includes(flag),endpoint=env.RADAR_AI_ENDPOINT||'',apiKey=env.RADAR_AI_API_KEY||'';
 if(endpoint)safeSourceUrl(endpoint);
 const ai=enabled&&endpoint?async input=>{
  const response=await requestImpl(endpoint,{apiKey,signal:input.signal,body:{task:'radar-analysis',input:{title:input.title,rawText:input.rawText,company:input.company||null,ticker:input.ticker,sourceType:input.sourceType,actualValue:input.actualValue??null,expectedValue:input.expectedValue??null,previousValue:input.previousValue??null}}});
  if(response.contentType!=='application/json')throw new TypeError('RADAR_INVALID_AI_RESPONSE');
  const value=JSON.parse(response.body);return value.analysis||value;
 }:null;
 return createRadarAnalysisService({enabled,ai});
}
