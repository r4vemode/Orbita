import {createHash,randomBytes} from 'node:crypto';
import {error,json,readJson,safeFailure} from '../http.mjs';
import {requireAdmin} from '../access.mjs';
import {findInstruments} from '../instruments.mjs';
import {activeIdeaFingerprint} from '../ideas.mjs';
import {radarDefaults,radarPreferences} from './radar-state.mjs';

const clone=v=>structuredClone(v),token=()=>randomBytes(18).toString('base64url'),hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const validId=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
const fingerprint=records=>records.map(r=>r.id+':'+(r.recordVersion??0)).sort().join('|');
const canonical=(db,id)=>{const seen=new Set();let e=db.events.find(e=>e.id===id);while(e?.mergedInto&&!seen.has(e.id)){seen.add(e.id);e=db.events.find(r=>r.id===e.mergedInto);}return e;};
const eventHash=e=>hash({id:e.id,revision:e.revision,ticker:e.ticker,status:e.status,isDemo:e.isDemo,companyId:e.companyId,sources:e.sources});
function only(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw error(400,'Неизвестные поля Radar workflow.');}
function eligible(db,e){return e&&e.status==='published'&&!e.isDemo&&db.companies.some(c=>c.id===e.companyId&&c.active)&&e.sources.some(s=>s.provider==='manual'||db.providerStates[s.provider]&&db.providerStates[s.provider].status!=='disabled');}
function quiet(p,at){const hour=new Date(at+3*3600000).getUTCHours();return p.quietStart!==p.quietEnd&&(p.quietStart<p.quietEnd?hour>=p.quietStart&&hour<p.quietEnd:hour>=p.quietStart||hour<p.quietEnd);}
function compact(e){return Object.fromEntries(['id','ticker','companyName','assetType','eventType','headline','summary','whyImportant','importanceScore','impact','revision','publishedAt','analysisMethod','isDemo','sources'].map(k=>[k,clone(e[k]??null)]));}
export function createRadarAdminWorkflow({radar,ideas,store,send,publicOrigin,now=Date.now,draftTtlMs=1800000}={}){
 const available=()=>Boolean(radar?.config?.enabled&&radar.readDatabase);
 async function database(){if(!available())throw error(503,'Radar сейчас отключён.');return radar.readDatabase();}
 async function event(id){if(!validId(id))throw error(400,'Некорректное событие.');const db=await database(),e=canonical(db,id);if(!eligible(db,e))throw error(409,'Событие скрыто, учебное или его источник отключён. Обновите Radar.');return e;}
 async function authorize(actor,req){const current=req?await store.webIdentity(req):await store.authorize(actor);requireAdmin(current);if(current.id!==actor.id)throw error(403,'Аккаунт администратора изменился.');return current;}
 async function transact(actor,req,work){return req?store.webRadar(req,(s,user)=>{if(user.id!==actor.id)throw error(403,'Аккаунт изменился.');return work(s);}):store.radarTransact(actor,work);}
 async function inspect(actor,id,req){await authorize(actor,req);const e=await event(id),records=(await ideas.list(actor)).records,db=await database(),related=records.filter(r=>r.radarSource&&canonical(db,r.radarSource.eventId)?.id===e.id),state=await store.radarRead(req?null:actor);await authorize(actor,req);const instruments=(e.assetType==='stock'?findInstruments(e.ticker,{records}):[]).filter(i=>i.ticker.toUpperCase()===e.ticker.toUpperCase()&&i.market==='stocks');return {event:compact(e),relatedSignals:related.map(r=>({id:r.id,ticker:r.d.ticker,state:r.d.state,dir:r.d.dir,recordVersion:r.recordVersion??0})),instruments,ignored:state.ignored.some(i=>i.userId===actor.id&&i.eventId===e.id),claimed:state.drafts.some(d=>d.eventId===e.id&&d.userId!==actor.id&&d.expiresAt>now()&&!d.completed),relatedFingerprint:fingerprint(related.filter(r=>r.radarSource.eventId===e.id))};}
 async function begin(actor,id,input,req){
  only(input,['requestId','allowAnother','instrumentId']);if(typeof input.requestId!=='string'||!/^[A-Za-z0-9_-]{12,100}$/.test(input.requestId)||input.allowAnother!==undefined&&typeof input.allowAnother!=='boolean')throw error(400,'Проверьте идентификатор черновика.');
  const info=await inspect(actor,id,req);if(info.relatedSignals.length&&!input.allowAnother)throw error(409,'По событию уже есть сигнал. Подтвердите создание ещё одного.');
  const instrument=info.instruments.find(i=>input.instrumentId?i.id===input.instrumentId:info.instruments.length===1);if(!instrument)throw error(400,'Тикер события отсутствует в поддерживаемом каталоге акций. Создайте сигнал вручную для проверенного инструмента.');
  const e=await event(info.event.id),at=now();const draft=await transact(actor,req,s=>{
   s.drafts=s.drafts.filter(d=>d.expiresAt+86400000>at);const prior=s.drafts.find(d=>d.userId===actor.id&&d.requestId===input.requestId);
   if(prior){if(prior.eventId!==e.id||prior.instrumentId!==instrument.id||prior.allowAnother!==Boolean(input.allowAnother))throw error(409,'Идентификатор черновика использован с другими условиями.');if(prior.expiresAt<=at)throw error(409,'Черновик истёк. Откройте событие заново.');return prior;}
   if(s.drafts.some(d=>d.eventId===e.id&&d.userId!==actor.id&&d.expiresAt>at&&!d.completed))throw error(409,'Другой редактор уже готовит сигнал по этому событию. Обновите карточку позже.');
   if(s.drafts.length>=2000)throw error(429,'Слишком много черновиков.');
   const d={id:token(),userId:actor.id,bindingId:actor.bindingId??null,eventId:e.id,eventRevision:e.revision,eventHash:eventHash(e),instrumentId:instrument.id,requestId:input.requestId,allowAnother:Boolean(input.allowAnother),relatedFingerprint:info.relatedFingerprint,createdAt:at,expiresAt:at+draftTtlMs};s.drafts.push(d);return d;
  });return {draftToken:draft.id,expiresAt:new Date(draft.expiresAt).toISOString(),event:info.event,instrument,relatedSignals:info.relatedSignals};
 }
 async function draft(actor,id,req){await authorize(actor,req);const state=await store.radarRead(req?null:actor),d=state.drafts.find(d=>d.id===id&&d.userId===actor.id&&d.bindingId===(actor.bindingId??null));if(!d||d.expiresAt<=now())throw error(409,'Черновик Radar истёк. Откройте событие заново.');return d;}
 async function publish(actor,payload,{draftToken,req,context={}}={}){
  const d=await draft(actor,draftToken,req),e=await event(d.eventId),records=(await ideas.list(actor)).records,instrument=findInstruments(e.ticker,{records}).find(i=>i.id===d.instrumentId);
  if(!instrument||payload.mode!=='full'||payload.d?.ticker!==instrument.ticker||payload.d?.market!=='stocks')throw error(400,'Для события нужен полный сценарий по выбранному инструменту.');
  const result=await ideas.create(actor,payload,{...context,radarSource:{eventId:d.eventId,eventRevision:d.eventRevision,headline:e.headline,ticker:e.ticker,draftId:d.id},expectedRadarFingerprint:d.relatedFingerprint,expectedDuplicateFingerprint:context.expectedDuplicateFingerprint??activeIdeaFingerprint(records,'stocks',instrument.ticker),authorize:async()=>{
   const current=await authorize(actor,req);if(context.authorize)await context.authorize();await draft(actor,draftToken,req);const fresh=await event(d.eventId);if(eventHash(fresh)!==d.eventHash)throw error(409,'Событие Radar изменилось. Проверьте его и откройте новый черновик.');return current;
  }});
  await transact(actor,req,s=>{const stored=s.drafts.find(v=>v.id===d.id);if(stored)stored.completed=result.record.id;return {ok:true};});return result;
 }
 async function ignore(actor,id,ignored=true,req){if(typeof ignored!=='boolean')throw error(400,'Некорректная отметка.');const e=await event(id);return transact(actor,req,s=>{s.ignored=s.ignored.filter(i=>!(i.userId===actor.id&&i.eventId===e.id));if(ignored){if(s.ignored.length>=10000)throw error(429,'Журнал отметок заполнен.');s.ignored.push({userId:actor.id,eventId:e.id,at:now()});}return {ignored};});}
 async function release(actor,draftToken,req){return transact(actor,req,s=>{const d=s.drafts.find(v=>v.id===draftToken&&v.userId===actor.id&&v.bindingId===(actor.bindingId??null));if(d&&!d.completed)d.expiresAt=now();return {ok:true};});}
 async function preferences(req,input){const actor=await store.webIdentity(req),bindings=await store.radarBindings(),binding=bindings.find(b=>b.id===actor.id);if(input===undefined){const s=await store.radarRead();return {preferences:s.preferences.find(p=>p.bindingId===binding?.bindingId)?.value||radarDefaults(),linked:Boolean(binding),enabled:available(),delivery:s.alerts.filter(a=>a.bindingId===binding?.bindingId).reduce((r,a)=>(r[a.status]=(r[a.status]||0)+1,r),{})};}
  if(!binding)throw error(409,'Сначала подключите Telegram.');const p=radarPreferences(input);return store.webRadar(req,s=>{let record=s.preferences.find(p=>p.bindingId===binding.bindingId);if(!record){record={bindingId:binding.bindingId,enabledAt:now(),value:p};s.preferences.push(record);}else{if(p.enabled&&!record.value.enabled)record.enabledAt=now();record.value=p;}return {preferences:p};});
 }
 async function alert(actor,id){const s=await store.radarRead(actor),a=s.alerts.find(a=>a.id===id&&a.bindingId===actor.bindingId);if(!a||a.createdAt+7*86400000<now())throw error(409,'Уведомление Radar устарело. Откройте событие на сайте.');return {alert:a,event:await event(a.eventId)};}
 async function enqueue(){
  if(!available())return;const db=await database(),bindings=await store.radarBindings(),at=now(),snapshot=await store.radarRead(),liveIds=new Set(bindings.map(b=>b.bindingId));
  const needsPrune=snapshot.alerts.some(a=>!liveIds.has(a.bindingId)||a.createdAt+30*86400000<=at)||snapshot.preferences.some(p=>!liveIds.has(p.bindingId));
  const needsEvents=bindings.some(b=>{const p=snapshot.preferences.find(p=>p.bindingId===b.bindingId);return p?.value.enabled&&db.events.some(e=>eligible(db,e)&&Date.parse(e.lastPublishedAt||e.firstPublishedAt)>p.enabledAt&&Date.parse(e.lastPublishedAt||e.firstPublishedAt)<=at&&Date.parse(e.lastPublishedAt||e.firstPublishedAt)>=at-86400000&&e.importanceScore>=p.value.minimumImportance&&(e.assetType==='bond'?p.value.bonds:p.value.stocks)&&(!p.value.eventTypes.length||p.value.eventTypes.includes(e.eventType))&&!snapshot.ignored.some(i=>i.userId===b.id&&i.eventId===e.id)&&!snapshot.alerts.some(a=>a.bindingId===b.bindingId&&canonical(db,a.eventId)?.id===e.id));});
  if(!needsPrune&&!needsEvents)return;
  await store.radarTransact(null,s=>{
   const live=new Set(bindings.map(b=>b.bindingId));s.alerts=s.alerts.filter(a=>live.has(a.bindingId)&&a.createdAt+30*86400000>at);s.preferences=s.preferences.filter(p=>live.has(p.bindingId));
   for(const identity of bindings){const entry=s.preferences.find(p=>p.bindingId===identity.bindingId);if(!entry?.value.enabled)continue;const p=entry.value;
    for(const e of db.events){const published=Date.parse(e.lastPublishedAt||e.firstPublishedAt);if(!eligible(db,e)||published<=entry.enabledAt||published>at||published<at-86400000||e.importanceScore<p.minimumImportance||!(e.assetType==='bond'?p.bonds:p.stocks)||p.eventTypes.length&&!p.eventTypes.includes(e.eventType)||s.ignored.some(i=>i.userId===identity.id&&i.eventId===e.id)||s.alerts.some(a=>a.bindingId===identity.bindingId&&canonical(db,a.eventId)?.id===e.id))continue;if(s.alerts.length>=10000)break;s.alerts.push({id:token(),bindingId:identity.bindingId,eventId:e.id,status:'pending',createdAt:at,nextAttemptAt:at,attempts:0});}
   }return {ok:true};
  });
 }
 async function pump(){
  if(!available()||typeof send!=='function'||!publicOrigin)return;await enqueue();const identities=await store.radarBindings();
  for(const identity of identities){const state=await store.radarRead(identity),pref=state.preferences.find(p=>p.bindingId===identity.bindingId)?.value;if(!pref?.enabled)continue;
   for(const a of state.alerts.filter(a=>a.bindingId===identity.bindingId&&['pending','sending'].includes(a.status)&&a.nextAttemptAt<=now()&&(!a.leaseUntil||a.leaseUntil<=now())).slice(0,10)){
    let e;try{e=await event(a.eventId);}catch(cause){if(cause.status===409||cause.status===503){await store.radarTransact(identity,s=>{const current=s.alerts.find(v=>v.id===a.id);if(current)current.status='skipped';return {};});continue;}throw cause;}
    if(e.importanceScore<pref.minimumImportance||!(e.assetType==='bond'?pref.bonds:pref.stocks)||pref.eventTypes.length&&!pref.eventTypes.includes(e.eventType)||state.ignored.some(i=>i.userId===identity.id&&i.eventId===e.id)){await store.radarTransact(identity,s=>{const current=s.alerts.find(v=>v.id===a.id);if(current)current.status='skipped';return {};});continue;}
    if(quiet(pref,now())&&e.importanceScore<pref.criticalImportance)continue;
    const leased=await store.radarTransact(identity,s=>{const v=s.alerts.find(v=>v.id===a.id),p=s.preferences.find(p=>p.bindingId===identity.bindingId)?.value;if(!v||!p?.enabled||!['pending','sending'].includes(v.status)||v.leaseUntil>now())return false;if(v.attempts>=5){v.status='failed';return false;}v.status='sending';v.leaseUntil=now()+60000;v.attempts++;return true;});if(!leased)continue;
    try{await store.authorize(identity);const fresh=await event(e.id);const result=await send('sendMessage',{chat_id:identity.chatId,text:`Radar · ${fresh.ticker} · ${fresh.importanceScore}/10\n${fresh.headline}\n\n${fresh.summary.slice(0,900)}\n\n${fresh.analysisMethod==='ai'?'AI-разбор требует проверки. ':''}Это событие, а не готовый торговый сигнал.`,link_preview_options:{is_disabled:true},reply_markup:{inline_keyboard:[[{text:'Создать сигнал',callback_data:'tr:'+a.id+':create'}],[{text:'Открыть событие',url:publicOrigin+'/radar-admin.html?event='+encodeURIComponent(fresh.id)},{text:'Пропустить',callback_data:'tr:'+a.id+':ignore'}]]}});await store.radarTransact(identity,s=>{const v=s.alerts.find(v=>v.id===a.id);if(v){v.status='sent';v.leaseUntil=0;v.messageId=result?.message_id??result?.result?.message_id??null;}return {};});}
    catch(cause){if([401,403].includes(cause.status))break;await store.radarTransact(identity,s=>{const v=s.alerts.find(v=>v.id===a.id);if(v){v.status=v.attempts>=5?'failed':'pending';v.leaseUntil=0;v.nextAttemptAt=now()+Math.min(300000,1000*2**v.attempts);}return {};});}
   }
  }
 }
 async function handle(req,res,url,user){const match=url.pathname.match(/^\/api\/admin\/radar-workflow\/([A-Za-z0-9_-]{1,100})(?:\/(draft|ignore|release))?$/),settings=url.pathname==='/api/admin/telegram/radar';if(!match&&!settings)return false;
  try{requireAdmin(user);if(url.search)throw error(400,'Параметры адреса не поддерживаются.');if(settings){if(req.method==='GET')json(res,200,await preferences(req));else if(req.method==='PUT')json(res,200,await preferences(req,await readJson(req)));else throw error(405,'Метод не поддерживается.');}
   else if(req.method==='GET'&&!match[2])json(res,200,await inspect(user,match[1],req));
   else if(req.method==='POST'&&match[2]==='draft')json(res,201,await begin(user,match[1],await readJson(req),req));
   else if(req.method==='POST'&&match[2]==='release'){const input=await readJson(req);only(input,['draftToken']);if(!validId(input.draftToken))throw error(400,'Проверьте черновик.');json(res,200,await release(user,input.draftToken,req));}
   else if(req.method==='POST'&&match[2]==='ignore'){const input=await readJson(req);only(input,['ignored']);json(res,200,await ignore(user,match[1],input.ignored,req));}
   else throw error(405,'Метод не поддерживается.');
  }catch(cause){if(cause.status)json(res,cause.status,{error:cause.message});else safeFailure(res,cause,{scope:'radar-workflow',route:url.pathname});}return true;
 }
 return {handle,inspect,begin,publish,ignore,release,preferences,alert,pump};
}
