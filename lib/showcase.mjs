// Public landing example. Only coarse facts leave the server: instrument,
// direction, dates and status. Entry, stop, targets and author comments stay
// private. A result is shown only for an entered idea with a verified, fresh
// exchange price; otherwise it is omitted rather than estimated.
export function showcaseResult({dir,entry,price}){
 if(!Number.isFinite(entry)||entry<=0||!Number.isFinite(price)||price<=0)return null;
 const change=(price/entry-1)*100;return Math.round((dir==='ШОРТ'?-change:change)*100)/100;
}
export async function buildShowcase({ideas,markets}){
 const item=await ideas.showcase();if(!item)return null;
 const {_entry:entry,...visible}=item;let result=null;
 if(item.state==='active'&&Number.isFinite(entry)&&markets?.priceFor){
  const quote=await markets.priceFor(item.market,item.ticker);const pct=quote?showcaseResult({dir:item.dir,entry,price:quote.price}):null;
  if(pct!==null)result={pct,source:quote.source,priceTime:quote.providerTime,delayMinutes:quote.delayMinutes,method:item.dir==='ШОРТ'?'(вход − текущая цена) / вход':'(текущая цена − вход) / вход'};
 }
 return {...visible,result};
}
