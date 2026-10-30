export class MockMarketDataProvider{
 async reaction(event){
  if(event.isDemo!==true)return null;
  const seed=[...event.ticker].reduce((sum,char)=>sum+char.charCodeAt(0),0),priceBefore=Number((100+seed%500).toFixed(2)),direction=event.impact==='NEGATIVE'?-1:event.impact==='POSITIVE'?1:0;
  const reaction={priceBefore,isDemo:true};
  for(const [window,scale]of [['1m',.2],['5m',.5],['15m',.8],['1h',1.1],['1d',1.4]]){const price=Number((priceBefore*(1+direction*scale/100)).toFixed(2));reaction['price'+window]=price;reaction['change'+window]=Number(((price/priceBefore-1)*100).toFixed(3));}
  return reaction;
 }
}
