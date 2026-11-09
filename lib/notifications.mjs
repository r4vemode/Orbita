import {validateNews} from './news.mjs';
import {reclaimAbandonedLock} from './storage-lock.mjs';
import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm,stat,lstat} from 'node:fs/promises';
import path from 'node:path';
import {activePlans,canReadStrategy,hasSubscription,PLANS} from './access.mjs';
import {error,json,readJson,safeFailure} from './http.mjs';

const WEBHOOK='/api/notifications/telegram/webhook';
const ROUTES=new Set(['/api/notifications/preferences','/api/notifications/telegram/link',WEBHOOK]);
const FLAGS=['ideaUpdates','newSignals','expiryReminders','radarEvents','marketAlerts','morningDigest'];
const DAY=86400000,LINK_TTL=10*60000,LEASE=60000,MAX_ATTEMPTS=6;
const hash=value=>createHash('sha256').update(String(value)).digest('hex');
const clone=value=>structuredClone(value);
const defaults=()=>({ideaUpdates:false,newSignals:false,expiryReminders:false,radarEvents:false,marketAlerts:false,morningDigest:false,epoch:randomUUID(),startedAt:null,cursors:{},accessSignature:null});
const enabled=p=>FLAGS.some(key=>p?.[key]);
const tracked=(user,id)=>(user.watchlist||[]).includes(id)||(user.positions||[]).some(position=>position.ideaId===id);
const signature=(user,now)=>user.role==='admin'?'admin':activePlans(user,now).sort().join(',');
const eventId=(event,index)=>event?.[3]?.id||'legacy-'+hash(JSON.stringify([index,event])).slice(0,32);
const currentCursors=records=>Object.fromEntries(records.filter(record=>record.published).map(record=>[record.id,eventId(record.meta?.events?.at(-1),Math.max(0,(record.meta?.events?.length||1)-1))]));
const terminal=item=>['sent','discarded','failed'].includes(item.status);
function only(object,keys){if(!object||typeof object!=='object'||Array.isArray(object)||Object.keys(object).some(key=>!keys.includes(key)))throw error(400,'Запрос содержит недопустимые поля.');}
function configuredOptions(config){
  const botToken=config.botToken??process.env.TELEGRAM_BOT_TOKEN??'';
  const botUsername=(config.botUsername??process.env.TELEGRAM_BOT_USERNAME??'').replace(/^@/,'');
  const webhookSecret=config.webhookSecret??process.env.TELEGRAM_WEBHOOK_SECRET??'';
  let publicOrigin=null;
  try{const url=new URL(config.publicOrigin??process.env.ORBITA_PUBLIC_ORIGIN??'');if(url.protocol==='https:'&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash)publicOrigin=url.origin;}catch{}
  const configured=/^\d{5,20}:[A-Za-z0-9_-]{20,}$/.test(botToken)&&/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(botUsername)&&/^[A-Za-z0-9_-]{16,256}$/.test(webhookSecret)&&!!publicOrigin;
  return {botToken,botUsername,webhookSecret,publicOrigin,configured};
}
function reminderStage(expiresAt,now){const delta=Date.parse(expiresAt)-now;if(!Number.isFinite(delta))return null;if(delta>DAY&&delta<=3*DAY)return 'three-days';if(delta>0&&delta<=DAY)return 'one-day';if(delta<=0&&delta>=-7*DAY)return 'expired';return null;}
// Short, scannable messages: the trading fact first, the link last. Day traders
// read these on a phone lock screen, so levels and results come before prose.
function ideaMessage(record,event,origin){
  const d=record.d,info=event[3]||{},type=info.type,unit=d.unit?' '+d.unit:'',fmt=value=>Number(value).toLocaleString('ru-RU',{maximumFractionDigits:8});
  const dir=d.dir==='ШОРТ'?'SHORT':'LONG',tier=d.strategy==='Orbita Exclusive'?'EXCLUSIVE':'PRO',ok=value=>Number.isFinite(value)&&value>0;
  const pnl=exit=>ok(exit)&&ok(d.entry)?(exit/d.entry-1)*100*(d.dir==='ШОРТ'?-1:1):null,signed=value=>value===null?'':` · ${value>=0?'+':'−'}${Math.abs(value).toLocaleString('ru-RU',{maximumFractionDigits:2})}%`;
  const levels=src=>ok(src?.entry)&&ok(src?.stop)&&ok(src?.target)?`Вход ${fmt(src.entry)} · Стоп ${fmt(src.stop)} · Цель ${fmt(src.target)}${unit}`:'';
  let text;
  if(type==='published'){const lv=levels(info.after||d);text=`🆕 ${d.ticker}: новый сигнал · ${d.dir} · ${tier}${lv?'\n'+lv:'\nУровни будут опубликованы отдельно.'}`;}
  else if(type==='levels')text=`📐 ${d.ticker} ${dir}: добавлены уровни\n${levels(info.after||d)}`;
  else if(type==='activate')text=`▶️ ${d.ticker} ${dir}: вход выполнен по ${fmt(d.entry)}${unit}\nСтоп ${fmt(d.stop)} · Цель ${fmt(d.target)}`;
  else if(type==='target')text=`✅ ${d.ticker} ${dir}: цель ${fmt(info.after?.exit??d.target)}${unit} достигнута${signed(pnl(info.after?.exit??d.target))}`;
  else if(type==='stop')text=`⛔ ${d.ticker} ${dir}: закрыта по стопу ${fmt(info.after?.exit??d.stop)}${unit}${signed(pnl(info.after?.exit??d.stop))}`;
  else if(type==='manual')text=`🔒 ${d.ticker} ${dir}: закрыта вручную по ${fmt(info.after?.exit)}${unit}${signed(pnl(info.after?.exit))}`;
  else if(type==='cancel')text=`✖️ ${d.ticker} ${dir}: отменена до входа`;
  else if(type==='stop-change'&&Number.isFinite(info.before?.stop)&&Number.isFinite(info.after?.stop))text=`🛡 ${d.ticker}: стоп изменён с ${fmt(info.before.stop)} до ${fmt(info.after.stop)}${unit}`;
  else if(type==='target-change'&&Number.isFinite(info.before?.target)&&Number.isFinite(info.after?.target))text=`🎯 ${d.ticker}: цель изменена с ${fmt(info.before.target)} до ${fmt(info.after.target)}${unit}`;
  else if(type==='terms-change')text=`✏️ ${d.ticker}: условия до входа обновлены\n${levels(info.after||d)}`;
  else text=`${d.ticker}: ${event[1]||'обновление идеи'}`;
  if(type==='note')text+='\n'+String(event[2]||'').slice(0,400);
  else if(info.note&&['stop-change','target-change','terms-change','cancel','manual'].includes(type))text+='\n'+String(info.note).slice(0,200);
  return `${text.trim()}\n${origin}/app.html?idea=${encodeURIComponent(record.id)}`.slice(0,3500);
}
function reminderMessage(item,origin){
  const expiry=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(item.expiresAt));
  const status=item.stage==='expired'?'Подписка завершилась':item.stage==='one-day'?'До завершения подписки осталось меньше суток':'Подписка скоро завершится';
  return `${status}: ${PLANS[item.plan].name}.\nСрок доступа: ${expiry} МСК.\nУправление подпиской: ${origin}/subscriptions.html\nНастройки уведомлений: ${origin}/notifications.html`;
}

export async function createNotifications(directory,{accounts,ideas,radar,markets=null,push=null,config={},fetchImpl=globalThis.fetch,now=Date.now}={}){
  if(!accounts?.readDatabase||!ideas?.list||!ideas?.get)throw new Error('Notifications require trusted account and idea readers.');
  const options=configuredOptions(config),file=path.join(directory,'notifications.json'),lock=file+'.lock';
  await mkdir(directory,{recursive:true,mode:0o700});
  // Delivery channels: a Telegram binding and/or browser push devices. A push-only
  // user gets a virtual binding with a stable epoch, so the outbox rules are shared.
  const pushSince=new Map(),tgReady=()=>options.configured;
  const bindingOf=(db,userId)=>(tgReady()?db.bindings[userId]:null)||(pushSince.has(userId)?{epoch:'push',linkedAt:pushSince.get(userId),push:true}:null);
  async function refreshPush(userIds){if(!push?.configured)return;for(const id of userIds){const since=await push.earliest(id);if(since)pushSince.set(id,since);else pushSince.delete(id);}}
  let queue=Promise.resolve(),running=null,closed=false;const inFlight=new Map();
  async function load(){try{const db=JSON.parse(await readFile(file,'utf8'));if(db.version!==1||!db.preferences||!db.bindings||!Array.isArray(db.links)||!Array.isArray(db.outbox))throw new Error('Invalid notifications database.');return db;}catch(e){if(e.code==='ENOENT')return {version:1,preferences:{},bindings:{},links:[],outbox:[]};throw e;}}
  await load();
  async function acquire(){const deadline=Date.now()+5000;while(true){try{await mkdir(lock,{mode:0o700});try{await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid}),{mode:0o600});}catch(e){await rm(lock,{recursive:true,force:true});throw e;}return;}catch(e){if(e.code!=='EEXIST')throw e;try{const owner=JSON.parse(await readFile(path.join(lock,'owner.json'),'utf8'));try{process.kill(owner.pid,0);}catch(gone){if(gone.code==='ESRCH'&&await reclaimAbandonedLock(lock)){continue;}}}catch(missing){if(missing.code==='ENOENT'){try{if(Date.now()-(await stat(lock)).mtimeMs>30000&&await reclaimAbandonedLock(lock)){continue;}}catch{}}}if(Date.now()>deadline)throw error(409,'Настройки уведомлений заняты. Повторите запрос.');await new Promise(resolve=>setTimeout(resolve,25));}}}
  function transact(fn){const job=queue.then(async()=>{await acquire();let temp;try{const db=await load(),value=await fn(db);db.links=db.links.filter(link=>link.expiresAt>now());db.outbox=db.outbox.filter(item=>!terminal(item)||item.updatedAt>now()-30*DAY);temp=file+'.tmp-'+randomUUID();await writeFile(temp,JSON.stringify(db),{mode:0o600});await rename(temp,file);temp=null;return value;}finally{if(temp)await rm(temp,{force:true});await rm(lock,{recursive:true,force:true});}});queue=job.catch(()=>{});return job;}
  async function deliveryUser(user){if(!user)return null;return {...user,...await accounts.getUser(user.id)};}
  async function currentOwner(req,user){const current=await accounts.identify(req);if(!current?.id||current.id!==user.id)throw error(401,'Войдите в аккаунт.');return current;}
  async function rawUser(id){return deliveryUser((await accounts.readDatabase()).users.find(user=>user.id===id));}
  async function accessibleRecords(user){if(!user||!signature(user,now()))return [];try{return (await ideas.list(user)).records.filter(record=>record.published&&canReadStrategy(user,record.d.strategy,now()));}catch(e){if([401,403].includes(e.status))return [];throw e;}}
  function discard(db,userId,kind){for(const item of db.outbox)if(item.userId===userId&&!terminal(item)&&(!kind||item.kind===kind)){item.status='discarded';item.updatedAt=now();}}
  function stopFlight(userId){inFlight.get(userId)?.abort();}
  function publicPreferences(db,userId){const p=db.preferences[userId]||defaults(),binding=db.bindings[userId];return {configured:options.configured,preferences:Object.fromEntries(FLAGS.map(key=>[key,!!p[key]])),telegram:{linked:!!binding,linkedAt:binding?.linkedAt||null,botUsername:options.configured?options.botUsername:null}};}
  async function webhook(req,res){
    if(req.method!=='POST')throw error(405,'Метод не поддерживается.');
    if(!options.configured)throw error(503,'Telegram пока не настроен.');
    const supplied=req.headers['x-telegram-bot-api-secret-token'];
    if(typeof supplied!=='string'||!timingSafeEqual(Buffer.from(hash(supplied),'hex'),Buffer.from(hash(options.webhookSecret),'hex')))throw error(403,'Недопустимый webhook.');
    const update=await readJson(req),message=update.message;
    if(!message||message.chat?.type!=='private'||!Number.isSafeInteger(message.chat.id)||message.chat.id<=0||!Number.isSafeInteger(message.from?.id)||message.from.id!==message.chat.id||message.from.is_bot===true||typeof message.text!=='string'){json(res,200,{ok:true,linked:false});return;}
    const chatId=String(message.chat.id),telegramUserId=String(message.from.id);
    if(/^\/stop(?:@\w+)?(?:\s|$)/.test(message.text.trim())){
      const owner=await transact(db=>{const userId=Object.keys(db.bindings).find(id=>db.bindings[id].chatId===chatId&&db.bindings[id].telegramUserId===telegramUserId);if(!userId)return null;delete db.bindings[userId];const p=db.preferences[userId]||(db.preferences[userId]=defaults());FLAGS.forEach(flag=>p[flag]=false);p.epoch=randomUUID();p.cursors={};p.startedAt=null;db.links=db.links.filter(link=>link.userId!==userId);discard(db,userId);return userId;});
      if(owner)stopFlight(owner);json(res,200,{ok:true,linked:false});return;
    }
    const match=message.text.trim().match(/^\/start(?:@\w+)?\s+(orb_[A-Za-z0-9_-]{43})$/);
    if(!match){json(res,200,{ok:true,linked:false});return;}
    const tokenHash=hash(match[1]);
    const snapshot=await load(),link=snapshot.links.find(item=>item.hash===tokenHash&&item.expiresAt>now()),owner=link?await rawUser(link.userId):null;
    if(!owner){json(res,200,{ok:true,linked:false});return;}
    const records=await accessibleRecords(owner);
    const linked=await transact(db=>{const token=db.links.find(item=>item.hash===tokenHash&&item.userId===owner.id&&item.expiresAt>now());if(!token)return false;if(Object.entries(db.bindings).some(([userId,binding])=>userId!==owner.id&&(binding.chatId===chatId||binding.telegramUserId===telegramUserId)))return false;db.links=db.links.filter(item=>item.userId!==owner.id);db.bindings[owner.id]={chatId,telegramUserId,linkedAt:new Date(now()).toISOString(),epoch:randomUUID()};const p=db.preferences[owner.id]||(db.preferences[owner.id]=defaults());p.epoch=randomUUID();p.startedAt=now();p.cursors=currentCursors(records);p.accessSignature=signature(owner,now());discard(db,owner.id);return true;});
    if(linked)stopFlight(owner.id);json(res,200,{ok:true,linked});
  }
  async function handle(req,res,url,user){
    if(!ROUTES.has(url.pathname))return false;
    try{
      if(url.pathname===WEBHOOK){await webhook(req,res);return true;}
      if(!user?.id)throw error(401,'Войдите в аккаунт.');
      if(url.pathname==='/api/notifications/preferences'){
        if(req.method==='GET'){json(res,200,publicPreferences(await load(),user.id));return true;}
        if(req.method==='PUT'){
          const input=await readJson(req);only(input,FLAGS);for(const flag of Object.keys(input))if(typeof input[flag]!=='boolean')throw error(400,'Выберите настройки уведомлений.');
          await currentOwner(req,user);const owner=await rawUser(user.id);if(!owner)throw error(401,'Аккаунт недоступен.');const records=await accessibleRecords(owner);
          const value=await transact(async db=>{await currentOwner(req,user);const p=db.preferences[user.id]||(db.preferences[user.id]=defaults());if(FLAGS.some(flag=>Object.hasOwn(input,flag)&&input[flag]!==p[flag])){Object.assign(p,input,{epoch:randomUUID(),startedAt:now(),cursors:currentCursors(records),accessSignature:signature(owner,now())});discard(db,user.id);}return publicPreferences(db,user.id);});
          stopFlight(user.id);json(res,200,value);return true;
        }
      }
      if(url.pathname==='/api/notifications/telegram/link'){
        if(req.method==='POST'){
          if(!options.configured)throw error(503,'Telegram пока не настроен. Настройки сохранены, отправка не выполняется.');
          const input=await readJson(req);only(input,[]);
          const token='orb_'+randomBytes(32).toString('base64url'),expiresAt=now()+LINK_TTL;
          await transact(async db=>{await currentOwner(req,user);db.links=db.links.filter(link=>link.userId!==user.id);db.links.push({userId:user.id,hash:hash(token),expiresAt});});
          json(res,200,{deepLink:`https://t.me/${options.botUsername}?start=${token}`,expiresAt:new Date(expiresAt).toISOString()});return true;
        }
        if(req.method==='DELETE'){
          await transact(async db=>{await currentOwner(req,user);delete db.bindings[user.id];db.links=db.links.filter(link=>link.userId!==user.id);const p=db.preferences[user.id]||(db.preferences[user.id]=defaults());p.epoch=randomUUID();p.startedAt=null;p.cursors={};discard(db,user.id);});stopFlight(user.id);json(res,200,{ok:true});return true;
        }
      }
      throw error(405,'Метод не поддерживается.');
    }catch(e){if(e.status)json(res,e.status,{error:e.message,...(e.code?{code:e.code}:{})});else safeFailure(res,e,{scope:'notifications',route:url.pathname,storageMessage:'Настройки уведомлений временно не могут быть сохранены. Обратитесь в поддержку и укажите код обращения.',failureMessage:'Не удалось обновить настройки уведомлений. Повторите попытку или обратитесь в поддержку.',storageCode:'NOTIFICATION_STORAGE_UNAVAILABLE',failureCode:'NOTIFICATION_REQUEST_FAILED'});}
    return true;
  }
  function enqueue(db,item){if(!db.outbox.some(existing=>existing.key===item.key))db.outbox.push({...item,status:'pending',attempts:0,nextAttemptAt:now(),createdAt:now(),updatedAt:now()});}
  async function discover(){
    const owners=await Promise.all((await accounts.readDatabase()).users.map(deliveryUser)),snapshot=await load();await refreshPush(owners.filter(Boolean).map(o=>o.id));
    for(const owner of owners){
      const p=snapshot.preferences[owner.id],binding=bindingOf(snapshot,owner.id);
      if(!enabled(p)||!binding)continue;
      const records=await accessibleRecords(owner),accessSignature=signature(owner,now());
      const digestDate=digestDue(now());
      const marketEvents=p.marketAlerts&&markets?.alerts&&markets.canAccess(owner)?await markets.alerts({since:Math.max(p.startedAt??now(),Date.parse(binding.linkedAt)||now(),now()-DAY)}):[];
      const radarEvents=p.radarEvents&&radar?.notificationsFor?await radar.notificationsFor(owner,{since:Math.max(p.startedAt??now(),Date.parse(binding.linkedAt)||now(),now()-DAY)}):[];
      await transact(db=>{
        const live=db.preferences[owner.id],liveBinding=bindingOf(db,owner.id);
        if(!live||live.epoch!==p.epoch||!liveBinding||liveBinding.epoch!==binding.epoch)return;
        if(live.accessSignature!==accessSignature){live.accessSignature=accessSignature;live.cursors=currentCursors(records);discard(db,owner.id,'idea');}
        else if(live.ideaUpdates||live.newSignals){
          for(const record of records){
            const events=record.meta?.events||[],previous=live.cursors[record.id];
            const index=previous?events.findIndex((event,i)=>eventId(event,i)===previous):-1;
            const isNewRecord=!previous&&Date.parse(record.meta?.publishedAt)>=(live.startedAt??now());
            const start=index>=0?index+1:isNewRecord?0:events.length;
            for(let i=start;i<events.length;i++){
              const event=events[i],type=event[3]?.type,at=Date.parse(event[3]?.at);
              if(!Number.isFinite(at)||at<(live.startedAt??now())||at<now()-DAY||at>now()+300000)continue;
              if(!((live.newSignals&&type==='published')||(live.ideaUpdates&&tracked(owner,record.id))))continue;
              enqueue(db,{key:hash(`${owner.id}:idea:${record.id}:${eventId(event,i)}`),userId:owner.id,kind:'idea',ideaId:record.id,eventId:eventId(event,i),strategy:record.d.strategy,preferenceEpoch:live.epoch,bindingEpoch:liveBinding.epoch,expiresAt:new Date(at+DAY).toISOString()});
            }
          }
          live.cursors=currentCursors(records);
        }
        if(live.expiryReminders)for(const subscription of owner.subscriptions||[]){
          if(!Object.hasOwn(PLANS,subscription.plan))continue;const stage=reminderStage(subscription.expiresAt,now());if(!stage)continue;
          enqueue(db,{key:hash(`${owner.id}:expiry:${subscription.plan}:${subscription.expiresAt}:${stage}`),userId:owner.id,kind:'expiry',plan:subscription.plan,expiresAt:subscription.expiresAt,stage,preferenceEpoch:live.epoch,bindingEpoch:liveBinding.epoch});
        }
        if(live.morningDigest&&digestDate&&hasSubscription(owner,now()))enqueue(db,{key:hash(`${owner.id}:digest:${digestDate}`),userId:owner.id,kind:'digest',type:'MORNING_DIGEST',eventId:digestDate,preferenceEpoch:live.epoch,bindingEpoch:liveBinding.epoch,expiresAt:new Date(Date.parse(digestDate+'T13:00:00+03:00')).toISOString()});
        if(live.marketAlerts)for(const event of marketEvents){
          const at=Date.parse(event.at);if(!Number.isFinite(at)||at<now()-DAY)continue;
          enqueue(db,{key:hash(`${owner.id}:market:${event.id}`),userId:owner.id,kind:'market',type:'MARKET_ALERT',eventId:event.id,preferenceEpoch:live.epoch,bindingEpoch:liveBinding.epoch,expiresAt:new Date(at+DAY).toISOString()});
        }
        if(live.radarEvents)for(const event of radarEvents){
          const at=Date.parse(event.firstPublishedAt||event.processedAt);if(!Number.isFinite(at)||at<now()-DAY||at>now()+300000)continue;
          enqueue(db,{key:hash(`${owner.id}:radar:${event.id}`),userId:owner.id,kind:'radar',type:'RADAR_EVENT',eventId:event.id,preferenceEpoch:live.epoch,bindingEpoch:liveBinding.epoch,expiresAt:new Date(at+DAY).toISOString()});
        }
      });
    }
  }
  async function prepare(item){
    const owner=await rawUser(item.userId);if(!owner)return null;
    if(item.kind==='radar'){
      if(Date.parse(item.expiresAt)<=now())return null;
      const event=await radar?.getForNotification?.(owner,item.eventId);if(!event)return null;
      return {owner,event,text:radarMessage(event)};
    }
    if(item.kind==='digest'){
      if(Date.parse(item.expiresAt)<=now()||!hasSubscription(owner,now()))return null;
      return {owner,text:await digestMessage(owner,item.eventId)};
    }
    if(item.kind==='market'){
      if(Date.parse(item.expiresAt)<=now()||!markets?.canAccess(owner))return null;
      const event=await markets.alert(item.eventId);if(!event)return null;
      return {owner,event,text:marketMessage(event)};
    }
    if(item.kind==='expiry'){
      const subscription=(owner.subscriptions||[]).find(s=>s.plan===item.plan&&s.expiresAt===item.expiresAt);
      if(!subscription||reminderStage(subscription.expiresAt,now())!==item.stage)return null;
      return {owner,text:reminderMessage(item,options.publicOrigin)};
    }
    if(Date.parse(item.expiresAt)<=now()||!canReadStrategy(owner,item.strategy,now()))return null;
    let record;try{record=await ideas.get(item.ideaId,owner);}catch(e){if([401,403,404].includes(e.status))return null;throw e;}
    const events=record.meta?.events||[],event=events.find((value,i)=>eventId(value,i)===item.eventId);if(!event)return null;
    return {owner,record,event,text:ideaMessage(record,event,options.publicOrigin)};
  }
  function stillAllowed(db,item,owner,event){
    const p=db.preferences[item.userId],binding=bindingOf(db,item.userId);
    if(!p||!binding||p.epoch!==item.preferenceEpoch||binding.epoch!==item.bindingEpoch)return false;
    if(item.kind==='expiry')return p.expiryReminders;
    if(item.kind==='digest')return p.morningDigest===true&&hasSubscription(owner,now())&&Date.parse(item.expiresAt)>now();
    if(item.kind==='market')return p.marketAlerts===true&&Boolean(markets?.canAccess(owner))&&Date.parse(item.expiresAt)>now();
    if(item.kind==='radar')return p.radarEvents===true&&radar?.canRealtime(owner)===true&&Date.parse(item.expiresAt)>now();
    return canReadStrategy(owner,item.strategy,now())&&((p.newSignals&&event?.[3]?.type==='published')||(p.ideaUpdates&&tracked(owner,item.ideaId)));
  }
  async function settle(key,status,extra={}){await transact(db=>{const item=db.outbox.find(candidate=>candidate.key===key);if(!item||terminal(item))return;Object.assign(item,{status,updatedAt:now(),leaseUntil:null},extra);});}
  async function deliver(item){
    const prepared=await prepare(item);
    if(!prepared){await settle(item.key,'discarded');return false;}
    const claimed=await transact(db=>{const candidate=db.outbox.find(value=>value.key===item.key);if(!candidate||terminal(candidate)||candidate.nextAttemptAt>now()||(candidate.status==='sending'&&candidate.leaseUntil>now()))return null;if(!stillAllowed(db,candidate,prepared.owner,prepared.event)){candidate.status='discarded';candidate.updatedAt=now();return null;}candidate.status='sending';candidate.attempts++;candidate.leaseUntil=now()+LEASE;candidate.updatedAt=now();return {item:clone(candidate),chatId:tgReady()?db.bindings[item.userId]?.chatId??null:null};});
    if(!claimed)return false;
    const latest=await rawUser(item.userId),latestState=await load();
    if(!latest||!stillAllowed(latestState,claimed.item,latest,prepared.event)||(item.kind==='expiry'&&!(latest.subscriptions||[]).some(s=>s.plan===item.plan&&s.expiresAt===item.expiresAt))){await settle(item.key,'discarded');return false;}
    if(item.kind==='radar'){
      const event=await radar?.getForNotification?.(latest,item.eventId);if(!event){await settle(item.key,'discarded');return false;}
      prepared.text=radarMessage(event);
    }
    const controller=new AbortController();inFlight.set(item.userId,controller);const timeout=setTimeout(()=>controller.abort(),15000);timeout.unref?.();
    let retryAfter=0,code='network',success=false;
    // Push devices first (fast, independent of Telegram limits); Telegram as before.
    let pushed=0;if(push?.configured&&pushSince.has(item.userId)){try{const lines=prepared.text.split('\n'),last=lines.at(-1)||'',path=last.match(/(\/[a-z0-9-]+\.html(?:\?\S*)?)$/i);if(path)lines.pop();const urlPath=path?path[1]:'/strategies.html';pushed=(await push.send(item.userId,{title:lines[0].slice(0,120),body:lines.slice(1).join('\n'),url:urlPath,tag:item.kind+':'+(item.ideaId||item.eventId||'')})).sent;}catch{}}
    if(!claimed.chatId){clearTimeout(timeout);if(inFlight.get(item.userId)===controller)inFlight.delete(item.userId);if(pushed){await settle(item.key,'sent');return true;}code='push';}
    else try{
      const response=await fetchImpl(`https://api.telegram.org/bot${options.botToken}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:claimed.chatId,text:prepared.text,disable_web_page_preview:true}),signal:controller.signal});
      let payload;try{payload=await response.json();}catch{payload={};}
      if(response.ok&&payload.ok===true)success=true;
      else{const status=Number(payload.error_code||response.status);code=String(status||'provider');if(status===429){const seconds=Number(payload.parameters?.retry_after??response.headers?.get?.('retry-after'));if(Number.isFinite(seconds)&&seconds>0)retryAfter=Math.min(7*DAY,seconds*1000);}if(status>=400&&status<500&&status!==429)code='permanent-'+status;}
    }catch{code=controller.signal.aborted?'aborted':'network';}
    finally{clearTimeout(timeout);if(inFlight.get(item.userId)===controller)inFlight.delete(item.userId);}
    if(success||pushed){await settle(item.key,'sent');if(item.kind==='radar')await radar?.markNotificationSent?.(item.eventId,new Date(now()).toISOString());return true;}
    const retry=!(code.startsWith('permanent-'))&&claimed.item.attempts<MAX_ATTEMPTS;
    const nextAttemptAt=now()+Math.max(retryAfter,Math.min(3600000,30000*2**(claimed.item.attempts-1)));
    await settle(item.key,retry?'pending':'failed',{lastError:code,nextAttemptAt});
    if(code==='429')await transact(db=>{db.telegramRetryAt=Math.max(db.telegramRetryAt||0,nextAttemptAt);});
    return false;
  }
  async function work(){if(closed||!(options.configured||push?.configured))return {configured:options.configured,sent:0};await discover();const db=await load();if(db.telegramRetryAt>now())return {configured:true,sent:0};const due=db.outbox.filter(item=>!terminal(item)&&item.nextAttemptAt<=now()&&(item.status!=='sending'||item.leaseUntil<=now())).sort((a,b)=>a.createdAt-b.createdAt).slice(0,100);let sent=0;for(const item of due){if(closed||(await load()).telegramRetryAt>now())break;if(await deliver(item))sent++;}return {configured:true,sent};}
  // Single-flight; a request during a run schedules one more pass right after it.
  let again=false;
  function tick(){if(running){again=true;return running;}running=work().finally(()=>{running=null;if(again&&!closed){again=false;void tick();}});return running;}
  // Morning digest, weekdays 09:30–13:00 MSK, one message: open ideas the user
  // can read, futures crowd extremes, top Radar events and headlines overnight.
  function digestDue(at){const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',weekday:'short',hour12:false}).formatToParts(new Date(at)).map(p=>[p.type,p.value]));
   if(['Sat','Sun'].includes(parts.weekday))return null;const minutes=Number(parts.hour)*60+Number(parts.minute);if(minutes<9*60+30||minutes>=13*60)return null;return `${parts.year}-${parts.month}-${parts.day}`;}
  async function readNews(){try{const info=await lstat(path.join(directory,'news.json'));if(!info.isFile()||info.size>1024*1024)return [];return validateNews(JSON.parse(await readFile(path.join(directory,'news.json'),'utf8')));}catch{return [];}}
  async function digestMessage(owner,date){
   const since=Date.parse(date+'T09:30:00+03:00')-14.5*3600000,fmt=v=>Number(v).toLocaleString('ru-RU',{maximumFractionDigits:8}),lines=[`☀️ ORBITA · утро ${date.slice(8,10)}.${date.slice(5,7)}`];
   const open=(await accessibleRecords(owner)).filter(r=>!r.erroneous&&!r.archived&&['announced','waiting','active'].includes(r.d?.state)).slice(0,8);
   lines.push('',`Открытые идеи (${open.length}):`);if(!open.length)lines.push('— нет');
   for(const r of open){const d=r.d,st=d.state==='active'?'в сделке':d.state==='waiting'?'ждёт входа':'уровни скоро';lines.push(`• ${d.ticker} ${d.dir==='ШОРТ'?'SHORT':'LONG'} — ${st}${Number.isFinite(d.entry)?`: ${fmt(d.entry)} / стоп ${fmt(d.stop)} / цель ${fmt(d.target)}`:''}`);}
   const extremes=markets?.alerts&&markets.canAccess(owner)?await markets.alerts():[];
   if(extremes.length){lines.push('','Крайние позиции физлиц (фьючерсы):');for(const e of extremes.slice(0,5))lines.push(`• ${e.name}: ${e.direction==='long'?'лонг':'шорт'}, ${e.z>0?'+':''}${String(e.z).replace('.',',')}σ`);}
   const events=radar?.digestFor?await radar.digestFor(owner,{since,limit:4}):[];
   if(events.length){lines.push('','Radar за ночь:');for(const e of events)lines.push(`• ${e.ticker}: ${String(e.headline).slice(0,140)} (${e.importanceScore}/10)`);}
   const news=(await readNews()).filter(n=>Date.parse(n.publishedAt)>=since&&Date.parse(n.publishedAt)<=now());
   const top=[...news].sort((a,b)=>Number(b.urgent)-Number(a.urgent)||Number(b.tickers.length>0)-Number(a.tickers.length>0)||Number(b.sentiment!=='neutral')-Number(a.sentiment!=='neutral')||Date.parse(b.publishedAt)-Date.parse(a.publishedAt)).slice(0,5);
   if(top.length){lines.push('',`Главные новости (из ${news.length}):`);for(const n of top)lines.push(`• ${n.urgent?'⚡ ':''}${n.title.slice(0,160)}`);}
   lines.push('',`${options.publicOrigin}/strategies.html`);
   return lines.join('\n').slice(0,3900);
  }
  function marketMessage(event){const d=event.date.slice(8,10)+'.'+event.date.slice(5,7)+'.'+event.date.slice(0,4);return `ORBITA · Рынки\n${event.name} (${event.asset}): физлица необычно ${event.direction==='long'?'в лонге':'в шорте'} — нетто ${event.net.toLocaleString('ru-RU')} контр., отклонение ${event.z>0?'+':''}${String(event.z).replace('.',',')}σ от среднего за 20 сессий.\nДанные MOEX на ${d} (последняя завершённая сессия). Это статистика, не торговый сигнал.\n${options.publicOrigin}/markets.html`;}
  function radarMessage(event){return `${event.isDemo?'Демонстрация · ':''}ORBITA Radar\n${event.ticker}: ${event.headline}\n${String(event.summary||'').slice(0,1400)}\nВажность ${event.importanceScore}/10 · ${event.impact}\nКорпоративное событие, не торговый сигнал.\n${options.publicOrigin}/radar.html?event=${encodeURIComponent(event.id)}`.slice(0,3500);}
  async function close(){closed=true;for(const controller of inFlight.values())controller.abort();if(running)await running.catch(()=>{});await queue;}
  return {configured:options.configured,handle,webhookPaths:[WEBHOOK],tick,close};
}
