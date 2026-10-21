(() => {
 'use strict';
 const instruments=[
  {ticker:'SBER',name:'Сбербанк',sector:'finance',base:312.4,drift:.014,activity:1.9,lot:10},
  {ticker:'LKOH',name:'Лукойл',sector:'energy',base:7105,drift:.008,activity:1.35,lot:1},
  {ticker:'GAZP',name:'Газпром',sector:'energy',base:143.2,drift:-.009,activity:1.65,lot:10},
  {ticker:'YDEX',name:'Яндекс',sector:'tech',base:4210,drift:.023,activity:2.4,lot:1},
  {ticker:'GMKN',name:'Норникель',sector:'metals',base:117.3,drift:-.006,activity:.85,lot:10},
  {ticker:'TATN',name:'Татнефть',sector:'energy',base:632.5,drift:.004,activity:.95,lot:1},
  {ticker:'T',name:'Т-Технологии',sector:'finance',base:3190,drift:.011,activity:1.4,lot:1},
  {ticker:'CHMF',name:'Северсталь',sector:'metals',base:1288,drift:-.012,activity:1.15,lot:1}
 ];
 const rounded=n=>Math.round(n*100)/100;
 function series(instrument,scenario='normal'){
  const index=instruments.findIndex(x=>x.ticker===instrument.ticker),phase=index*.91,drift=scenario==='pressure'?-.016-Math.abs(instrument.drift)*.65:instrument.drift;
  const activity=instrument.activity*(scenario==='volume'?1.75:scenario==='pressure'?1.25:1);
  let previous=instrument.base;
  return Array.from({length:60},(_,i)=>{
   const baseline=18000*(1+.25*Math.sin(i/9+phase)),wave=.0018*Math.sin(i/4+phase)-.0018*Math.sin(phase),close=rounded(instrument.base*(1+drift*(i+1)/60+wave));
   const volume=Math.round(baseline*activity*(1+.13*Math.sin(i/3+phase))),buyShare=Math.max(.15,Math.min(.85,.5+drift*8+.055*Math.sin(i/8+phase)));
   const buy=Math.round(volume*buyShare),depth=Math.max(-.8,Math.min(.8,drift*13+.11*Math.sin(i/7+phase))),depthTotal=80000*(1+index*.2);
   const candle={minute:i,open:previous,close,high:rounded(Math.max(previous,close)+instrument.base*(.0005+.0002*Math.sin(i+phase)**2)),low:rounded(Math.min(previous,close)-instrument.base*(.0005+.0002*Math.cos(i+phase)**2)),volume,buyVolume:buy,sellVolume:volume-buy,expectedVolume:baseline,bidDepth:Math.round(depthTotal*(1+depth)/2),askDepth:Math.round(depthTotal*(1-depth)/2),spread:rounded(instrument.base*(.0002+index*.000015))};previous=close;return candle;
  });
 }
 function snapshot(instrument,bars){
  if(!bars.length)throw Error('Нет свечей для расчёта.');
  const last=bars.at(-1),volume=bars.reduce((sum,c)=>sum+c.volume,0),buyVolume=bars.reduce((sum,c)=>sum+c.buyVolume,0),expected=bars.reduce((sum,c)=>sum+c.expectedVolume,0);
  return {...instrument,price:last.close,change:(last.close/instrument.base-1)*100,volume,relativeVolume:volume/expected,buyShare:buyVolume/volume,imbalance:(last.bidDepth-last.askDepth)/(last.bidDepth+last.askDepth),turnover:bars.reduce((sum,c)=>sum+c.volume*(c.open+c.close)/2,0),spread:last.spread,bars};
 }
 function aggregate(bars,interval){
  if(![1,5,15].includes(interval))throw Error('Неизвестный интервал.');
  const result=[];for(let i=0;i<bars.length;i+=interval){const part=bars.slice(i,i+interval);result.push({minute:part[0].minute,endMinute:part.at(-1).minute,open:part[0].open,close:part.at(-1).close,high:Math.max(...part.map(c=>c.high)),low:Math.min(...part.map(c=>c.low)),volume:part.reduce((s,c)=>s+c.volume,0)});}return result;
 }
 function screen(rows,{search='',sector='all',unusual=false,favoritesOnly=false,favorites=[],sort='volume'}={}){
  const query=search.trim().toLocaleLowerCase('ru');
  return rows.filter(row=>(!query||(row.ticker+' '+row.name).toLocaleLowerCase('ru').includes(query))&&(sector==='all'||row.sector===sector)&&(!unusual||row.relativeVolume>=1.5)&&(!favoritesOnly||favorites.includes(row.ticker))).sort((a,b)=>sort==='ticker'?a.ticker.localeCompare(b.ticker):sort==='change'?b.change-a.change:sort==='imbalance'?b.imbalance-a.imbalance:b.relativeVolume-a.relativeVolume);
 }
 function risk({direction,entry,stop,target,lots,lot,capital,current}){
  if(!['long','short'].includes(direction)||![entry,stop,target,lots,lot,capital,current].every(n=>Number.isFinite(n)&&n>0)||!Number.isInteger(lots)||lots>1000000||!Number.isInteger(lot)||lot>100000)throw Error('Укажите положительные цены, капитал и целое количество лотов.');
  if(direction==='long'?!(stop<entry&&entry<target):!(target<entry&&entry<stop))throw Error(direction==='long'?'Для лонга: стоп < вход < цель.':'Для шорта: цель < вход < стоп.');
  const quantity=lots*lot,loss=Math.abs(entry-stop)*quantity,reward=Math.abs(target-entry)*quantity;
  return {quantity,loss,reward,riskPercent:loss/capital*100,ratio:reward/loss,pnl:(current-entry)*quantity*(direction==='long'?1:-1),notional:entry*quantity};
 }
 globalThis.OrbitaMarketDemo={instruments,series,snapshot,aggregate,screen,risk};
})();
