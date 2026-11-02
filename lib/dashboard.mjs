import {PLANS,activePlans,canReadStrategy,hasSubscription,isAdmin} from './access.mjs';
import {validatePosition} from './positions.mjs';
import {buildSubscriptionReminders,summarizeSubscriptions} from './subscription-reminders.mjs';
import {error,json,safeFailure} from './http.mjs';

const LIMITS={positions:6,updates:8,radar:5,support:3};
const named=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
const text=(value,max)=>typeof value==='string'?value.slice(0,max):'';
const time=value=>{
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return null;
 const parsed=Date.parse(value),date=value.slice(0,10),clock=value.slice(11,19);
 if(!Number.isFinite(parsed)||clock>'23:59:59'||Number(clock.slice(3,5))>59||Number(clock.slice(6,8))>59)return null;
 const midnight=Date.parse(date+'T00:00:00Z');return Number.isFinite(midnight)&&new Date(midnight).toISOString().slice(0,10)===date?parsed:null;
};
const iso=value=>new Date(value).toISOString();
const demo=record=>record.demo===true||record.isDemo===true||record.id.startsWith('demo-')||record.id.startsWith('exclusive-');
const issue=()=>error(409,'Аккаунт или подписка изменились. Обновите «Мою Орбиту».','DASHBOARD_ACCESS_CHANGED');

// Only a live identify() result supplies effective administrator permissions.
// Raw account records are used solely to select this owner's private data.
function safeUser(user,at){
 const subscriptions=Array.isArray(user.subscriptions)?user.subscriptions:[];
 const result={...user,subscriptions};
 result.access={isAdmin:isAdmin(result),activePlans:activePlans(result,at),hasSubscription:hasSubscription(result,at)};
 return result;
}
function signature(user,at){
 if(!user)return null;const current=safeUser(user,at);
 return JSON.stringify({id:current.id,email:current.email,role:current.role,subscriptions:current.subscriptions.map(item=>({plan:item.plan,expiresAt:item.expiresAt})),access:current.access,security:{mfaEnabled:current.security?.mfaEnabled===true,adminEnrollmentRequired:current.security?.adminEnrollmentRequired===true,mfaRequiredForAdmin:current.security?.mfaRequiredForAdmin===true}});
}
function subscriptionState(user,at){
 const active=new Set(activePlans(user,at)),effective=new Map();
 for(const record of user.subscriptions){if(!record||!Object.hasOwn(PLANS,record.plan))continue;const value=Date.parse(record.expiresAt);if(Number.isFinite(value)&&(!effective.has(record.plan)||value>effective.get(record.plan)))effective.set(record.plan,value);}
 return summarizeSubscriptions(user,{now:at}).map(card=>{
  const actual=effective.get(card.plan),strict=card.expiresAt===null?undefined:Date.parse(card.expiresAt),accessActive=active.has(card.plan);
  return actual!==strict?{...card,status:'unknown',expiresAt:null,remainingMs:null,daysRemaining:null,accessActive,reason:'unsupported_expiration'}:{...card,accessActive};
 });
}
const empty=()=>({positions:{items:[],total:0},updates:{items:[],total:0},radar:{available:false,limited:false,disabled:false,items:[],returnedCount:0},support:{items:[],total:0,waitingCount:0},sections:{positions:'locked',updates:'locked',radar:'locked',support:'ready'}});

export function createDashboard({accounts,ideas,radar,support,now=Date.now}={}){
 if(typeof accounts?.identify!=='function'||typeof accounts?.readDatabase!=='function'||typeof accounts?.checkRequest!=='function'||typeof now!=='function')throw Error('Dashboard requires trusted accounts and clock.');
 const at=()=>{const value=now();if(typeof value!=='number'||!Number.isFinite(value)||!Number.isFinite(new Date(value).getTime()))throw Error('Invalid dashboard reference time');return value;};
 async function overview(req,original){
  if(!original||!named(original.id))throw error(401,'Войдите в аккаунт.');
  const identified=await accounts.identify(req);if(!identified||identified.id!==original.id)throw error(401,'Войдите в аккаунт.');
  const started=at(),user=safeUser(identified,started),expected=signature(identified,started),db=await accounts.readDatabase();
  if(!Array.isArray(db?.users))throw Object.assign(Error('Invalid account source'),{code:'DATA_INVALID'});
  const owner=db.users.find(item=>item?.id===user.id);if(!owner)throw error(401,'Войдите в аккаунт.');
  if(signature({...identified,subscriptions:owner.subscriptions},started)!==expected)throw issue();
  const subscriptions=subscriptionState(user,started),unknown=new Set(subscriptions.filter(item=>item.status==='unknown').map(item=>item.plan));
  const result={user:{id:user.id,email:text(user.email,254),isAdmin:isAdmin(user)},subscriptions,reminders:buildSubscriptionReminders(user,{now:started}).filter(item=>!unknown.has(item.plan)),...empty(),checkedAt:iso(started)};
  const saved=[];
  for(const candidate of Array.isArray(owner.positions)?owner.positions:[]){try{saved.push(validatePosition(candidate));}catch{}}
  const tracked=new Set([...(Array.isArray(owner.watchlist)?owner.watchlist.filter(named):[]),...saved.map(position=>position.ideaId)]);
  async function ideasSection(){
   if(!hasSubscription(user,started))return;
   try{
    if(typeof ideas?.list!=='function')throw Error('Idea source unavailable');
    const source=await ideas.list(user);if(!Array.isArray(source?.records))throw Error('Invalid idea source');
    const allowed=new Map(source.records.filter(record=>record&&named(record.id)&&record.published===true&&record.d&&canReadStrategy(user,record.d.strategy,started)).map(record=>[record.id,record]));
    const positions=[],seen=new Set();
    for(const position of saved){
     const record=allowed.get(position.ideaId);if(!record||position.exit!==null||seen.has(position.ideaId))continue;seen.add(position.ideaId);
     const d=record.d;if(!['stocks','futures','crypto'].includes(d.market)||!['ЛОНГ','ШОРТ'].includes(d.dir))continue;
     positions.push({ideaId:record.id,ticker:text(d.ticker,30),name:text(d.name,100),market:d.market,unit:text(d.unit,20),strategy:text(d.strategy,80),dir:d.dir,entry:position.entry,quantity:position.quantity,pointValue:position.pointValue,enteredAt:position.enteredAt,authorState:text(d.state,30),authorStatus:text(d.status,100),isDemo:demo(record),erroneous:record.erroneous===true,needsExitReview:record.erroneous===true||['closed','cancelled'].includes(d.state),href:'/app.html?idea='+encodeURIComponent(record.id)});
    }
    positions.sort((a,b)=>Date.parse(b.enteredAt)-Date.parse(a.enteredAt)||a.ideaId.localeCompare(b.ideaId));
    const updates=[],events=new Set();
    for(const record of allowed.values()){
     if(!tracked.has(record.id)||record.erroneous===true)continue;
     for(const event of Array.isArray(record.meta?.events)?record.meta.events:[]){
      if(!Array.isArray(event)||event.length<4)continue;const data=event[3],eventAt=time(data?.at);
      if(!named(data?.id)||eventAt===null||eventAt>started)continue;
      const id=record.id+':'+data.id;if(events.has(id))continue;events.add(id);
      updates.push({id,ideaId:record.id,ticker:text(record.d.ticker,30),strategy:text(record.d.strategy,80),type:text(data.type,60),title:text(event[1],200),body:text(event[2],1000),at:iso(eventAt),isDemo:demo(record),href:'/app.html?idea='+encodeURIComponent(record.id)});
     }
    }
    updates.sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||a.id.localeCompare(b.id));
    result.positions={items:positions.slice(0,LIMITS.positions),total:positions.length};result.updates={items:updates.slice(0,LIMITS.updates),total:updates.length};result.sections.positions=result.sections.updates='ready';
   }catch{result.positions={items:[],total:null};result.updates={items:[],total:null};result.sections.positions=result.sections.updates='unavailable';}
  }
  async function radarSection(){
   if(!radar)return;
   try{
    if(radar.config?.enabled===false){result.radar.disabled=true;return;}
    if(typeof radar.canAccess!=='function')throw Error('Radar source unavailable');
    if(!radar.canAccess(user))return;
    result.radar.available=true;result.radar.limited=typeof radar.canRealtime==='function'?!radar.canRealtime(user):false;
    if(typeof radar.overview!=='function')throw Error('Radar overview unavailable');
    const source=await radar.overview(user);if(!Array.isArray(source?.events))throw Error('Invalid Radar source');
    const events=[];for(const event of source.events){const published=time(event?.publishedAt);if(!event||!named(event.id)||published===null||published>started)continue;events.push({id:event.id,ticker:text(event.ticker,30),companyName:text(event.companyName,150),eventType:text(event.eventType,60),headline:text(event.headline,300),summary:text(event.summary,result.radar.limited?240:600),impact:text(event.impact,30),publishedAt:iso(published),isDemo:event.isDemo===true,href:result.radar.limited?'/radar.html':'/radar.html?event='+encodeURIComponent(event.id)});}
    events.sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt)||a.id.localeCompare(b.id));result.radar.items=events.slice(0,LIMITS.radar);result.radar.returnedCount=result.radar.items.length;result.sections.radar='ready';
   }catch{result.radar={available:false,limited:false,disabled:false,items:[],returnedCount:null};result.sections.radar='unavailable';}
  }
  async function supportSection(){
   try{
    if(typeof support?.readDatabase!=='function')throw Error('Support source unavailable');
    const source=await support.readDatabase();if(!Array.isArray(source?.tickets))throw Error('Invalid support source');
    const tickets=source.tickets.filter(ticket=>ticket&&ticket.userId===user.id&&named(ticket.id)&&['open','in_progress','waiting_customer','resolved'].includes(ticket.status)&&time(ticket.updatedAt)!==null);
    tickets.sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt)||String(a.number).localeCompare(String(b.number)));
    const items=tickets.slice(0,LIMITS.support).map(ticket=>{const last=Array.isArray(ticket.messages)?ticket.messages.at(-1):null,hasReply=ticket.status==='waiting_customer'&&last?.author==='admin'&&typeof last.text==='string'&&time(last.createdAt)!==null;return {id:ticket.id,number:text(ticket.number,30),subject:text(ticket.subject,120),status:ticket.status,updatedAt:iso(Date.parse(ticket.updatedAt)),hasReply,lastReply:hasReply?{text:text(last.text,300),createdAt:iso(Date.parse(last.createdAt))}:null,href:'/support.html?ticket='+encodeURIComponent(ticket.id)};});
    result.support={items,total:tickets.length,waitingCount:tickets.filter(ticket=>ticket.status==='waiting_customer').length};
   }catch{result.support={items:[],total:null,waitingCount:null};result.sections.support='unavailable';}
  }
  await Promise.all([ideasSection(),radarSection(),supportSection()]);
  const latest=await accounts.identify(req);if(!latest||latest.id!==user.id)throw error(401,'Войдите в аккаунт.');if(signature(latest,at())!==expected)throw issue();
  return result;
 }
 async function handle(req,res,url,user){
  if(url.pathname!=='/api/dashboard')return false;
  try{if(!user)throw error(401,'Войдите в аккаунт.');accounts.checkRequest(req);if(req.method!=='GET')throw error(405,'Метод не поддерживается.');if(url.search)throw error(400,'Параметры адреса не поддерживаются.');json(res,200,await overview(req,user));}
  catch(cause){if(cause.status)json(res,cause.status,{error:cause.message,...(cause.code?{code:cause.code}:{})});else safeFailure(res,cause,{scope:'dashboard',route:url.pathname,storageMessage:'Данные кабинета временно недоступны. Повторите запрос или обратитесь в поддержку и укажите код обращения.',failureMessage:'Не удалось собрать «Мою Орбиту». Повторите запрос или обратитесь в поддержку.'});}return true;
 }
 return {handle,webhookPaths:[]};
}
