const DAY=86400000;
const id=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value);
const object=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
function timestamp(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return null;
  const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:null;
}
const rate=(numerator,denominator)=>denominator>0?numerator/denominator:null;
const median=values=>values.length?values.length%2?values[(values.length-1)/2]:(values[values.length/2-1]+values[values.length/2])/2:null;

/** Aggregate stored facts only. This function never returns account/order identifiers. */
export function buildMvpMetrics({accounts,billing,now=Date.now()}={}){
  const validNow=typeof now==='number'&&Number.isFinite(now),members=new Map();
  const users=Array.isArray(accounts)?accounts:Array.isArray(accounts?.users)?accounts.users:[];
  if(validNow)for(const user of users){
    if(!object(user)||user.role!=='member'||!id(user.id)||members.has(user.id))continue;
    const createdAt=timestamp(user.createdAt);if(createdAt===null||createdAt>now)continue;
    members.set(user.id,user);
  }
  const source=Array.isArray(billing)?billing:Array.isArray(billing?.orders)?billing.orders:[],orders=[],seen=new Set();
  if(validNow)for(const order of source){
    if(!object(order)||!id(order.id)||seen.has(order.id)||!members.has(order.userId)||!['pro','exclusive'].includes(order.plan)||order.testMode!==false||!['paid','refund_review'].includes(order.status)||order.payment?.verified!==true||order.refund?.full===true||order.refundedAt)continue;
    const createdAt=timestamp(order.createdAt),paidAt=timestamp(order.payment.at),creditedAt=timestamp(order.creditedAt);
    if([createdAt,paidAt,creditedAt].some(value=>value===null||value>now))continue;
    seen.add(order.id);orders.push({id:order.id,userId:order.userId,plan:order.plan,createdAt,paidAt,creditedAt});
  }
  const registeredMembers=members.size,verifiedMembers=[...members.values()].filter(user=>user.emailVerified===true).length,paidMembers=new Set(orders.map(order=>order.userId)).size;
  const latencies=orders.map(order=>order.creditedAt-order.paidAt).filter(value=>Number.isFinite(value)&&value>=0).sort((a,b)=>a-b);
  const cohorts=new Map();
  for(const order of orders){const key=JSON.stringify([order.userId,order.plan]),list=cohorts.get(key)||[];list.push(order);cohorts.set(key,list);}
  let eligible=0,renewed=0,pendingGrace=0;
  for(const group of cohorts.values()){
    // Access starts when credit is applied, even if the checkout was created much earlier.
    group.sort((a,b)=>a.creditedAt-b.creditedAt||a.id.localeCompare(b.id));const first=group[0],renewalAt=first.creditedAt+30*DAY,deadline=first.creditedAt+37*DAY;
    if(now<renewalAt)continue;
    eligible++;if(now<deadline)pendingGrace++;
    if(group.slice(1).some(order=>order.creditedAt<=deadline))renewed++;
  }
  const emptyReason=validNow?null:'invalid_reference_time';
  const stats=object(accounts?.registrationStats)?accounts.registrationStats:null,startedAt=timestamp(stats?.startedAt);
  const measured=validNow&&stats&&startedAt!==null&&startedAt<=now&&Number.isSafeInteger(stats.validAttempts)&&stats.validAttempts>=0&&Number.isSafeInteger(stats.successful)&&stats.successful>=0&&stats.successful<=stats.validAttempts;
  return {
    registration:{successful:registeredMembers,measuredSuccessful:measured?stats.successful:null,attempts:measured?stats.validAttempts:null,rate:measured?rate(stats.successful,stats.validAttempts):null,measurementStartedAt:measured?new Date(startedAt).toISOString():null,reason:emptyReason||(measured?'valid_submissions':'not_collected')},
    emailVerification:{registeredMembers,verifiedMembers,rate:rate(verifiedMembers,registeredMembers),reason:emptyReason||(registeredMembers?'stored_accounts':'no_registered_members')},
    paymentConversion:{registeredMembers,paidMembers,liveOrders:orders.length,rate:rate(paidMembers,registeredMembers),reason:emptyReason||(registeredMembers?'live_credited_non_refunded_orders':'no_registered_members')},
    activationLatency:{sampleCount:latencies.length,medianMs:median(latencies),p95Ms:latencies.length?latencies[Math.ceil(latencies.length*.95)-1]:null,reason:emptyReason||(latencies.length?'payment_to_credit':'no_latency_samples')},
    renewal30d:{eligible,renewed,rate:rate(renewed,eligible),observationDays:30,graceDays:7,anchor:'first_credit',pendingGrace,reason:emptyReason||(!eligible?'no_mature_cohorts':pendingGrace?'grace_window_open':'cohort_window_complete')}
  };
}
