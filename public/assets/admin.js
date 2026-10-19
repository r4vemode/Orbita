(()=>{
 const $=id=>document.getElementById(id),S=OrbitaStore,form=$('ideaForm');let db,current=null,dirty=false,pending;
 const fields=['ticker','name','market','dir','title','summary','entry','stop','target','horizon','strategy','thesis','entryRule','cancelRule'];
 function message(t,error=false){$('message').textContent=t;$('message').classList.toggle('error',error)}
 try{db=S.read()}catch(e){message(e.message,true);return}
 function data(){return Object.fromEntries(fields.map(k=>[k,['entry','stop','target'].includes(k)?Number(form.elements[k].value):form.elements[k].value.trim()]))}
 function card(d){return `<div class="preview-card"><span class="preview-tag">${S.escape(d.dir)}</span><h2>${S.escape(d.ticker||'Новая идея')}</h2><h3>${S.escape(d.title)}</h3><p>${S.escape(d.summary)}</p></div>`+TradeScheme.markup(d)}
 function preview(){const r=db.records.find(r=>r.id===current);$('livePreview').innerHTML=card(r?.published?r.d:data())}
 function list(){
  $('count').textContent=db.records.length;
  $('ideaList').innerHTML=db.records.map(r=>`<button class="list-item ${r.id===current?'active':''}" data-id="${S.escape(r.id)}"><strong>${S.escape(r.d.ticker||'Черновик')}</strong><small>${r.erroneous?'Ошибочная публикация':r.published?S.escape(r.d.status):'Черновик'}</small></button>`).join('');
  $('ideaList').querySelectorAll('button').forEach(b=>b.onclick=()=>{if(dirty&&!confirm('Перейти без сохранения черновика?'))return;select(b.dataset.id)});
 }
 function eventField(){
  const action=$('eventAction').value;
  $('exitField').hidden=!['manual','stop-change'].includes(action);
  $('exitLabel').textContent=action==='stop-change'?'Новый стоп':'Цена закрытия';
  $('eventNote').placeholder=action==='error'?'Почему публикация ошибочна? Причина останется в истории.':'Что произошло и что это меняет?';
 }
 function audit(record){
  const i=record.meta.initial,fmt=n=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:8}).format(n);
  $('initialSnapshot').innerHTML=i?`<h3>Первоначальные условия</h3><p>${S.escape(i.dir)} · ${S.escape(i.strategy)}<br>Вход ${S.escape(fmt(i.entry))} · Стоп ${S.escape(fmt(i.stop))} · Цель ${S.escape(fmt(i.target))} ${S.escape(record.d.unit)}<br>${S.escape(i.entryRule)}<br>${S.escape(i.cancelRule)}</p>${i.reconstructed?`<small>${S.escape(i.reconstructedReason)}</small>`:''}`:'';
  $('eventHistory').innerHTML=record.meta.events.map(([t,h,b])=>`<div class="history-event"><small>${S.escape(t)} МСК</small><strong>${S.escape(h)}</strong><p>${S.escape(b)}</p></div>`).join('');
 }
 function select(id){
  current=id;dirty=false;const r=db.records.find(r=>r.id===id);form.reset();
  fields.forEach(k=>{if(r?.d[k]!=null)form.elements[k].value=r.d[k]});
  $('deleteIdea').hidden=!r||!!r.erroneous;$('deleteIdea').textContent=r?.published?'Отметить ошибочную публикацию':'Удалить черновик';
  $('fields').disabled=!!r?.published;$('draftActions').hidden=!!r?.published;$('publishedActions').hidden=!r?.published;
  $('editorStatus').textContent=r?.erroneous?'Ошибочная публикация':r?.published?r.d.status:'ЧЕРНОВИК';$('editorId').textContent=id||'';
  if(r?.published){
   const actions=[['note','Комментарий'],...(!r.erroneous&&['waiting','active'].includes(r.d.state)?[['stop-change','Изменить стоп']]:[]),...(!r.erroneous&&r.d.state==='waiting'?[['activate','Подтвердить вход'],['cancel','Отменить до входа']]:[]),...(!r.erroneous&&r.d.state==='active'?[['target','Закрыть по цели'],['stop','Закрыть по стопу'],['manual','Закрыть вручную']]:[]),...(!r.erroneous?[['error','Ошибочная публикация']]:[])];
   $('eventAction').innerHTML=actions.map(([v,t])=>`<option value="${v}">${t}</option>`).join('');
   $('exitPrice').value='';$('eventNote').value='';eventField();audit(r);
  }
  list();preview();
 }
 function save(publish=false){
  const next=S.clone(db);let r=next.records.find(r=>r.id===current);
  if(!r){r={id:'idea-'+crypto.randomUUID(),published:false,d:{}};next.records.unshift(r)}
  if(r.published)throw Error('Идея уже опубликована.');r.d=data();if(publish)S.publish(r);S.write(next);db=next;select(r.id);
  message(publish?'Идея опубликована локально. Откройте кабинет.':'Черновик сохранён.');
 }
 form.addEventListener('input',()=>{dirty=true;preview()});form.addEventListener('change',preview);
 $('saveDraft').onclick=()=>{try{save()}catch(e){message(e.message,true)}};
 form.onsubmit=e=>{e.preventDefault();try{S.validate(data());pending=JSON.stringify(data());$('confirmPreview').innerHTML=card(data());$('publishDialog').showModal()}catch(e){message(e.message,true)}};
 $('confirmPublish').onclick=()=>{try{if(pending!==JSON.stringify(data()))throw Error('Условия изменились. Откройте предпросмотр заново.');save(true);$('publishDialog').close()}catch(e){message(e.message,true);$('publishDialog').close()}};
 $('cancelPublish').onclick=()=>$('publishDialog').close();$('newIdea').onclick=()=>{if(dirty&&!confirm('Начать новую идею без сохранения текущей?'))return;select(null)};
 $('eventAction').onchange=eventField;
 $('saveEvent').onclick=()=>{
  try{const next=S.clone(db),r=next.records.find(r=>r.id===current);S.update(r,$('eventAction').value,$('eventNote').value,$('exitPrice').value);S.write(next);db=next;select(current);message('Событие сохранено. Исходные условия и предыдущая история сохранены.')}catch(e){message(e.message,true)}
 };
 $('deleteIdea').onclick=()=>{
  const record=db.records.find(r=>r.id===current);if(!record)return;
  if(record.published){$('eventAction').value='error';eventField();$('eventNote').focus();message('Укажите причину ошибки и добавьте событие. Идея и её результат останутся в истории.');return}
  if(!confirm(`Удалить черновик «${record.d.ticker||'Новая идея'}»?${dirty?' Несохранённые изменения также будут потеряны.':''}`))return;
  try{const next=S.clone(db);next.records=next.records.filter(r=>r.id!==current);S.write(next);db=next;select(null);message('Черновик удалён.')}catch(e){message(e.message,true)}
 };
 $('exportData').onclick=()=>{const u=URL.createObjectURL(new Blob([JSON.stringify(db,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=u;a.download='orbita-ideas.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)};
 window.addEventListener('storage',e=>{if(e.key===S.key||e.key===null)message('Данные изменились в другой вкладке. Обновите страницу перед дальнейшим редактированием.',true)});
 window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue=''}});select(null);
})();
