import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import {isAdmin,hasSubscription,canReadStrategy} from './access.mjs';

const strategies=new Set(['Momentum RU','Trend RU','Импульс','Crypto Momentum','Crypto Trend','Orbita Exclusive']);
const limits={ticker:20,name:80,title:100,summary:350,horizon:50,strategy:60,thesis:2000,entryRule:1000,cancelRule:1000};
const dataFields=[...Object.keys(limits),'market','dir','entry','stop','target'];
const levelFields=['entry','stop','target','entryRule','cancelRule','title','summary','thesis','horizon','name'];
const format=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
const stamp=at=>format.format(new Date(at)).replace(',',' ·');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
const clone=value=>structuredClone(value);
const initialDatabase=()=>({version:1,revision:0,records:[]});
const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
const isObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
function allowed(object,keys){if(!isObject(object)||Object.keys(object).some(key=>!keys.includes(key)))fail('Запрос содержит недопустимые поля.')}
function text(value,field,{required=false,fallback=''}={}){
  if(value===undefined||value===null)value=fallback;
  if(typeof value!=='string')fail(`Поле «${field}» должно быть строкой.`);
  const normalized=value.trim();
  if(normalized.length>(limits[field]||1500)||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)||(required&&!normalized))fail(`Проверьте поле «${field}».`);
  return normalized;
}
function price(value,field){if(typeof value!=='number'||!Number.isFinite(value)||value<=0||value>1e12)fail(`Поле «${field}»: укажите положительное число до 1 000 000 000 000.`);return value}
function requireAdmin(user){if(!user)fail('Войдите в аккаунт.',401);if(!isAdmin(user))fail('Доступно только администратору.',403)}
function requireReader(user){if(!user)fail('Войдите в аккаунт.',401);if(!hasSubscription(user))fail('Для доступа к идеям нужна действующая подписка.',403)}
function idValue(id){if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(id))fail('Некорректный идентификатор идеи.');return id}
function levels(d){
  for(const field of ['entry','stop','target'])price(d[field],field);
  if(d.dir==='ЛОНГ'&&!(d.stop<d.entry&&d.entry<d.target))fail('Для лонга: стоп < вход < цель.');
  if(d.dir==='ШОРТ'&&!(d.target<d.entry&&d.entry<d.stop))fail('Для шорта: цель < вход < стоп.');
  if(!d.entryRule||!d.cancelRule)fail('Укажите условия входа, отмены и выхода.');
}
function configuration(input,mode){
  allowed(input,dataFields);
  const strategy=text(input.strategy,'strategy',{fallback:'Momentum RU'});
  if(!strategies.has(strategy))fail('Выберите существующую стратегию.');
  const market=input.market??'stocks',dir=input.dir??(mode==='draft'?'ЛОНГ':undefined);
  if(!['stocks','futures','crypto'].includes(market)||!['ЛОНГ','ШОРТ'].includes(dir))fail('Выберите рынок и направление.');
  const ticker=text(input.ticker,'ticker',{required:mode!=='draft'});
  if(ticker&&!/^[\p{L}\p{N}._:/-]+$/u.test(ticker))fail('Тикер содержит недопустимые символы.');
  const d={ticker,name:text(input.name,'name',{fallback:ticker}),market,dir,strategy,
    title:text(input.title,'title',{fallback:ticker?`Новый сигнал ${ticker} · ${dir}`:''}),
    summary:text(input.summary,'summary',{fallback:mode==='quick'?'Сигнал опубликован. Уровни и условия будут добавлены автором.':''}),
    thesis:text(input.thesis,'thesis'),horizon:text(input.horizon,'horizon',{fallback:strategy==='Orbita Exclusive'?'2–8 недель':strategy==='Импульс'?'Внутри дня':'1–5 дней'}),
    entryRule:text(input.entryRule,'entryRule'),cancelRule:text(input.cancelRule,'cancelRule'),
    entry:null,stop:null,target:null,
    unit:market==='stocks'?'₽':market==='futures'?'пт':'USDT'};
  if(mode==='full'){
    for(const field of ['entry','stop','target'])d[field]=price(input[field],field);
    levels(d);
  }else if(mode==='draft'){
    for(const field of ['entry','stop','target'])if(input[field]!=null&&input[field]!=='')d[field]=price(input[field],field);
  }else{
    // A quick signal carries no executable levels, even if the form supplied stale values.
    d.entryRule='';d.cancelRule='';
  }
  return d;
}
function setChart(d){
  if([d.entry,d.stop,d.target].every(Number.isFinite)){
    const lo=Math.min(d.entry,d.stop,d.target),hi=Math.max(d.entry,d.stop,d.target),pad=Math.max((hi-lo)*.15,d.entry*.001);
    d.min=lo-pad;d.max=hi+pad;d.current=d.entry;d.points=Array(28).fill(d.entry);
  }else{d.min=null;d.max=null;d.current=null;d.points=[]}
  d.chartPlaceholder=true;
}
function snapshot(record,at){return {...Object.fromEntries(dataFields.map(field=>[field,record.d[field]])),publishedAt:at,reconstructed:false}}
function state(record){return {state:record.d.state,status:record.d.status,entry:record.d.entry,stop:record.d.stop,target:record.d.target,current:record.d.current,outcome:record.d.outcome??null,exit:record.meta.exit??null,erroneous:!!record.erroneous}}
function event(record,{type,title,body,note=body,before=null,after=state(record),at,actor}){
  record.meta.updated=stamp(at);record.meta.updatedAt=at;
  record.meta.events.push([stamp(at),title,body,{id:'event-'+randomUUID(),type,at,note,before:clone(before),after:clone(after),actorId:actor?.id??null}]);
}
function makeRecord(user,payload,id='idea-'+randomUUID()){
  allowed(payload,['mode','d','revision']);
  if(!['quick','full','draft'].includes(payload.mode))fail('Выберите режим публикации: quick, full или draft.');
  const at=new Date().toISOString(),d=configuration(payload.d,payload.mode),published=payload.mode!=='draft';
  d.state=!published?'draft':payload.mode==='quick'?'announced':'waiting';
  d.status=!published?'Черновик':payload.mode==='quick'?'Новый сигнал':'Ожидает входа';setChart(d);
  const record={id,published,d,createdAt:at,createdBy:user.id,meta:{published:null,publishedAt:null,updated:stamp(at),updatedAt:at,entryRule:d.entryRule,cancelRule:d.cancelRule,events:[]}};
  if(published){
    record.meta.published=stamp(at);record.meta.publishedAt=at;record.meta.initial=snapshot(record,at);
    event(record,{type:'published',title:'Идея опубликована',body:payload.mode==='quick'?'Новый сигнал без уровней. Вход ещё не подтверждён; условия будут добавлены отдельным событием.':'Уровни и условия зафиксированы. Ожидает подтверждения входа.',after:record.meta.initial,at,actor:user});
  }
  return record;
}
function applyUpdate(record,user,payload){
  allowed(payload,['action','note','price','revision','d',...levelFields]);
  const {action}=payload;
  if(typeof action!=='string')fail('Укажите действие.');
  if(action!=='levels'&&(own(payload,'d')||levelFields.some(field=>own(payload,field))))fail('Редактировать условия можно только отдельным событием добавления уровней.');
  if(record.erroneous&&action!=='note')fail('Для ошибочной публикации доступны только комментарии.');
  const at=new Date().toISOString(),before=state(record),d=record.d,m=record.meta;
  let note=text(payload.note,'note',{required:action!=='levels',fallback:action==='levels'?'Автор добавил уровни и условия входа.':''}),title='Комментарий автора',body=note;
  if(action==='levels'){
    if(d.state!=='announced')fail('Уровни можно добавить только к сигналу без уровней.');
    const data=payload.d??Object.fromEntries(levelFields.filter(field=>own(payload,field)).map(field=>[field,payload[field]]));allowed(data,levelFields);
    const proposed={...d};
    for(const field of ['entry','stop','target'])proposed[field]=price(data[field],field);
    for(const field of levelFields.filter(field=>!['entry','stop','target'].includes(field)))if(own(data,field))proposed[field]=text(data[field],field);
    levels(proposed);Object.assign(d,proposed,{state:'waiting',status:'Ожидает входа'});setChart(d);
    m.entryRule=d.entryRule;m.cancelRule=d.cancelRule;m.levelsPublishedAt=at;m.initialLevels=snapshot(record,at);
    title='Уровни и условия добавлены';body=`${d.ticker}: вход ${d.entry}, стоп ${d.stop}, цель ${d.target} ${d.unit}. ${note}`;
  }else if(action==='activate'){
    if(d.state!=='waiting')fail('Подтвердить вход можно только после добавления уровней ожидающей идеи.');levels(d);
    d.state='active';d.status='Активен';m.enteredAt=at;title='Вход подтверждён';
  }else if(action==='cancel'){
    if(!['announced','waiting'].includes(d.state))fail('Отмена доступна только до входа.');
    d.state='cancelled';d.status='Отменён';d.outcome='Отменён до входа';title=d.outcome;
  }else if(action==='stop-change'){
    if(!['waiting','active'].includes(d.state))fail('Изменить стоп можно только после публикации уровней и до закрытия.');
    const next=price(payload.price,'stop');
    if(next===d.stop)fail('Новый стоп совпадает с текущим.');
    if((d.dir==='ЛОНГ'&&next>=d.target)||(d.dir==='ШОРТ'&&next<=d.target))fail('Стоп должен оставаться до цели по направлению сделки.');
    if(d.state==='waiting'&&((d.dir==='ЛОНГ'&&next>=d.entry)||(d.dir==='ШОРТ'&&next<=d.entry)))fail('До входа стоп должен быть за уровнем входа.');
    const n=value=>value.toLocaleString('ru-RU',{maximumFractionDigits:8});title='Стоп изменён';body=`${d.ticker}: стоп изменён с ${n(d.stop)} до ${n(next)} ${d.unit}. ${note}`;d.stop=next;
    const lo=Math.min(d.entry,d.stop,d.target),hi=Math.max(d.entry,d.stop,d.target);d.min=lo-(hi-lo)*.15;d.max=hi+(hi-lo)*.15;
  }else if(['target','stop','manual'].includes(action)){
    if(d.state!=='active')fail('Завершить можно только активную идею.');
    const exit=price(action==='target'?d.target:action==='stop'?d.stop:payload.price,'exit');
    d.state='closed';d.status='Завершён';d.outcome=action==='target'?'Цель достигнута':action==='stop'?'Стоп достигнут':'Закрыто вручную';d.current=exit;m.exit=exit;m.closedAt=at;title=d.outcome;
  }else if(action==='error'){
    record.erroneous=true;m.errorReason=note;m.error={reason:note,at};title='Ошибочная публикация';
  }else if(action!=='note')fail('Неизвестное действие.');
  event(record,{type:action,title,body,note,before,after:action==='levels'?{...state(record),...m.initialLevels}:state(record),at,actor:user});
}
function checkRevision(db,payload){if(!isObject(payload))fail('Некорректный запрос.');if(own(payload,'revision')&&(!Number.isInteger(payload.revision)||payload.revision!==db.revision))fail('Данные изменились. Обновите список перед сохранением.',409)}

// Explicitly imported demonstration records are never part of normal startup.
function demoRecord(source,user,importedAt){
  const record=clone(source);record.demo=true;record.importedAt=importedAt;record.importedBy=user.id;
  const m=record.meta;
  const parse=value=>{const p=String(value).match(/^(\d{2})\.(\d{2})(?:\.(\d{4}))?\s*·\s*(\d{2}):(\d{2})$/);return p?new Date(`${p[3]||m.published.match(/\d{2}\.\d{2}\.(\d{4})/)[1]}-${p[2]}-${p[1]}T${p[4]}:${p[5]}:00+03:00`).toISOString():null};
  m.publishedAt=parse(m.published);m.updatedAt=parse(m.updated);
  m.initial=snapshot(record,m.publishedAt);m.initial.entryRule=m.entryRule;m.initial.cancelRule=m.cancelRule;
  record.d.entryRule=m.entryRule;record.d.cancelRule=m.cancelRule;
  m.events=m.events.map(([time,title,body])=>{
    const at=parse(time),type=/публик/i.test(title)?'published':/вход подтвержд/i.test(title)?'activate':/цели|цель достиг/i.test(title)?'target':/стопу|стоп достиг/i.test(title)?'stop':'note';
    if(type==='activate')m.enteredAt=at;if(['target','stop'].includes(type))m.closedAt=at;
    return [stamp(at),title,body,{id:'event-'+randomUUID(),type,at,demo:true}];
  });
  return record;
}

export async function createIdeas(directory){
  await mkdir(directory,{recursive:true,mode:0o700});
  const file=path.join(directory,'ideas.json'),lock=file+'.lock';let queue=Promise.resolve();
  async function load(){
    let db;try{db=JSON.parse(await readFile(file,'utf8'))}catch(error){if(error.code==='ENOENT')return initialDatabase();throw error}
    if(db.version!==1||!Number.isInteger(db.revision)||db.revision<0||!Array.isArray(db.records))throw new Error('Некорректная база идей. Сохраните резервную копию перед восстановлением.');return db;
  }
  async function acquire(){
    const deadline=Date.now()+5000;
    while(true){
      try{await mkdir(lock,{mode:0o700});try{await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,at:Date.now()}),{mode:0o600})}catch(error){await rm(lock,{recursive:true,force:true});throw error}return}
      catch(error){
        if(error.code!=='EEXIST')throw error;
        // A crashed CLI/server must not leave the database locked permanently.
        try{const owner=JSON.parse(await readFile(path.join(lock,'owner.json'),'utf8'));try{process.kill(owner.pid,0)}catch(gone){if(gone.code==='ESRCH'){await rm(lock,{recursive:true,force:true});continue}}}
        catch(missing){if(missing.code==='ENOENT'){try{if(Date.now()-(await stat(lock)).mtimeMs>30000){await rm(lock,{recursive:true,force:true});continue}}catch{}}}
        if(Date.now()>=deadline)fail('База идей занята. Повторите действие.',409);
        await new Promise(resolve=>setTimeout(resolve,25));
      }
    }
  }
  function transaction(mutate){
    const job=queue.then(async()=>{
      await acquire();let temp;
      try{
        const db=await load(),result=mutate(db);
        if(result.unchanged)return {revision:db.revision,...result.value};
        db.revision++;temp=file+`.tmp-${process.pid}-${randomUUID()}`;
        await writeFile(temp,JSON.stringify(db),{mode:0o600});await rename(temp,file);temp=null;
        return {revision:db.revision,...result.value};
      }finally{if(temp)await rm(temp,{force:true});await rm(lock,{recursive:true,force:true})}
    });
    queue=job.catch(()=>{});return job;
  }
  async function list(user){requireReader(user);await queue;const db=await load();return {revision:db.revision,records:clone(db.records.filter(record=>isAdmin(user)||(record.published&&canReadStrategy(user,record.d.strategy))))}}
  async function get(id,user){requireReader(user);idValue(id);await queue;const db=await load(),record=db.records.find(record=>record.id===id);if(!record||(!isAdmin(user)&&(!record.published||!canReadStrategy(user,record.d.strategy))))fail('Идея недоступна.',404);return clone(record)}
  async function create(user,payload){requireAdmin(user);return transaction(db=>{checkRevision(db,payload);const record=makeRecord(user,payload);db.records.unshift(record);return {value:{record:clone(record)}}})}
  async function update(user,id,payload){
    requireAdmin(user);idValue(id);
    return transaction(db=>{
      if(!isObject(payload))fail('Некорректный запрос.');checkRevision(db,payload);
      const index=db.records.findIndex(record=>record.id===id);if(index<0)fail('Идея не найдена.',404);
      let record=db.records[index];
      if(!record.published){record=makeRecord(user,payload,id);record.createdAt=db.records[index].createdAt;record.createdBy=db.records[index].createdBy;db.records[index]=record}
      else applyUpdate(record,user,payload);
      return {value:{record:clone(record)}};
    });
  }
  async function remove(user,id){requireAdmin(user);idValue(id);return transaction(db=>{const index=db.records.findIndex(record=>record.id===id);if(index<0)fail('Идея не найдена.',404);if(db.records[index].published)fail('Опубликованную идею нельзя удалить. Отметьте ошибочную публикацию с причиной.',409);db.records.splice(index,1);return {value:{ok:true}}})}
  async function importDemo(user){
    requireAdmin(user);const seeds=JSON.parse(await readFile(new URL('../fixtures/demo-ideas.json',import.meta.url),'utf8'));
    return transaction(db=>{const at=new Date().toISOString(),added=seeds.filter(source=>!db.records.some(record=>record.id===source.id)).map(source=>demoRecord(source,user,at));db.records.push(...added);return {unchanged:!added.length,value:{imported:added.length}}});
  }
  return {list,get,create,update,remove,importDemo};
}
