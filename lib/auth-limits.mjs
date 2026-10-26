// Account counters have a longer window than the general request budget.
// Never evict a live key to admit another: that would reset brute-force limits.
export function createAttemptLimiter({maxKeys=10000,windowMs=900000,now=Date.now}={}){
 if(!Number.isSafeInteger(maxKeys)||maxKeys<1||!Number.isSafeInteger(windowMs)||windowMs<1||typeof now!=='function')throw Error('Invalid account attempt limit');
 const entries=new Map();
 return {take(buckets){
  const at=now();for(const [key,item]of entries)if(item.until<at)entries.delete(key);
  for(const [key,limit]of buckets){
   let item=entries.get(key);
   if(!item){if(entries.size>=maxKeys)return false;item={count:0,until:at+windowMs};entries.set(key,item);}
   item.count++;if(item.count>limit)return false;
  }
  return true;
 }};
}
