const FIELDS=['entry','stop','take'];
const TICKER=/^[A-Z0-9][A-Z0-9._:/-]{0,19}$/;
const DECIMAL=/^(?:\d+(?:[.,]\d+)?|[.,]\d+)$/;
const fail=(message,code='TELEGRAM_SIGNAL_INVALID')=>{throw Object.assign(Error(message),{status:400,code});};

export function parsePrice(value){
 if(typeof value==='string'){
  const input=value.trim();
  if(input.length>64||!DECIMAL.test(input))fail('Укажите положительную цену числом. Допустимы точка или запятая, без разделителей тысяч.','TELEGRAM_PRICE_INVALID');
  value=Number(input.replace(',','.'));
 }
 if(typeof value!=='number'||!Number.isFinite(value)||value<=0||value>1e12)fail('Цена должна быть больше нуля и не больше 1 000 000 000 000.','TELEGRAM_PRICE_INVALID');
 return value;
}

export function parseExitPercent(value){
 const input=typeof value==='string'?value.trim().replace(/%$/,'').trim():'';
 if(!/^\d{1,3}(?:[.,]\d{1,2})?$/.test(input))fail('Укажите долю исходного объёма с точностью до 0,01%.','TELEGRAM_EXIT_PERCENT_INVALID');
 const result=Number(input.replace(',','.'));
 if(result<=0||result>=100)fail('Доля частичного выхода должна быть больше 0% и меньше 100%.','TELEGRAM_EXIT_PERCENT_INVALID');
 return result;
}

export function parseExitTime(value,now=Date.now()){
 const input=typeof value==='string'?value.trim():'';
 if(input.toLowerCase()==='сейчас')return new Date(now).toISOString();
 const local=input.match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}:\d{2})(?::(\d{2}))?$/);
 const iso=local?`${local[3]}-${local[2]}-${local[1]}T${local[4]}:${local[5]??'00'}+03:00`:input;
 const date=iso.match(/^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/);
 const at=Date.parse(iso),day=date&&Date.parse(date[1]+'T00:00:00Z');
 if(!date||!Number.isFinite(at)||!Number.isFinite(day)||new Date(day).toISOString().slice(0,10)!==date[1]||at>now)fail('Укажите прошедшие дату и время в формате ДД.ММ.ГГГГ ЧЧ:ММ (МСК) или ISO с часовым поясом.','TELEGRAM_EXIT_TIME_INVALID');
 return new Date(at).toISOString();
}

export function parseEntryRange(value){
 const parts=typeof value==='string'?value.trim().split(/\s*[-–—]\s*|\s+/):[];
 if(parts.length!==2)fail('Отправьте нижнюю и верхнюю цену через пробел. Например: 312,5 314.');
 const [min,max]=parts.map(parsePrice);
 if(min>=max)fail('Верхняя цена диапазона должна быть выше нижней.');
 return {min,max,entry:min+(max-min)/2};
}

export function parseExtraTargets(value,direction,first){
 const values=typeof value==='string'?value.trim().split(/\s+/):[];
 if(values.length<1||values.length>4)fail('Отправьте до четырёх дополнительных целей через пробел.');
 const targets=values.map(parsePrice);
 if(targets.some((target,index)=>direction==='LONG'?target<=(targets[index-1]??first):target>=(targets[index-1]??first)))fail('Каждая следующая цель должна быть дальше предыдущей по направлению сигнала.');
 return targets;
}

/** A partial draft is valid input; completeness and levels are separate checks. */
export function validateSignal(draft){
 if(!draft||typeof draft!=='object'||Array.isArray(draft)||typeof draft.ticker!=='string')fail('Укажите тикер инструмента.','TELEGRAM_TICKER_INVALID');
 const ticker=draft.ticker.trim().toUpperCase();
 if(!TICKER.test(ticker))fail('Проверьте тикер: до 20 латинских букв, цифр и символов . _ : / -.','TELEGRAM_TICKER_INVALID');
 let direction=draft.direction??null;
 if(direction!==null){if(typeof direction!=='string')fail('Направление: LONG или SHORT.');direction=direction.toUpperCase();if(!['LONG','SHORT'].includes(direction))fail('Направление: LONG или SHORT.');}
 let tier=draft.tier??null;if(tier!==null&&!['pro','exclusive'].includes(tier))fail('Тариф: PRO или EX (EXCLUSIVE).');
 const result={ticker,direction,...(tier?{tier}:{}),entry:null,stop:null,take:null,missing:[]};
 for(const field of FIELDS){
  if(draft[field]===null||draft[field]===undefined)result.missing.push(field);
  else result[field]=parsePrice(draft[field]);
 }
 if(!result.missing.length){
  const inferred=result.stop<result.entry&&result.entry<result.take?'LONG':result.take<result.entry&&result.entry<result.stop?'SHORT':null;
  if(inferred===null)fail('Не могу определить направление. Для LONG: стоп < вход < тейк. Для SHORT: тейк < вход < стоп. Проверьте уровни.','TELEGRAM_LEVELS_INVALID');
  if(direction!==null&&direction!==inferred)fail('Направление не соответствует уровням. Для LONG: стоп < вход < тейк. Для SHORT: тейк < вход < стоп.','TELEGRAM_LEVELS_INVALID');
  result.direction=inferred;
 }
 return result;
}

export function parseSignal(value){
 if(typeof value!=='string'||value.length>512||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))fail('Формат: ТИКЕР ВХОД СТОП ТЕЙК. Например: SBER 312.5 307 325.');
 let input=value.trim();
 if(input.startsWith('/')){
  const command=input.match(/^\/(?:s|signal)(?:@[A-Za-z][A-Za-z0-9_]{4,31})?(?:\s+|$)/i);
  if(!command)fail('Для сигнала используйте /s или /signal.','TELEGRAM_COMMAND_INVALID');
  input=input.slice(command[0].length).trim();
 }
 if(!input)fail('Укажите тикер. Формат: ТИКЕР ВХОД СТОП ТЕЙК.','TELEGRAM_TICKER_INVALID');
 const tokens=input.split(/\s+/),ticker=tokens.shift();let direction=null,tier=null;
 // Optional words after the ticker, in any order: LONG/SHORT and the access tier.
 for(let i=0;i<2&&tokens.length;i++){
  if(direction===null&&/^(?:LONG|SHORT|ЛОНГ|ШОРТ)$/i.test(tokens[0])){const word=tokens.shift().toUpperCase();direction=word==='ЛОНГ'?'LONG':word==='ШОРТ'?'SHORT':word;}
  else if(tier===null&&/^(?:PRO|ПРО|EX|EXCL|EXCLUSIVE|ЭКС|ЭКСКЛЮЗИВ)$/i.test(tokens[0])){tier=/^(?:PRO|ПРО)$/i.test(tokens.shift())?'pro':'exclusive';}
 }
 if(tokens.length>FIELDS.length)fail('Лишние значения. Порядок: ТИКЕР [LONG/SHORT] [PRO/EX] ВХОД СТОП ТЕЙК. В этой версии поддерживается один тейк.');
 const draft={ticker,direction,...(tier?{tier}:{})};
 for(let index=0;index<tokens.length;index++)draft[FIELDS[index]]=parsePrice(tokens[index]);
 return validateSignal(draft);
}

export function signalMetrics(draft){
 const value=validateSignal(draft);
 if(value.missing.length)fail('Для расчёта нужны вход, стоп и тейк.','TELEGRAM_SIGNAL_INCOMPLETE');
 const riskPercent=Math.abs(value.entry-value.stop)/value.entry*100,potentialPercent=Math.abs(value.take-value.entry)/value.entry*100,riskReward=potentialPercent/riskPercent;
 if(![riskPercent,potentialPercent,riskReward].every(number=>Number.isFinite(number)&&number>0))fail('Уровни слишком близки или выходят за точность расчёта. Проверьте цены.','TELEGRAM_LEVELS_INVALID');
 return {riskPercent,potentialPercent,riskReward};
}

export class TelegramSignalParser {
 parse(text){return parseSignal(text);}
 parseSignal(text){return parseSignal(text);}
 parsePrice(value){return parsePrice(value);}
 validate(draft){return validateSignal(draft);}
 metrics(draft){return signalMetrics(draft);}
}
