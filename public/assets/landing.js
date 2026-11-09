document.querySelectorAll('[data-dialog]').forEach(b=>b.addEventListener('click',()=>{location.href='/account.html'+(b.dataset.dialog==='login'?'':'?mode=register'+(b.dataset.plan?'&plan='+encodeURIComponent(b.dataset.plan):'&plan=pro'))}));
const observer=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('visible');observer.unobserve(e.target)}}),{threshold:.08});document.querySelectorAll('.reveal').forEach(e=>observer.observe(e));
const canvas=document.getElementById('heroArt'),ctx=canvas.getContext('2d'),motion=matchMedia('(prefers-reduced-motion: reduce)');let w=0,h=0,raf=0,visible=true;function resize(){const r=canvas.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,2);w=r.width;h=r.height;canvas.width=w*d;canvas.height=h*d;ctx.setTransform(d,0,0,d,0,0)}function draw(t){ctx.clearRect(0,0,w,h);const phase=motion.matches?0:t*.00014;for(let j=0;j<42;j++){ctx.beginPath();for(let i=0;i<=100;i++){const x=i/100*w;const peak=Math.exp(-Math.pow((x-w*.7)/(w*.24),2));const y=h*.75+j*5-peak*h*.27+Math.sin(x/w*9+phase+j*.055)*h*.035+Math.sin(x/w*18-phase*.5+j*.05)*h*.009;if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)}ctx.strokeStyle=`rgba(147,189,243,${.07+Math.sin(j/42*Math.PI)*.14})`;ctx.lineWidth=.7;ctx.stroke()}const x=w*.74+Math.sin(phase*.6)*w*.025,y=h*.48+Math.sin(phase)*h*.024;const g=ctx.createRadialGradient(x,y,0,x,y,w*.16);g.addColorStop(0,'rgba(147,190,255,.13)');g.addColorStop(1,'rgba(147,190,255,0)');ctx.fillStyle=g;ctx.fillRect(0,0,w,h);for(let k=0;k<4;k++){const px=w*(.57+k*.1),py=h*(.57+Math.sin(k+phase)*.035);ctx.beginPath();ctx.arc(px,py,k===2?2.8:1.5,0,Math.PI*2);ctx.fillStyle=k===2?'#d4e6ff':'#809bbf';ctx.fill()}if(!motion.matches&&visible)raf=requestAnimationFrame(draw)}function start(){cancelAnimationFrame(raf);draw(performance.now())}resize();start();window.addEventListener('resize',()=>{resize();start()});motion.addEventListener('change',start);new IntersectionObserver(es=>{visible=es[0].isIntersecting;if(visible)start();else cancelAnimationFrame(raf)}).observe(canvas);

// A self-contained teaching example; never loads the account application.
(()=>{
 const $=id=>document.getElementById(id);let stage=0,outcome='target',frame;
 const initial=[[20,230],[55,220],[85,235],[120,210],[150,215],[185,195],[220,202],[255,187],[290,195]];
 const entered=[...initial,[325,174],[360,162],[390,170],[425,148]];
 const states=[{status:'Ожидает входа',title:'Сначала — условие.',text:'Цена подходит к верхней границе диапазона. Вход — только после закрепления выше 312,40 ₽. Пока условие не выполнено, идея остаётся в ожидании.',insight:'Уровни известны заранее. Решение о сделке остаётся за вами.'},{status:'Активен',title:'Условие выполнено.',text:'В этом примере цена закрепилась выше 312,40 ₽. Идея активна: теперь следим за целью 329 ₽ и стопом 306,20 ₽.',insight:'Подтверждение входа добавляется в историю. Исходные условия остаются видны.'}];
 function render(){cancelAnimationFrame(frame);const stop=outcome==='stop';const d=stage<2?states[stage]:{status:stop?'Закрыт по стопу':'Закрыт по цели',title:stop?'Убыток тоже в истории.':'Движение завершено.',text:stop?'Альтернативный исход: после входа цена снижается до 306,20 ₽. Сценарий закрыт по стопу и остаётся в общей истории.':'В этом учебном исходе цена достигает 329 ₽. Сценарий закрыт по цели; уровни и все события доступны в истории.',insight:(stop?'−1,98%':'+5,31%')+' от цены входа. Без плеча, комиссий и проскальзывания.'};
 $('sampleStatus').textContent=d.status;$('sampleNumber').textContent=['01 / ИДЕЯ','02 / ВХОД','03 / РЕЗУЛЬТАТ'][stage];$('sampleTitle').textContent=d.title;$('sampleText').textContent=d.text;$('sampleInsight').textContent=d.insight;$('sampleOutcomes').hidden=stage!==2;$('sampleNext').innerHTML=['Посмотреть активацию <span>→</span>','Узнать результат <span>→</span>','Пройти заново <span>↺</span>'][stage];
 document.querySelectorAll('[data-stage]').forEach(b=>b.setAttribute('aria-pressed',+b.dataset.stage===stage));document.querySelectorAll('[data-outcome]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.outcome===outcome));
 const points=stage===0?initial:stage===1?entered:[...entered,...(stop?[[450,175],[475,198],[505,225]]:[[450,121],[475,105],[505,60]])];const path=points.map((p,i)=>(i?'L':'M')+p.join(',')).join(' ');const line=$('samplePrice');line.setAttribute('d',path);$('sampleArea').setAttribute('d',path+` L${points.at(-1)[0]},285 L20,285 Z`);$('samplePoint').setAttribute('cx',points.at(-1)[0]);$('samplePoint').setAttribute('cy',points.at(-1)[1]);
 const len=line.getTotalLength();line.style.strokeDasharray=len;if(!motion.matches){const start=performance.now();function animate(t){const k=Math.min(1,(t-start)/650);line.style.strokeDashoffset=len*(1-k);if(k<1)frame=requestAnimationFrame(animate)}frame=requestAnimationFrame(animate)}else line.style.strokeDashoffset=0;
 }
 document.querySelectorAll('[data-stage]').forEach(b=>b.onclick=()=>{stage=+b.dataset.stage;render()});document.querySelectorAll('[data-outcome]').forEach(b=>b.onclick=()=>{outcome=b.dataset.outcome;render()});$('sampleNext').onclick=()=>{stage=(stage+1)%3;render()};render();
 const pro=document.querySelector('.plan.pro');pro.addEventListener('pointermove',e=>{if(motion.matches||e.pointerType==='touch')return;const r=pro.getBoundingClientRect();pro.style.setProperty('--px',`${(e.clientX-r.left)/r.width*100}%`);pro.style.setProperty('--py',`${(e.clientY-r.top)/r.height*100}%`)});pro.addEventListener('pointerleave',()=>{pro.style.removeProperty('--px');pro.style.removeProperty('--py')});
})();

// Session-aware header: a signed-in visitor sees "Кабинет", not a login prompt,
// so returning to the landing page never looks like being logged out.
(()=>{
 fetch('/api/me',{credentials:'same-origin',cache:'no-store'}).then(r=>r.ok?r.json():null).then(data=>{
  if(!data?.user)return;const link=document.getElementById('cabinetLink');if(link)link.hidden=false;
  document.querySelectorAll('.account [data-dialog], .account a[href="#access"]').forEach(node=>{node.hidden=true;});
 }).catch(()=>{});
})();

// Public example: server sends only instrument, direction, dates, status and a
// verified result when one exists. No levels or author comments are public.
(()=>{
 const box=document.getElementById('showcase');if(!box)return;
 const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=String(text);return n;};
 const when=iso=>Number.isFinite(Date.parse(iso))?new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(iso))+' МСК':'—';
 const states={announced:'Сигнал объявлен',waiting:'Ожидает входа',active:'Активна'};
 fetch('/api/public/showcase',{cache:'no-store'}).then(r=>r.ok?r.json():Promise.reject()).then(({showcase:s})=>{
  box.replaceChildren();
  if(!s){box.append(el('p','showcase-muted','Сейчас нет открытой идеи для публичного примера. Загляните позже — или посмотрите учебный сценарий ниже.'));return;}
  const long=s.dir!=='ШОРТ',head=el('div','showcase-head');
  head.append(el('strong','showcase-ticker',s.ticker),el('span','showcase-tag '+(long?'long':'short'),long?'LONG':'SHORT'),el('span','showcase-tag pro','PRO'));
  const facts=el('dl','showcase-facts');
  const add=(k,v)=>{const d=el('div');d.append(el('dt','',k),el('dd','',v));facts.append(d);};
  add('Инструмент',s.name||s.ticker);add('Опубликована',when(s.publishedAt));add('Статус',states[s.state]||s.status||'—');add('Обновлено',when(s.updatedAt));
  if(s.result){add('Текущий расчётный результат',(s.result.pct>0?'+':s.result.pct<0?'−':'')+Math.abs(s.result.pct).toLocaleString('ru-RU',{maximumFractionDigits:2})+'%');}
  box.append(head,facts);
  box.append(el('p','showcase-muted',s.result?`Расчёт: ${s.result.method}. Цена — ${s.result.source}, на ${when(s.result.priceTime)}${s.result.delayMinutes?', задержка ~'+s.result.delayMinutes+' мин':''}. Результат расчётный, не учитывает комиссии и не является гарантией.`:'Результат не показывается: идея ещё не активна или нет проверенной рыночной цены.'));
  const cta=el('a','primary','Получить доступ к уровням ↗');cta.href='#access';box.append(cta);
 }).catch(()=>{box.replaceChildren(el('p','showcase-muted','Пример временно недоступен.'));});
})();

// Public aggregate track record of closed ideas (no tickers or levels).
(()=>{const box=document.getElementById('publicStats');if(!box)return;
 fetch('/api/public/stats',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(data=>{const s=data?.stats?.pro;if(!s||s.closed<5)return;
  const pct=v=>(v>0?'+':v<0?'−':'')+Math.abs(v).toLocaleString('ru-RU',{maximumFractionDigits:2})+'%';
  box.innerHTML=`<div><b>${s.closed}</b><span>закрытых PRO-идей</span></div><div><b>${Math.round(s.winRate)}%</b><span>закрыты в плюсе</span></div><div><b>${pct(s.avgPct)}</b><span>средний результат идеи</span></div><p>Все закрытые идеи с ценой выхода, без отбора и без учёта комиссий. Прошлые результаты не гарантируют будущих. <a href="/results.html">Каждая идея с уровнями →</a></p>`;box.hidden=false;}).catch(()=>{});})();
