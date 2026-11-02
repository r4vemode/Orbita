import {PLANS,isAdmin} from './access.mjs';

const DAY=86400000,HOUR=3600000;
const plans=Object.keys(PLANS);
const ISO=/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

function referenceTime(value){
 if(typeof value!=='number'||!Number.isFinite(value)||!Number.isFinite(new Date(value).getTime()))throw new TypeError('now must be valid epoch milliseconds');
 return value;
}
function expiration(value){
 if(typeof value!=='string')return null;
 const match=value.match(ISO);if(!match)return null;
 const [,date,hour,minute,second,,zone]=match;
 if(Number(hour)>23||Number(minute)>59||Number(second)>59)return null;
 const midnight=Date.parse(date+'T00:00:00.000Z');
 if(!Number.isFinite(midnight)||new Date(midnight).toISOString().slice(0,10)!==date)return null;
 if(zone!=='Z'&&(Number(zone.slice(1,3))>23||Number(zone.slice(4,6))>59))return null;
 const time=Date.parse(value);return Number.isFinite(time)?time:null;
}
function expirations(user){
 const result=new Map(plans.map(plan=>[plan,null]));
 // Current account writes keep at most one entry per plan; revocation removes
 // that entry. Legacy null/invalid entries do not cancel other grants, matching
 // activePlans(). Among valid grants use the latest expiration, never the first.
 for(const record of Array.isArray(user?.subscriptions)?user.subscriptions:[]){
  if(!record||typeof record!=='object'||Array.isArray(record)||typeof record.plan!=='string'||!Object.hasOwn(PLANS,record.plan))continue;
  const time=expiration(record.expiresAt);if(time===null)continue;
  const previous=result.get(record.plan);if(previous===null||time>previous)result.set(record.plan,time);
 }
 return result;
}

/** Actual stored subscription state, independently for both plans. No access is granted here. */
export function summarizeSubscriptions(user,{now=Date.now()}={}){
 const at=referenceTime(now),effective=expirations(user);
 return plans.map(plan=>{
  const details=PLANS[plan],time=effective.get(plan),remainingMs=time===null?null:time-at;
  return {plan,name:details.name,price:details.price,days:details.days,expiresAt:time===null?null:new Date(time).toISOString(),status:time===null?'none':remainingMs>0?'active':'expired',remainingMs,daysRemaining:remainingMs===null?0:Math.max(0,Math.ceil(remainingMs/DAY)),renewUrl:'/subscriptions.html?plan='+encodeURIComponent(plan)};
 });
}

/** In-app reminders derived from current expirations; no scheduling, delivery or writes. */
export function buildSubscriptionReminders(user,{now=Date.now()}={}){
 const at=referenceTime(now);
 if(isAdmin(user)||user?.access?.isAdmin===true||user?.security?.adminEnrollmentRequired===true||user?.security?.mfaRequiredForAdmin===true)return [];
 const reminders=[];
 for(const subscription of summarizeSubscriptions(user,{now:at})){
  const remaining=subscription.remainingMs;if(remaining===null)continue;
  const state=remaining>0?(remaining<=24*HOUR?'expiring_today':remaining<=72*HOUR?'expiring_soon':null):remaining>=-7*DAY?'expired':null;
  if(!state)continue;
  const {plan,name,expiresAt,remainingMs,daysRemaining,renewUrl}=subscription;
  reminders.push({id:'subscription:'+plan+':'+expiresAt+':'+state,plan,name,expiresAt,state,remainingMs,daysRemaining,renewUrl});
 }
 return reminders;
}
