(() => {
  function result(position, idea, meta) {
    const source = position.exit != null ? 'manual' : idea.state === 'closed' && Number.isFinite(meta.exit) ? 'strategy' : 'mark';
    if (source === 'strategy') {
      const event = [...(meta.events||[])].reverse().find(e=>['target','stop','manual'].includes(e[3]?.type)||/^(Закрыто|Цель достигнута|Стоп достигнут)/.test(e[1]));
      let closedAt = Date.parse(event?.[3]?.at||'');
      if (!Number.isFinite(closedAt)) {
        const match=String(event?.[0]||meta.updated||'').match(/^(\d{2})\.(\d{2})(?:\.(\d{4}))?\s*·\s*(\d{2}):(\d{2})/);
        const year=match?.[3]||String(meta.published||'').match(/\d{2}\.\d{2}\.(\d{4})/)?.[1];
        if(match&&year)closedAt=Date.UTC(+year,+match[2]-1,+match[1],+match[4]-3,+match[5]);
      }
      if (Number.isFinite(closedAt)&&Date.parse(position.enteredAt)>closedAt) return null;
    }
    const exit = source === 'manual' ? position.exit : source === 'strategy' ? meta.exit : idea.current;
    if (![position.entry,position.quantity,position.pointValue,exit].every(n=>Number.isFinite(n)&&n>0)) return null;
    const change=(exit-position.entry)*(idea.dir==='ШОРТ'?-1:1);
    return {exit,source,percent:change/position.entry*100,pnl:change*position.quantity*position.pointValue};
  }
  window.OrbitaPersonalEngine={result};
})();
