(() => {
  'use strict';
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const price=value=>Number.isFinite(value)&&value>0;
  const number=value=>value.toLocaleString('ru-RU',{maximumFractionDigits:8});
  function markup(record,{compact=false,scope='signal'}={}){
    const d=record.d||{},id=('signal-'+scope+'-'+record.id).replace(/[^a-zA-Z0-9_-]/g,''),levels=[d.entry,d.stop,d.target].every(price);
    const contours=Array.from({length:compact?7:23},(_,i)=>{
      const line=Array.from({length:49},(_,j)=>{const x=j*18.75,y=305+i*4-95*Math.exp(-(((x-430)/235)**2))+42*Math.sin(x/140+i*.085)+Math.sin(x/70+i*.1)*12;return(j?'L':'M')+x.toFixed(1)+','+y.toFixed(1);}).join(' ');
      return `<path d="${line}" class="signal-contour"/>`;
    }).join('');
    let drawing;
    if(!levels){
      const arrow=d.dir==='ШОРТ'?'M310 170L455 275L570 260':'M310 275L455 170L570 185';
      drawing=`<circle class="signal-pending-ring" cx="450" cy="220" r="102"/><circle class="signal-pending-inner" cx="450" cy="220" r="78"/><path class="signal-pending-direction" d="${arrow}"/><circle cx="310" cy="${d.dir==='ШОРТ'?170:275}" r="5" fill="#cce1ff"/>${compact?'':'<text class="signal-plot-note" x="450" y="373" text-anchor="middle">Сигнал объявлен · уровни ещё не опубликованы</text>'}`;
    }else{
      const low=Math.min(d.entry,d.stop,d.target),high=Math.max(d.entry,d.stop,d.target),span=Math.max(high-low,d.entry*.001),y=value=>330-(value-low)/span*230;
      const entry=y(d.entry),stop=y(d.stop),target=y(d.target),protectsProfit=(d.stop-d.entry)*(d.dir==='ШОРТ'?-1:1)>0,stopColor=protectsProfit?'#a8c9ff':'#d9a6a3';
      const labels=[{name:'Цель',value:d.target,y:target,color:'#a3d4c4'},{name:'Вход',value:d.entry,y:entry,color:'#c8ddff'},{name:'Стоп',value:d.stop,y:stop,color:stopColor}].sort((a,b)=>a.y-b.y);
      labels.forEach((label,i)=>label.labelY=Math.max(label.y,i?labels[i-1].labelY+29:60));
      drawing=`<rect x="64" y="${Math.min(entry,target)}" width="526" height="${Math.max(1,Math.abs(entry-target))}" fill="url(#${id}-reward)"/><rect x="64" y="${Math.min(entry,stop)}" width="526" height="${Math.max(1,Math.abs(entry-stop))}" fill="${stopColor}" opacity=".035"/>`;
      drawing+=labels.map(label=>`<path d="M64 ${label.y}H601L623 ${label.labelY}H640" fill="none" stroke="${label.color}" stroke-opacity=".45" stroke-dasharray="4 7"/>${compact?'':`<text class="signal-plot-label" x="657" y="${label.labelY+5}" fill="${label.color}">${label.name} <tspan font-weight="500">${number(label.value)} ${esc(d.unit||'')}</tspan></text>`}`).join('');
      drawing+=`<path class="signal-plan-glow" d="M105 ${entry}C180 ${entry} 205 ${entry+12} 260 ${entry}S435 ${target} 566 ${target}"/><path class="signal-plan-line" d="M105 ${entry}C180 ${entry} 205 ${entry+12} 260 ${entry}S435 ${target} 566 ${target}"/><path class="signal-stop-line" d="M260 ${entry}C350 ${entry} 389 ${stop} 495 ${stop}" stroke="${stopColor}"/><circle class="signal-entry-orb" cx="105" cy="${entry}" r="5"/><circle cx="566" cy="${target}" r="4" fill="#bcd9ed"/>${compact?'':'<text class="signal-plot-note" x="64" y="410">Вход → цель или стоп · схема условий автора</text>'}`;
    }
    return `<svg class="signal-visual${compact?' signal-visual-compact':''}" viewBox="0 0 900 460" role="img" aria-label="${esc(d.ticker)}: ${levels?'схема входа, стопа и цели автора':'сигнал без опубликованных уровней'}. Котировки не подключены."><title>${esc(d.ticker)} · ${esc(d.dir)} · ${levels?'Уровни автора; линия показывает возможные исходы, не историю цены.':'Автор добавит уровни отдельным обновлением.'}</title><defs><linearGradient id="${id}-reward" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#a3d4c4" stop-opacity=".12"/><stop offset="1" stop-color="#a3d4c4" stop-opacity=".015"/></linearGradient></defs><g>${contours}</g>${drawing}</svg>`;
  }
  window.OrbitaSignalVisual={markup};
})();
