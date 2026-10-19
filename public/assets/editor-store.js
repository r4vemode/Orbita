(() => {
  const key='orbita.editor.v1';
  const clone=x=>JSON.parse(JSON.stringify(x));
  function read(){
    const raw=localStorage.getItem(key);
    if(!raw)return {version:1,revision:0,records:clone(window.ORBITA_SEED)};
    const db=JSON.parse(raw);
    if(db.version!==1||!Array.isArray(db.records))throw Error('Не удалось прочитать локальные данные. Сначала экспортируйте резервную копию.');
    return db;
  }
  function write(db){
    const latest=read();
    if(latest.revision!==db.revision)throw Error('Данные изменились в другой вкладке. Обновите страницу перед сохранением.');
    const next={...db,revision:db.revision+1};
    localStorage.setItem(key,JSON.stringify(next));
    db.revision=next.revision;
  }
  const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safe=x=>typeof x==='string'?escape(x):Array.isArray(x)?x.map(safe):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).map(([k,v])=>[k,safe(v)])):x;
  const stamp=()=>new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date()).replace(',',' ·');
  function validate(d){
    for(const f of ['ticker','name','title','summary','thesis','horizon','strategy','entryRule','cancelRule'])if(!String(d[f]||'').trim())throw Error('Заполните все поля перед публикацией.');
    if(!['stocks','futures','crypto'].includes(d.market)||!['ЛОНГ','ШОРТ'].includes(d.dir))throw Error('Выберите рынок и направление.');
    for(const f of ['entry','stop','target'])if(!Number.isFinite(d[f])||d[f]<=0)throw Error('Уровни должны быть положительными числами.');
    if(d.dir==='ЛОНГ'&&!(d.stop<d.entry&&d.entry<d.target))throw Error('Для лонга: стоп < вход < цель.');
    if(d.dir==='ШОРТ'&&!(d.target<d.entry&&d.entry<d.stop))throw Error('Для шорта: цель < вход < стоп.');
  }
  function publish(record){
    if(record.published)throw Error('Идея уже опубликована.');
    validate(record.d);
    const d=record.d,t=stamp(),lo=Math.min(d.stop,d.target),hi=Math.max(d.stop,d.target),pad=(hi-lo)*.15;
    Object.assign(d,{state:'waiting',status:'Ожидает входа',unit:d.market==='stocks'?'₽':d.market==='futures'?'пт':'USDT',current:d.entry,min:lo-pad,max:hi+pad,points:Array(28).fill(d.entry),chartPlaceholder:true});
    record.meta={published:t,updated:t,entryRule:d.entryRule,cancelRule:d.cancelRule,events:[[t,'Идея опубликована','Уровни и условия зафиксированы. Ожидает подтверждения входа.']]};
    record.published=true;
  }
  function update(record,action,note,exit){
    if(!record.published)throw Error('Сначала опубликуйте идею.');
    if(!note.trim())throw Error('Добавьте пояснение к событию.');
    const d=record.d,m=record.meta,t=stamp();let title='Комментарий автора';
    if(action==='activate'){
      if(d.state!=='waiting')throw Error('Подтвердить вход можно только для ожидающей идеи.');
      d.state='active';d.status='Активен';title='Вход подтверждён';
    }else if(action==='cancel'){
      if(d.state!=='waiting')throw Error('Отмена доступна только до входа.');
      d.state='cancelled';d.status='Отменён';d.outcome='Отменён до входа';title=d.outcome;
    }else if(['target','stop','manual'].includes(action)){
      if(d.state!=='active')throw Error('Завершить можно только активную идею.');
      const price=action==='target'?d.target:action==='stop'?d.stop:Number(exit);
      if(!Number.isFinite(price)||price<=0)throw Error('Укажите положительную цену закрытия.');
      d.state='closed';d.status='Завершён';d.outcome=action==='target'?'Цель достигнута':action==='stop'?'Стоп достигнут':'Закрыто вручную';m.exit=price;d.current=price;title=d.outcome;
    }else if(action!=='note')throw Error('Неизвестное действие.');
    m.updated=t;m.events.push([t,title,note.trim()]);
  }
  window.OrbitaStore={key,read,write,escape,safe,stamp,validate,publish,update,clone};
})();
