(() => {
  const E=OrbitaPersonalEngine, S=OrbitaStore, esc=S.escape;
  const percent=n=>(n>0?'+':'')+n.toLocaleString('ru-RU',{maximumFractionDigits:2})+'%';
  const number=n=>n.toLocaleString('ru-RU',{maximumFractionDigits:2});
  const localTime=iso=>{const date=new Date(iso);return new Date(date-date.getTimezoneOffset()*60000).toISOString().slice(0,16)};
  let account=null, accountKey=null, positions=[], onChange=()=>{};
  const key='orbita.positions.v1.guest';
  const drafts = new Map();
  const pending = new Set(), mutationErrors = new Map();
  async function api(method='GET',body){const r=await fetch('/api/positions',{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok)throw Error(OrbitaAccess.supportMessage(d,'Не удалось сохранить личную сделку.'));return d}
  function guestRead(){const value=JSON.parse(localStorage.getItem(key)||'[]');if(!Array.isArray(value))throw Error('Не удалось прочитать личные сделки.');return value}
  async function init(user,callback){if(!user)throw Error('Войдите в аккаунт.');const nextKey=user.id||user.email;if(accountKey!==nextKey){drafts.clear();mutationErrors.clear();}accountKey=nextKey;account=user;onChange=callback;positions=(await api()).positions;}
  const find=id=>positions.find(p=>p.ideaId===id);
  function card(idea,meta){const p=find(idea.id),r=p&&E.result(p,idea,meta);return r?`<div class="personal-card-result">У меня ${percent(r.percent)} <small>${r.source==='manual'?'личное закрытие':r.source==='strategy'?'по закрытию идеи':'оценка'}</small></div>`:''}
  async function save(p){if(account)await api('PUT',p);else{const next=positions.filter(x=>x.ideaId!==p.ideaId);next.push(p);localStorage.setItem(key,JSON.stringify(next))}positions=account?(await api()).positions:guestRead();drafts.delete(p.ideaId);window.dispatchEvent(new CustomEvent('orbita:positions-change'));onChange()}
  async function remove(ideaId){if(!account)throw Error('Войдите в аккаунт.');await api('DELETE',{ideaId});positions=(await api()).positions;drafts.delete(ideaId);window.dispatchEvent(new CustomEvent('orbita:positions-change'));onChange();}
  function syncMutation(ideaId){
    for(const section of document.querySelectorAll('.personal-trade'))if(section.dataset.ideaId===ideaId){
      section.querySelectorAll('input,button').forEach(control=>control.disabled=pending.has(ideaId));
      const output=section.querySelector('[role=status]');if(output)output.textContent=mutationErrors.get(ideaId)||(pending.has(ideaId)?'Сохраняем изменения…':drafts.get(ideaId)?.dirty?'Есть несохранённые изменения. Чтобы пересчитать результат, сохраните форму.':'');
    }
  }
  async function mutate(ideaId,work){
    if(pending.has(ideaId))return;pending.add(ideaId);mutationErrors.delete(ideaId);syncMutation(ideaId);
    try{await work();}catch(error){mutationErrors.set(ideaId,error.message||'Не удалось сохранить изменение. Повторите попытку.');}
    finally{pending.delete(ideaId);syncMutation(ideaId);}
  }
  function mount(parent,idea,meta){
    const p=find(idea.id),r=p&&E.result(p,idea,meta),section=document.createElement('section');const reference=idea.state==='closed'?meta.exit:idea.current;const authorResult=Number.isFinite(reference)&&reference>0&&Number.isFinite(idea.entry)&&idea.entry>0?percent((reference-idea.entry)/idea.entry*100*(idea.dir==='ШОРТ'?-1:1)):'Нет текущей цены';section.className='personal-trade';section.dataset.ideaId=idea.id;
    section.innerHTML=`<div class="eyebrow">МОЯ СДЕЛКА</div><h3>${p?'Моя точка входа':'Я вошёл'}</h3><p>Укажите фактическую цену и количество ${idea.market==='futures'?'контрактов':idea.market==='crypto'?'монет':'бумаг'}. ${account?'Сделка сохранится в аккаунте.':'Сделка сохранится в этом браузере.'}</p>${r?`<div class="personal-comparison"><div><span>По стратегии${idea.state==='closed'?'':' · оценка'}</span><strong>${authorResult}</strong></div><div><span>У меня</span><strong class="${r.pnl<0?'loss':'gain'}">${percent(r.percent)}</strong><b>${r.pnl>0?'+':''}${number(r.pnl)} ${idea.market==='crypto'?'USDT':'₽'}</b></div></div><p>${r.source==='manual'?'Ваш результат по введённой цене выхода.':r.source==='strategy'?'Оценка по цене закрытия идеи. Укажите свой выход, чтобы зафиксировать личный результат.':'Оценка по последней цене, указанной автором; живые котировки не подключены.'} Без комиссий, налогов и финансирования.</p>`:''}
    ${p&&!r&&idea.state==='closed'?'<p class="personal-error">Ваша дата входа позже закрытия идеи. Укажите собственные цену и дату выхода для расчёта личного результата.</p>':''}<form class="personal-form"><label>Моя цена входа, ${esc(idea.unit)}<input name="entry" type="number" step="any" min="0.00000001" max="1000000000000" required value="${p?.entry||idea.entry}"></label><label>Количество ${idea.market==='futures'?'контрактов':idea.market==='crypto'?'монет':'бумаг'}<input name="quantity" type="number" step="any" min="0.00000001" max="1000000000000" required value="${p?.quantity||1}"></label><label>Дата и время входа<input name="enteredAt" type="datetime-local" required value="${localTime(p?.enteredAt||(idea.state==='closed'?meta.publishedAt:null)||new Date().toISOString())}"></label>${idea.market==='futures'?`<label>Стоимость пункта, ₽ / контракт<input name="pointValue" type="number" step="any" min="0.00000001" max="1000000000000" value="${p?.pointValue||1}" required></label>`:''}<details ${p?.exit?'open':''}><summary>Указать свой выход</summary><label>Моя цена выхода, ${esc(idea.unit)}<input name="exit" type="number" step="any" min="0.00000001" max="1000000000000" value="${p?.exit||''}" placeholder="Позиция ещё открыта"></label><label>Дата и время выхода<input name="closedAt" type="datetime-local" value="${p?.closedAt?localTime(p.closedAt):''}"></label><p>Оставьте оба поля пустыми, если ещё не закрыли позицию.</p></details><button type="submit" class="explore">${p?'Сохранить мою сделку':'Я вошёл · сохранить'}</button><p class="personal-error" role="status"></p></form>`;
    if((idea.state==='cancelled'||idea.erroneous)&&!p){section.innerHTML='<h3>Моя сделка</h3><p>Новые отметки входа недоступны для отменённой или ошибочной публикации.</p>'+ (r?`<p>Ранее сохранённый личный результат: ${percent(r.percent)}.</p>`:'');parent.append(section);return}
    parent.append(section);
    const personalForm = section.querySelector('form');
    if(p){const removeButton=document.createElement('button');removeButton.type='button';removeButton.className='explore';removeButton.dataset.removePosition='';removeButton.textContent='Удалить мою отметку';removeButton.onclick=()=>{if(!pending.has(idea.id)&&confirm('Удалить вашу отметку входа и личного выхода? История автора и отслеживание идеи сохранятся.'))void mutate(idea.id,()=>remove(idea.id));};personalForm.append(removeButton);}
    const draft = drafts.get(idea.id);
    if (draft) {
      for (const [name, value] of Object.entries(draft.values)) if (personalForm.elements[name]) personalForm.elements[name].value = value;
      personalForm.querySelector('details').open = draft.open;
    }
    const remember = (edited = false) => { drafts.set(idea.id, {
      dirty: edited || drafts.get(idea.id)?.dirty || false,
      values: Object.fromEntries([...personalForm.querySelectorAll('input[name]')].map(input => [input.name, input.value])),
      open: personalForm.querySelector('details').open
    }); if (drafts.get(idea.id)?.dirty) personalForm.querySelector('[role=status]').textContent = 'Есть несохранённые изменения. Чтобы пересчитать результат, сохраните форму.'; };
    if (draft?.dirty) personalForm.querySelector('[role=status]').textContent = 'Есть несохранённые изменения. Чтобы пересчитать результат, сохраните форму.';
    personalForm.addEventListener('input', () => remember(true));
    personalForm.addEventListener('change', () => remember(true));
    personalForm.querySelector('details').addEventListener('toggle', () => { if (personalForm.isConnected) remember(); });
    personalForm.onsubmit=async event=>{
      event.preventDefault();const f=event.currentTarget,message=f.querySelector('[role=status]'),button=f.querySelector('button');
      try{if(pending.has(idea.id))return;const enteredAt=new Date(f.elements.enteredAt.value),hasExit=f.elements.exit.value!=='',hasDate=f.elements.closedAt.value!=='';if(hasExit!==hasDate)throw Error('Укажите цену и дату выхода вместе.');const closedAt=hasDate?new Date(f.elements.closedAt.value):null;const entry=Number(f.elements.entry.value),quantity=Number(f.elements.quantity.value),pointValue=Number(f.elements.pointValue?.value||1),exit=hasExit?Number(f.elements.exit.value):null;if(![entry,quantity,pointValue,...(hasExit?[exit]:[])].every(n=>Number.isFinite(n)&&n>0&&n<=1e12)||entry*quantity*pointValue>1e18||!Number.isFinite(enteredAt.getTime())||(closedAt&&(!Number.isFinite(closedAt.getTime())||closedAt<enteredAt)))throw Error('Проверьте цену, объём и даты: выход должен быть не раньше входа.');await mutate(idea.id,()=>save({ideaId:idea.id,entry,quantity,pointValue,enteredAt:enteredAt.toISOString(),exit,closedAt:closedAt?.toISOString()||null}))}catch(error){message.textContent=error.message;button.disabled=false}
    };
    syncMutation(idea.id);
  }
  function clear(){account=null;accountKey=null;positions=[];drafts.clear();pending.clear();mutationErrors.clear();onChange=()=>{};}
  window.OrbitaPersonal={init,mount,card,clear,ids:()=>positions.map(p=>p.ideaId)};
})();
