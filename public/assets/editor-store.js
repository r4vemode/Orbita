(() => {
  const key='orbita.editor.v1';
  const clone=x=>JSON.parse(JSON.stringify(x));
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const fields=['ticker','name','market','dir','title','summary','entry','stop','target','horizon','strategy','thesis','entryRule','cancelRule'];
  const format=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
  const stamp=(at=new Date())=>format.format(new Date(at)).replace(',',' ·');
  const uid=()=>`event-${globalThis.crypto?.randomUUID?.()||`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
  const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safe=x=>typeof x==='string'?escape(x):Array.isArray(x)?x.map(safe):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).map(([k,v])=>[k,safe(v)])):x;
  function parseDate(value,base){
    if(typeof value!=='string')return null;
    if(/^\d{4}-\d{2}-\d{2}T/.test(value)){const date=new Date(value);return Number.isNaN(date.getTime())?null:date.toISOString()}
    const match=value.match(/^(\d{2})\.(\d{2})(?:\.(\d{4}))?\s*[·,]?\s*(\d{2}):(\d{2})$/);
    if(!match)return null;
    const baseParts=base?Object.fromEntries(format.formatToParts(new Date(base)).map(p=>[p.type,p.value])):null;
    let year=match[3]||baseParts?.year;
    if(!year)return null;
    // Old event labels omitted the year. December publications can continue in January.
    if(!match[3]&&baseParts&&Number(match[2])<Number(baseParts.month))year=String(Number(year)+1);
    const date=new Date(`${year}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:00+03:00`);
    return Number.isNaN(date.getTime())?null:date.toISOString();
  }
  function snapshot(d,m,at,reconstructed=false){
    const initial=Object.fromEntries(fields.filter(f=>d[f]!==undefined).map(f=>[f,d[f]]));
    initial.entryRule=m?.entryRule??d.entryRule??'';
    initial.cancelRule=m?.cancelRule??d.cancelRule??'';
    initial.publishedAt=at;initial.reconstructed=reconstructed;
    if(reconstructed)initial.reconstructedReason='Восстановлено из сохранённых данных: первоначальные уровни до ведения журнала не подтверждены.';
    return initial;
  }
  function legacyType(title){
    if(/публик/i.test(title))return 'published';
    if(/вход подтвержд/i.test(title))return 'activate';
    if(/стоп.*измен/i.test(title))return 'stop-change';
    if(/ошибоч/i.test(title))return 'error';
    if(/цели|цель достиг/i.test(title))return 'target';
    if(/стопу|стоп достиг/i.test(title))return 'stop';
    if(/ручн/i.test(title))return 'manual';
    if(/отмен/i.test(title))return 'cancel';
    return 'note';
  }
  function migrate(record){
    if(!record.published)return record;
    const m=record.meta||(record.meta={});
    const publishedAt=m.publishedAt||parseDate(m.published);
    m.publishedAt=publishedAt;
    if(!m.initial)m.initial=snapshot(record.d,m,publishedAt,true);
    if(!Array.isArray(m.events))m.events=[];
    m.events=m.events.map((old,index)=>{
      const event=[...old],at=event[3]?.at||parseDate(event[0],publishedAt);
      if(at)event[0]=stamp(at);
      if(!event[3])event[3]={id:`${record.id}:legacy:${index}`,type:legacyType(event[1]),at,legacy:true};
      return event;
    });
    return record;
  }
  function read(){
    const raw=localStorage.getItem(key);let db;
    try{db=raw?JSON.parse(raw):{version:1,revision:0,records:clone(window.ORBITA_SEED||[])}}catch{throw Error('Не удалось прочитать локальные данные. Сначала экспортируйте резервную копию.')}
    if(db.version!==1||!Array.isArray(db.records)||!Number.isInteger(db.revision)||db.revision<0)throw Error('Не удалось прочитать локальные данные. Сначала экспортируйте резервную копию.');
    // Add new catalogue examples without restoring any previously removed legacy ideas.
    if(raw)for(const seed of window.ORBITA_SEED||[]){if(seed.id.startsWith('exclusive-')&&!db.records.some(r=>r.id===seed.id))db.records.push(clone(seed))}
    db.records.forEach(migrate);return db;
  }
  function validate(d){
    for(const f of ['ticker','name','title','summary','thesis','horizon','strategy','entryRule','cancelRule'])if(!String(d[f]||'').trim())throw Error('Заполните все поля перед публикацией.');
    if(!['stocks','futures','crypto'].includes(d.market)||!['ЛОНГ','ШОРТ'].includes(d.dir))throw Error('Выберите рынок и направление.');
    for(const f of ['entry','stop','target'])if(!Number.isFinite(d[f])||d[f]<=0)throw Error('Уровни должны быть положительными числами.');
    if(d.dir==='ЛОНГ'&&!(d.stop<d.entry&&d.entry<d.target))throw Error('Для лонга: стоп < вход < цель.');
    if(d.dir==='ШОРТ'&&!(d.target<d.entry&&d.entry<d.stop))throw Error('Для шорта: цель < вход < стоп.');
  }
  function publishAt(record,at,id){
    if(record.published)throw Error('Идея уже опубликована.');
    validate(record.d);
    const d=record.d,t=stamp(at),lo=Math.min(d.stop,d.target),hi=Math.max(d.stop,d.target),pad=(hi-lo)*.15;
    const initial=snapshot(d,null,at);
    Object.assign(d,{state:'waiting',status:'Ожидает входа',unit:d.market==='stocks'?'₽':d.market==='futures'?'пт':'USDT',current:d.entry,min:lo-pad,max:hi+pad,points:Array(28).fill(d.entry),chartPlaceholder:true});
    delete d.outcome;
    record.meta={published:t,publishedAt:at,updated:t,entryRule:d.entryRule,cancelRule:d.cancelRule,initial,events:[[t,'Идея опубликована','Уровни и условия зафиксированы. Ожидает подтверждения входа.',{id,type:'published',at,before:null,after:clone(initial)}]]};
    record.published=true;
  }
  function publish(record){publishAt(record,new Date().toISOString(),uid())}
  function state(record){return {state:record.d.state,status:record.d.status,stop:record.d.stop,current:record.d.current,outcome:record.d.outcome??null,exit:record.meta.exit??null,erroneous:!!record.erroneous}}
  function applyAction(record,action,note,exit,at){
    if(!record.published)throw Error('Сначала опубликуйте идею.');
    if(typeof note!=='string'||!note.trim())throw Error('Добавьте пояснение к событию.');
    if(record.erroneous&&action!=='note')throw Error('Ошибочная публикация остаётся в истории. Для неё доступны только комментарии.');
    const d=record.d,m=record.meta,before=state(record);let title='Комментарий автора',body=note.trim();
    if(action==='activate'){
      if(d.state!=='waiting')throw Error('Подтвердить вход можно только для ожидающей идеи.');
      d.state='active';d.status='Активен';title='Вход подтверждён';
    }else if(action==='cancel'){
      if(d.state!=='waiting')throw Error('Отмена доступна только до входа.');
      d.state='cancelled';d.status='Отменён';d.outcome='Отменён до входа';title=d.outcome;
    }else if(action==='stop-change'){
      if(!['waiting','active'].includes(d.state))throw Error('Стоп можно изменить только у ожидающей или активной идеи.');
      const price=Number(exit);
      if(!Number.isFinite(price)||price<=0)throw Error('Укажите положительную цену стопа.');
      if(price===d.stop)throw Error('Новый стоп совпадает с текущим.');
      if((d.dir==='ЛОНГ'&&price>=d.target)||(d.dir==='ШОРТ'&&price<=d.target))throw Error('Стоп должен оставаться до цели по направлению сделки.');
      if(d.state==='waiting'&&((d.dir==='ЛОНГ'&&price>=d.entry)||(d.dir==='ШОРТ'&&price<=d.entry)))throw Error('До входа стоп должен быть за уровнем входа.');
      const fmt=n=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:8}).format(n);
      title='Стоп изменён';body=`${d.ticker}: стоп изменён с ${fmt(d.stop)} до ${fmt(price)} ${d.unit}. ${body}`;d.stop=price;
    }else if(['target','stop','manual'].includes(action)){
      if(d.state!=='active')throw Error('Завершить можно только активную идею.');
      const price=action==='target'?d.target:action==='stop'?d.stop:Number(exit);
      if(!Number.isFinite(price)||price<=0)throw Error('Укажите положительную цену закрытия.');
      d.state='closed';d.status='Завершён';d.outcome=action==='target'?'Цель достигнута':action==='stop'?'Стоп достигнут':'Закрыто вручную';m.exit=price;d.current=price;title=d.outcome;
    }else if(action==='error'){
      record.erroneous=true;m.errorReason=body;m.error={reason:body,at};title='Ошибочная публикация';
    }else if(action!=='note')throw Error('Неизвестное действие.');
    m.updated=stamp(at);return {title,body,before,after:state(record)};
  }
  function update(record,action,note,exit){
    const at=new Date().toISOString(),result=applyAction(record,action,note,exit,at);
    record.meta.events.push([stamp(at),result.title,result.body,{id:uid(),type:action,at,note:note.trim(),before:result.before,after:result.after}]);
  }
  function replayEvents(expected,events){
    const ids=new Set(expected.meta.events.map(e=>e[3]?.id));
    for(const event of events){
      const info=event?.[3];
      if(!info||typeof info.id!=='string'||!info.id||ids.has(info.id)||!info.at||parseDate(info.at)!==info.at)throw Error('Новому событию нужны уникальный идентификатор и точная дата.');
      const result=applyAction(expected,info.type,info.note,info.type==='stop-change'?info.after?.stop:info.after?.exit,info.at);
      if(event[0]!==stamp(info.at)||event[1]!==result.title||event[2]!==result.body||!same(info.before,result.before)||!same(info.after,result.after))throw Error('Изменения должны соответствовать событию в истории.');
      ids.add(info.id);expected.meta.events.push(clone(event));
    }
  }
  function write(db){
    const latest=read();
    if(latest.revision!==db.revision)throw Error('Данные изменились в другой вкладке. Обновите страницу перед сохранением.');
    if(db.version!==1||!Array.isArray(db.records)||new Set(db.records.map(r=>r.id)).size!==db.records.length)throw Error('Некорректный список идей.');
    for(const previous of latest.records.filter(r=>r.published)){
      const next=db.records.find(r=>r.id===previous.id);
      if(!next||!next.published)throw Error('Опубликованную идею нельзя удалить. Отметьте ошибочную публикацию и укажите причину.');
      if(!Array.isArray(next.meta?.events)||!same(next.meta.events.slice(0,previous.meta.events.length),previous.meta.events))throw Error('Сохранённую историю нельзя удалять или переписывать.');
      const expected=clone(previous);replayEvents(expected,next.meta.events.slice(previous.meta.events.length));
      if(!same(expected,next))throw Error('Опубликованные условия и результат зафиксированы. Добавьте отдельное событие.');
    }
    for(const record of db.records.filter(r=>r.published&&!latest.records.some(p=>p.id===r.id&&p.published))){
      const first=record.meta?.events?.[0],info=first?.[3];
      if(info?.type!=='published'||!info.id||!info.at||parseDate(info.at)!==info.at)throw Error('Публикуйте идею через предпросмотр.');
      const initial=record.meta.initial;
      if(!initial||initial.reconstructed)throw Error('Не сохранены первоначальные условия публикации.');
      const expected={id:record.id,published:false,d:{...clone(record.d),...Object.fromEntries(fields.filter(f=>initial[f]!==undefined).map(f=>[f,initial[f]]))}};
      publishAt(expected,info.at,info.id);
      if(!same(first,expected.meta.events[0]))throw Error('Первоначальное событие публикации зафиксировано.');
      replayEvents(expected,record.meta.events.slice(1));
      if(!same(expected,record))throw Error('Опубликованные условия должны соответствовать журналу событий.');
    }
    const next={...db,revision:db.revision+1};localStorage.setItem(key,JSON.stringify(next));db.revision=next.revision;
    window.dispatchEvent(new CustomEvent('orbita:store-change',{detail:{revision:next.revision}}));
  }
  window.OrbitaStore={key,read,write,escape,safe,stamp,validate,publish,update,clone};
})();
