import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm,lstat,stat} from 'node:fs/promises';
import path from 'node:path';
import {activePlans,isAdmin,requireAdmin} from '../access.mjs';
import {error,json,readJson,safeFailure} from '../http.mjs';
import {radarConfiguration} from './config.mjs';
import {createRadarJobs} from './jobs.mjs';
import {DEMO_COMPANIES,EVENT_TYPES,IMPACTS,plainText,safeSourceUrl} from './model.mjs';
import {createPipeline,deduplicateEvent} from './pipeline.mjs';
import {createConfiguredAnalysis} from './analysis.mjs';
import {createProviderRegistry} from './providers/index.mjs';
import {createMockProvider} from './providers/mock.mjs';
import {MockMarketDataProvider} from './providers/market.mjs';

const MAX_BYTES=32*1024*1024,MAX_EVENTS=10000,MAX_SUBSCRIPTIONS=20000,MAX_AUDIT=200;
const clone=value=>structuredClone(value),object=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
const iso=value=>typeof value==='string'&&value.length<=40&&Number.isFinite(Date.parse(value));
const bounded=(value,max)=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const enums=value=>Array.isArray(value)?value:Object.values(value);
const TYPES=enums(EVENT_TYPES),DIRECTIONS=enums(IMPACTS),STATUSES=['published','draft','hidden','duplicate'];
function only(value,fields){if(!object(value)||Object.keys(value).some(key=>!fields.includes(key)))throw error(400,'Запрос Radar содержит недопустимые поля.');}
function requiredText(value,max,label){if(!bounded(value,max)||!value.trim())throw error(400,'Проверьте поле «'+label+'».');return plainText(value).trim();}
function score(value){if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>10)throw error(400,'Важность должна быть числом от 0 до 10.');return Math.round(value*10)/10;}
function sourceValid(source){return object(source)&&id(source.id)&&bounded(source.provider,80)&&bounded(source.externalId,500)&&bounded(source.url,2000)&&safeSourceUrl(source.url)===source.url&&iso(source.publishedAt)&&bounded(source.rawTitle,1000);}
function eventValid(event){
  return object(event)&&id(event.id)&&(event.companyId===null||id(event.companyId))&&bounded(event.ticker,30)&&bounded(event.companyName,300)&&['stock','bond'].includes(event.assetType)&&TYPES.includes(event.eventType)&&DIRECTIONS.includes(event.impact)&&STATUSES.includes(event.status)&&bounded(event.headline,300)&&bounded(event.summary,4000)&&bounded(event.whyImportant,4000)&&bounded(event.rawText,40000)&&Number.isFinite(event.importanceScore)&&event.importanceScore>=0&&event.importanceScore<=10&&Number.isFinite(event.confidence)&&event.confidence>=0&&event.confidence<=1&&Number.isSafeInteger(event.revision)&&event.revision>=1&&Array.isArray(event.sources)&&event.sources.length<=64&&event.sources.every(sourceValid)&&Array.isArray(event.tags)&&event.tags.length<=30&&event.tags.every(tag=>bounded(tag,80))&&Array.isArray(event.trace)&&event.trace.length<=MAX_AUDIT&&Array.isArray(event.audit)&&event.audit.length<=MAX_AUDIT&&['publishedAt','detectedAt','processedAt','createdAt','updatedAt'].every(key=>iso(event[key]))&&['firstPublishedAt','lastPublishedAt','notificationSentAt'].every(key=>event[key]===null||iso(event[key]))&&typeof event.isDemo==='boolean'&&Buffer.byteLength(JSON.stringify(event))<=128*1024;
}
export function validateRadarDatabase(db){
  try{
    only(db,['version','revision','companies','events','subscriptions','providerStates','processingErrors']);
    if(db.version!==1||!Number.isSafeInteger(db.revision)||db.revision<0||!Array.isArray(db.companies)||db.companies.length>1000||!Array.isArray(db.events)||db.events.length>MAX_EVENTS||!Array.isArray(db.subscriptions)||db.subscriptions.length>MAX_SUBSCRIPTIONS||!object(db.providerStates)||!Array.isArray(db.processingErrors)||db.processingErrors.length>500)return false;
    const companies=new Set(),events=new Set(),subscriptions=new Set();
    for(const company of db.companies){if(!object(company)||!id(company.id)||companies.has(company.id)||!bounded(company.name,300)||!bounded(company.ticker,30)||!Array.isArray(company.aliases)||company.aliases.length>100||!company.aliases.every(alias=>bounded(alias,300))||typeof company.active!=='boolean')return false;companies.add(company.id);}
    for(const event of db.events){if(!eventValid(event)||events.has(event.id)||(event.companyId!==null&&!companies.has(event.companyId)))return false;events.add(event.id);}
    for(const subscription of db.subscriptions){if(!object(subscription)||!id(subscription.id)||subscriptions.has(subscription.id)||!id(subscription.userId)||(subscription.companyId!==null&&!companies.has(subscription.companyId))||(subscription.eventType!==null&&!TYPES.includes(subscription.eventType))||!Number.isFinite(subscription.minimumImportance)||subscription.minimumImportance<6||subscription.minimumImportance>10||typeof subscription.enabled!=='boolean'||!iso(subscription.createdAt)||!iso(subscription.updatedAt))return false;subscriptions.add(subscription.id);}
    for(const [key,state]of Object.entries(db.providerStates))if(!id(key)||!object(state)||state.id!==key||!bounded(state.name,100)||!['disabled','idle','online','error','running'].includes(state.status)||(state.cursor!==undefined&&state.cursor!==null&&!bounded(state.cursor,1000)))return false;
    return Buffer.byteLength(JSON.stringify(db))<=MAX_BYTES;
  }catch{return false;}
}

export async function createRadar(directory,{accounts,ideas,env=process.env,now=Date.now,providers:injectedProviders,pipeline:injectedPipeline,analysis,streamHeartbeatMs=5000,streamLifetimeMs=60000}={}){
  if(!accounts?.identify||!accounts?.checkRequest)throw Error('Radar requires trusted accounts.');
  const config=radarConfiguration(env),file=path.join(directory,'radar.json'),lock=file+'.lock',cursorSecret=randomBytes(32);
  await mkdir(directory,{recursive:true,mode:0o700});let queue=Promise.resolve(),closed=false;
  const providers=injectedProviders||createProviderRegistry({env,now});
  const pipeline=injectedPipeline||createPipeline({now,analysis:analysis||createConfiguredAnalysis({env}),...(config.marketReactionEnabled?{marketDataProvider:new MockMarketDataProvider()}: {})});
  const streams=new Set(),pendingStreamCounts=new Map();
  const stamp=()=>new Date(now()).toISOString();
  const initial=()=>({version:1,revision:0,companies:clone(DEMO_COMPANIES).map(company=>({...company,createdAt:stamp(),updatedAt:stamp()})),events:[],subscriptions:[],providerStates:Object.fromEntries(providers.map(provider=>[provider.id,{id:provider.id,name:provider.name,status:provider.enabled?'idle':'disabled',lastFetch:null,lastSuccess:null,eventsToday:0,errorsToday:0,averageDelay:null,nextAttemptAt:null,error:null}])),processingErrors:[]});
  async function load(){
    try{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>MAX_BYTES)throw Object.assign(Error('Unsafe Radar store'),{code:'DATA_UNSAFE'});const bytes=await readFile(file);if(bytes.length>MAX_BYTES)throw Object.assign(Error('Oversized Radar store'),{code:'DATA_INVALID'});const db=JSON.parse(bytes);if(!validateRadarDatabase(db))throw Object.assign(Error('Invalid Radar store'),{code:'DATA_INVALID'});return db;}
    catch(cause){if(cause.code==='ENOENT')return initial();if(cause instanceof SyntaxError)throw Object.assign(Error('Invalid Radar store'),{code:'DATA_INVALID'});throw cause;}
  }
  await load();
  async function acquire(){
    const deadline=Date.now()+5000;
    while(true){
      try{await mkdir(lock,{mode:0o700});try{await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid}),{mode:0o600});}catch(cause){await rm(lock,{recursive:true,force:true});throw cause;}return;}
      catch(cause){if(cause.code!=='EEXIST')throw cause;try{const owner=JSON.parse(await readFile(path.join(lock,'owner.json'),'utf8'));if(Number.isSafeInteger(owner.pid)&&owner.pid>0)try{process.kill(owner.pid,0);}catch(gone){if(gone.code==='ESRCH'){await rm(lock,{recursive:true,force:true});continue;}}}catch(missing){if(missing.code==='ENOENT')try{if(Date.now()-(await stat(lock)).mtimeMs>30000){await rm(lock,{recursive:true,force:true});continue;}}catch{}}
        if(Date.now()>=deadline)throw error(409,'Radar занят. Повторите действие.');await new Promise(resolve=>setTimeout(resolve,25));}
    }
  }
  function transact(work){
    const job=queue.then(async()=>{await acquire();let temp;try{const db=await load(),value=await work(db);if(db.revision>=Number.MAX_SAFE_INTEGER)throw error(409,'Достигнут предел версий Radar.');db.revision++;if(!validateRadarDatabase(db))throw Object.assign(Error('Invalid Radar update'),{code:'DATA_INVALID'});temp=file+'.tmp-'+randomUUID();await writeFile(temp,JSON.stringify(db),{mode:0o600});await rename(temp,file);temp=null;return {revision:db.revision,...clone(value)};}finally{if(temp)await rm(temp,{force:true});await rm(lock,{recursive:true,force:true});}});queue=job.catch(()=>{});return job;
  }
  const full=user=>Boolean(config.enabled&&(isAdmin(user)||activePlans(user,now()).some(plan=>config.allowedPlans.includes(plan))));
  const canAccess=user=>Boolean(config.enabled&&user&&(full(user)||config.freeEnabled));
  const canRealtime=user=>full(user);
  function requireAccess(user,{paid=false}={}){if(!user)throw error(401,'Войдите в аккаунт.');if(!config.enabled)throw error(403,'Radar пока отключён.','RADAR_DISABLED');if(!canAccess(user)||(paid&&!full(user)))throw error(403,'Для Radar нужна подходящая подписка.','SUBSCRIPTION_REQUIRED');}
  function activeCompany(db,event){return db.companies.some(company=>company.id===event.companyId&&company.active);}
  function eligible(db,event){return event.status==='published'&&activeCompany(db,event);}
  function publicEvent(event,{detail=false,free=false}={}){
    const card={id:event.id,companyId:event.companyId,ticker:event.ticker,companyName:event.companyName,assetType:event.assetType,isin:event.isin||null,eventType:event.eventType,headline:event.headline,summary:event.summary.slice(0,free?240:600),impact:event.impact,publishedAt:event.publishedAt,detectedAt:event.detectedAt,processedAt:event.processedAt,firstPublishedAt:event.firstPublishedAt,isDemo:event.isDemo,revision:event.revision};
    if(free)return card;
    Object.assign(card,{importanceScore:event.importanceScore,confidence:event.confidence,analysisMethod:event.analysisMethod,tags:clone(event.tags),actualValue:event.actualValue??null,expectedValue:event.expectedValue??null,previousValue:event.previousValue??null,surprisePercent:event.surprisePercent??null,marketReaction:config.marketReactionEnabled?clone(event.marketReaction):null,sourcesCount:event.sources.length,groupId:event.groupId||null});
    if(detail)Object.assign(card,{whyImportant:event.whyImportant,rawText:event.rawText,sources:clone(event.sources),extractedData:clone(event.extractedData||{}),notificationSentAt:event.notificationSentAt,lastPublishedAt:event.lastPublishedAt});
    return card;
  }
  function safeProviders(db){return Object.values(db.providerStates).map(state=>Object.fromEntries(['id','name','status','lastFetch','lastSuccess','eventsToday','errorsToday','averageDelay','nextAttemptAt','error'].map(key=>[key,state[key]??null])));}
  function parsedQuery(params,{admin=false,free=false}={}){
    const allowed=['importance','ticker','company','type','impact','from','to','limit','cursor','q','search','category','watchlist',...(admin?['status']:[])];
    for(const key of params.keys())if(!allowed.includes(key)||params.getAll(key).length>1)throw error(400,'Некорректные фильтры Radar.');
    const value=Object.fromEntries(params);for(const text of Object.values(value))if(text.length>300)throw error(400,'Фильтр Radar слишком длинный.');
    if(free&&['importance','type','impact','from','to','cursor','watchlist'].some(key=>params.has(key)))throw error(403,'Расширенные фильтры доступны по подписке.','SUBSCRIPTION_REQUIRED');
    if(free&&value.category&&!['all','stocks','bonds'].includes(value.category))throw error(403,'Расширенные категории доступны по подписке.','SUBSCRIPTION_REQUIRED');
    const importance=value.importance===undefined?admin?0:6:Number(value.importance);if(!Number.isFinite(importance)||importance<0||importance>10||value.importance==='')throw error(400,'Проверьте важность события.');
    const limit=value.limit===undefined?admin?50:20:Number(value.limit);if(!Number.isInteger(limit)||limit<1||limit>50)throw error(400,'Размер страницы должен быть от 1 до 50.');
    if(value.type&&!TYPES.includes(value.type)||value.impact&&!DIRECTIONS.includes(value.impact)||value.status&&!STATUSES.includes(value.status))throw error(400,'Некорректный тип, влияние или статус.');
    for(const key of ['from','to'])if(value[key]&&!iso(value[key]))throw error(400,'Некорректная дата фильтра.');if(value.from&&value.to&&Date.parse(value.from)>Date.parse(value.to))throw error(400,'Проверьте период событий.');
    if(value.company&&!id(value.company)||value.ticker&&!/^[A-Za-z0-9_.-]{1,30}$/.test(value.ticker)||value.watchlist&&!['0','1'].includes(value.watchlist))throw error(400,'Некорректный инструмент.');
    if(value.category&&!['all','important','stocks','bonds','dividends','earnings','credit','ma'].includes(value.category))throw error(400,'Неизвестная категория.');
    return {...value,importance,limit,q:(value.q||value.search||'').toLocaleLowerCase('ru-RU')};
  }
  function filterEvent(event,query){
    if(event.importanceScore<query.importance||query.ticker&&event.ticker.toUpperCase()!==query.ticker.toUpperCase()||query.company&&event.companyId!==query.company||query.type&&event.eventType!==query.type||query.impact&&event.impact!==query.impact||query.status&&event.status!==query.status)return false;
    if(query.from&&Date.parse(event.publishedAt)<Date.parse(query.from)||query.to&&Date.parse(event.publishedAt)>Date.parse(query.to))return false;
    if(query.q&&!([event.ticker,event.companyName,event.isin,event.eventType,event.headline,event.summary,...event.tags].join(' ').toLocaleLowerCase('ru-RU').includes(query.q)))return false;
    const groups={stocks:event.assetType==='stock',bonds:event.assetType==='bond',dividends:event.eventType==='DIVIDEND'||event.tags.includes('dividend'),earnings:['EARNINGS','GUIDANCE'].includes(event.eventType),credit:['CREDIT_RATING','DEFAULT','TECHNICAL_DEFAULT','BANKRUPTCY','DEBT'].includes(event.eventType),ma:event.eventType==='M_AND_A',important:event.importanceScore>=9};
    return !query.category||query.category==='all'||groups[query.category]===true;
  }
  function encodeCursor(offset,signature){const payload=Buffer.from(JSON.stringify({offset,signature})).toString('base64url');return payload+'.'+createHmac('sha256',cursorSecret).update(payload).digest('base64url');}
  function decodeCursor(value,signature){
    if(!value)return 0;if(typeof value!=='string'||value.length>500||!value.includes('.'))throw error(400,'Некорректный курсор Radar.');
    try{const [payload,mac,...extra]=value.split('.'),expected=createHmac('sha256',cursorSecret).update(payload).digest();const actual=Buffer.from(mac,'base64url');if(extra.length||actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error();const decoded=JSON.parse(Buffer.from(payload,'base64url'));if(decoded.signature!==signature||!Number.isSafeInteger(decoded.offset)||decoded.offset<0||decoded.offset>MAX_EVENTS)throw Error();return decoded.offset;}catch{throw error(400,'Курсор устарел или не соответствует фильтрам.');}
  }
  async function feed(user,params,{admin=false,ticker=null,important=false}={}){
    if(admin)requireAdmin(user);else requireAccess(user);await queue;const db=await load(),free=!admin&&!full(user),query=parsedQuery(params,{admin,free});if(free&&important)throw error(403,'Важные события доступны по подписке.','SUBSCRIPTION_REQUIRED');if(ticker)query.ticker=ticker;if(important)query.importance=Math.max(query.importance,9);
    const subscriptions=db.subscriptions.filter(subscription=>subscription.userId===user.id&&subscription.enabled&&subscription.companyId),following=new Set(subscriptions.map(subscription=>subscription.companyId));
    // Reuse the trusted idea watchlist/positions, filtered through current idea
    // permissions. Knowing an old or foreign idea id never grants its ticker.
    if(full(user)&&ideas?.list&&accounts.readDatabase){const owner=(await accounts.readDatabase()).users.find(owner=>owner.id===user.id),tracked=new Set([...(owner?.watchlist||[]),...(owner?.positions||[]).map(position=>position.ideaId)]);if(tracked.size){let records=[];try{records=(await ideas.list(user)).records||[];}catch(cause){if(![401,403].includes(cause.status))throw cause;}const tickers=new Set(records.filter(record=>tracked.has(record.id)).map(record=>String(record.d.ticker).toUpperCase()));for(const company of db.companies)if(company.active&&tickers.has(company.ticker.toUpperCase()))following.add(company.id);}}
    let events=db.events.filter(event=>admin||eligible(db,event));
    events.sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt)||b.id.localeCompare(a.id));
    if(free){events=events.filter(event=>Math.max(...['publishedAt','detectedAt','processedAt','firstPublishedAt','lastPublishedAt','updatedAt'].map(key=>Date.parse(event[key]||event.processedAt)))<=now()-config.freeDelaySeconds*1000).slice(0,config.freeLimit);}
    events=events.filter(event=>filterEvent(event,query));if(query.watchlist==='1')events.sort((a,b)=>Number(following.has(b.companyId))-Number(following.has(a.companyId)));
    const signature=createHash('sha256').update(JSON.stringify({...query,cursor:undefined,user:user.id,admin,free})).digest('hex'),offset=decodeCursor(query.cursor,signature),limit=free?Math.min(query.limit,config.freeLimit):query.limit;
    const rows=events.slice(offset,offset+limit),nextCursor=!free&&offset+limit<events.length?encodeCursor(offset+limit,signature):null;
    return {events:rows.map(event=>admin?clone(event):{...publicEvent(event,{free}),following:following.has(event.companyId)}),nextCursor,revision:db.revision,...(admin?{companies:clone(db.companies),providers:safeProviders(db),errors:clone(db.processingErrors)}:{})};
  }
  async function detail(user,eventId){requireAccess(user,{paid:true});await queue;const db=await load(),event=db.events.find(event=>event.id===eventId);if(!event||!eligible(db,event))throw error(404,'Событие Radar не найдено.');return {event:publicEvent(event,{detail:true})};}
  async function adminCreate(user,payload){
    requireAdmin(user);only(payload,['companyId','eventType','headline','summary','whyImportant','impact','importanceScore','source','publishedAt','status']);
    if(!id(payload.companyId)||!TYPES.includes(payload.eventType)||!DIRECTIONS.includes(payload.impact)||!iso(payload.publishedAt)||!['draft','published'].includes(payload.status||'draft'))throw error(400,'Проверьте компанию, категорию, влияние и время.');
    const headline=requiredText(payload.headline,300,'Заголовок'),summary=requiredText(payload.summary,4000,'Описание'),whyImportant=payload.whyImportant?requiredText(payload.whyImportant,4000,'Почему важно'):summary,importanceScore=score(payload.importanceScore);let source;try{source=safeSourceUrl(payload.source);}catch{throw error(400,'Добавьте безопасную HTTPS-ссылку на источник.');}if(Date.parse(payload.publishedAt)>now()+300000)throw error(400,'Публикация не может находиться в будущем.');
    return transact(db=>{
      if(db.events.length>=MAX_EVENTS)throw error(409,'Хранилище Radar заполнено. История не удаляется автоматически.');const company=db.companies.find(company=>company.id===payload.companyId&&company.active);if(!company)throw error(400,'Компания не найдена или отключена.');
      const at=stamp(),status=payload.status||'draft',event={id:'radar-'+randomUUID(),companyId:company.id,ticker:company.ticker,companyName:company.shortName||company.name,assetType:company.assetType||'stock',isin:company.isin||null,eventType:payload.eventType,headline,summary,whyImportant,impact:payload.impact,importanceScore,confidence:1,publishedAt:new Date(payload.publishedAt).toISOString(),detectedAt:at,processedAt:at,notificationSentAt:null,status,rawText:summary,extractedData:{},tags:[],sources:[{id:'source-'+randomUUID(),provider:'manual',externalId:randomUUID(),url:source,publishedAt:new Date(payload.publishedAt).toISOString(),rawTitle:headline,sourceType:'OTHER'}],marketReaction:null,actualValue:null,expectedValue:null,previousValue:null,surprisePercent:null,isDemo:false,analysisMethod:'manual',trace:[{stage:'manual-created',at}],createdAt:at,updatedAt:at,revision:1,groupId:null,firstPublishedAt:status==='published'?at:null,lastPublishedAt:status==='published'?at:null,originalAnalysis:null,audit:[{action:'created',at,by:user.id}]};db.events.push(event);return {event};
    });
  }
  function audit(event,entry){if(event.audit.length>=MAX_AUDIT||event.trace.length>=MAX_AUDIT)throw error(409,'Достигнут предел истории события. История сохранена.');event.audit.push(entry);event.trace.push({stage:entry.action,at:entry.at});event.updatedAt=entry.at;event.revision++;}
  async function adminPatch(user,eventId,payload,{remove=false}={}){
    requireAdmin(user);only(payload,remove?['revision']:['revision','headline','summary','whyImportant','importanceScore','impact','eventType','status','aiIncorrect']);if(!Number.isSafeInteger(payload.revision)||payload.revision<1)throw error(400,'Укажите ревизию события.');
    const fields={};for(const key of ['headline','summary','whyImportant'])if(Object.hasOwn(payload,key))fields[key]=requiredText(payload[key],key==='headline'?300:4000,key);
    if(Object.hasOwn(payload,'importanceScore'))fields.importanceScore=score(payload.importanceScore);
    for(const [key,values]of [['impact',DIRECTIONS],['eventType',TYPES],['status',['draft','published','hidden']]])if(Object.hasOwn(payload,key)){if(!values.includes(payload[key]))throw error(400,'Недопустимое значение '+key+'.');fields[key]=payload[key];}
    if(Object.hasOwn(payload,'aiIncorrect')){if(typeof payload.aiIncorrect!=='boolean')throw error(400,'Недопустимая отметка AI.');fields.aiIncorrect=payload.aiIncorrect;}
    if(remove)fields.status='duplicate';if(!Object.keys(fields).length)throw error(400,'Укажите изменения события.');
    return transact(db=>{const event=db.events.find(event=>event.id===eventId);if(!event)throw error(404,'Событие не найдено.');if(event.revision!==payload.revision)throw error(409,'Событие изменилось в другой вкладке. Сохраните свой текст и обновите данные.');if(fields.status==='published'&&!activeCompany(db,event))throw error(400,'Для публикации требуется активная компания.');const before=Object.fromEntries(Object.keys(fields).map(key=>[key,event[key]??null])),at=stamp();if(fields.status==='published'&&event.status!=='published'){event.firstPublishedAt??=at;event.lastPublishedAt=at;}Object.assign(event,fields);audit(event,{action:remove?'marked-duplicate':'edited',at,by:user.id,before,after:clone(fields)});return {event};});
  }
  async function merge(user,eventId,payload){
    requireAdmin(user);only(payload,['revision','targetId','targetRevision']);if(!id(payload.targetId)||payload.targetId===eventId||![payload.revision,payload.targetRevision].every(value=>Number.isSafeInteger(value)&&value>=1))throw error(400,'Проверьте события и их ревизии.');
    return transact(db=>{const event=db.events.find(item=>item.id===eventId),target=db.events.find(item=>item.id===payload.targetId);if(!event||!target)throw error(404,'Событие не найдено.');if(event.revision!==payload.revision||target.revision!==payload.targetRevision)throw error(409,'События изменились. Обновите данные.');if(event.companyId!==target.companyId||event.companyId===null||target.status==='duplicate')throw error(400,'Объединить можно события одной определённой компании с действующим целевым событием.');const unique=target.sources.slice();for(const source of event.sources)if(!unique.some(item=>item.provider===source.provider&&item.externalId===source.externalId))unique.push(source);if(unique.length>64)throw error(409,'Слишком много источников для одного события.');const at=stamp();audit(event,{action:'merged-into',targetId:target.id,at,by:user.id});audit(target,{action:'merged-from',sourceId:event.id,at,by:user.id});event.status='duplicate';event.mergedInto=target.id;target.sources=unique;return {event:target,mergedEventId:event.id};});
  }
  async function subscriptions(user){requireAccess(user,{paid:true});await queue;const db=await load();return {subscriptions:clone(db.subscriptions.filter(subscription=>subscription.userId===user.id)).map(({userId,...subscription})=>subscription)};}
  async function addSubscription(user,payload){
    requireAccess(user,{paid:true});only(payload,['companyId','eventType','minimumImportance','enabled']);const companyId=payload.companyId??null,eventType=payload.eventType??null,minimumImportance=payload.minimumImportance??9,enabled=payload.enabled??true;
    if(companyId!==null&&!id(companyId)||eventType!==null&&!TYPES.includes(eventType)||typeof enabled!=='boolean'||typeof minimumImportance!=='number'||!Number.isFinite(minimumImportance)||minimumImportance<6||minimumImportance>10)throw error(400,'Проверьте настройки уведомлений.');
    await transact(db=>{if(companyId!==null&&!db.companies.some(company=>company.id===companyId&&company.active))throw error(400,'Компания не найдена.');let subscription=db.subscriptions.find(item=>item.userId===user.id&&item.companyId===companyId&&item.eventType===eventType);const at=stamp();if(subscription){const changed=!subscription.enabled&&enabled||subscription.minimumImportance!==minimumImportance;subscription.minimumImportance=minimumImportance;subscription.enabled=enabled;subscription.updatedAt=at;if(changed)subscription.createdAt=at;}else{if(db.subscriptions.length>=MAX_SUBSCRIPTIONS||db.subscriptions.filter(item=>item.userId===user.id).length>=100)throw error(409,'Достигнут предел подписок на события.');db.subscriptions.push({id:'radarsub-'+randomUUID(),userId:user.id,companyId,eventType,minimumImportance,enabled,createdAt:at,updatedAt:at});}return {};});return subscriptions(user);
  }
  async function removeSubscription(user,subscriptionId){requireAccess(user,{paid:true});await transact(db=>{const index=db.subscriptions.findIndex(item=>item.id===subscriptionId&&item.userId===user.id);if(index<0)throw error(404,'Подписка на события не найдена.');db.subscriptions.splice(index,1);return {};});return subscriptions(user);}
  function matchesNotification(subscription,event,since){return subscription.enabled&&event.importanceScore>=Math.max(6,subscription.minimumImportance)&&(!subscription.companyId||subscription.companyId===event.companyId)&&(!subscription.eventType||subscription.eventType===event.eventType)&&Date.parse(event.firstPublishedAt||event.processedAt)>=Math.max(Date.parse(subscription.createdAt),since||0);}
  async function notificationsFor(user,{since=0}={}){if(!full(user)||!config.notificationsEnabled)return [];await queue;const db=await load(),owned=db.subscriptions.filter(subscription=>subscription.userId===user.id);return db.events.filter(event=>eligible(db,event)&&owned.some(subscription=>matchesNotification(subscription,event,typeof since==='string'?Date.parse(since):since))).map(event=>publicEvent(event,{detail:true})).map(({rawText,...event})=>event);}
  async function getForNotification(user,eventId){return (await notificationsFor(user)).find(event=>event.id===eventId)||null;}
  async function markNotificationSent(eventId,at=stamp()){if(!iso(at))throw error(400,'Некорректное время уведомления.');return transact(db=>{const event=db.events.find(event=>event.id===eventId);if(event&&!event.notificationSentAt){if(event.trace.length>=MAX_AUDIT)throw error(409,'Достигнут предел истории события.');event.notificationSentAt=at;event.trace.push({stage:'notification_sent',at});}return {};});}
  async function ingestBatch(rawEvents,{provider='unknown',demo=false,signal}={}){
    if(!Array.isArray(rawEvents)||rawEvents.length>100)throw error(400,'Слишком большой пакет Radar.');const processed=[],failures=[];const db=await load();
    for(const raw of rawEvents){signal?.throwIfAborted();try{const event=await pipeline.process({...raw,detectedAt:stamp()},{companies:db.companies,signal});signal?.throwIfAborted();if(demo&&!event.isDemo)event.isDemo=true;processed.push(event);}catch(cause){if(signal?.aborted)throw cause;failures.push({provider,at:stamp(),code:typeof cause?.code==='string'&&/^[A-Z][A-Z0-9_]{1,63}$/.test(cause.code)?cause.code:'NORMALIZATION_FAILED'});}}
    return transact(database=>{signal?.throwIfAborted();let inserted=0,duplicates=0;const delays=[];
      if(database.processingErrors.length+failures.length>500)throw error(409,'Журнал ошибок Radar заполнен; история не удаляется.');database.processingErrors.push(...failures);
      for(const item of processed){
        const existing=deduplicateEvent(item,database.events);
        if(existing){
          let target=existing;const seen=new Set();
          while(target.status==='duplicate'&&target.mergedInto&&!seen.has(target.id)){seen.add(target.id);const next=database.events.find(event=>event.id===target.mergedInto);if(!next)break;target=next;}
          // A stand-alone tombstone suppresses re-import without changing its
          // audit. A merged source follows its surviving event, even after a
          // later merge, and never reappears as a new published record.
          if(target.status!=='duplicate'){const unique=target.sources.slice();for(const source of item.sources)if(!unique.some(value=>value.provider===source.provider&&value.externalId===source.externalId))unique.push(source);if(unique.length>64)throw error(409,'Достигнут предел источников события.');if(unique.length!==target.sources.length){target.sources=unique;audit(target,{action:'source-added',at:stamp(),by:'radar-pipeline'});}}
          duplicates++;continue;
        }
        if(database.events.length>=MAX_EVENTS)throw error(409,'Хранилище Radar заполнено. История сохранена.');const at=stamp(),event={...item,audit:[],firstPublishedAt:item.status==='published'?at:null,lastPublishedAt:item.status==='published'?at:null,originalAnalysis:{eventType:item.eventType,importanceScore:item.importanceScore,impact:item.impact,confidence:item.confidence,headline:item.headline,summary:item.summary,whyImportant:item.whyImportant,analysisMethod:item.analysisMethod}};
        if(!config.marketReactionEnabled)event.marketReaction=null;database.events.push(event);inserted++;delays.push(Math.max(0,Date.parse(event.detectedAt)-Date.parse(event.publishedAt)));
      }
      return {inserted,duplicates,failed:failures.length,delays};
    });
  }
  const jobs=createRadarJobs({providers,now,initialStates:(await load()).providerStates,onEvents:ingestBatch,onState:state=>transact(db=>{db.providerStates[state.id]=state;return {};})});
  async function seedDemo(){
    const db=await load();if(db.events.some(event=>!event.isDemo))throw error(409,'Демонстрационные события нельзя добавлять в базу с рабочими публикациями.');
    const mock=createMockProvider({now}),batch=await mock.fetchEvents({cursor:null});return ingestBatch(batch.events,{provider:'mock',demo:true});
  }
  async function stream(req,res,user){
    requireAccess(user,{paid:true});const count=pendingStreamCounts.get(user.id)||0;if(count>=2||streams.size>=16)throw error(429,'Слишком много подключений Radar.');pendingStreamCounts.set(user.id,count+1);
    let timer,lifetime,checking=false,ended=false;const entry={res,userId:user.id,end:()=>{if(ended)return;ended=true;clearInterval(timer);clearTimeout(lifetime);streams.delete(entry);pendingStreamCounts.set(user.id,Math.max(0,(pendingStreamCounts.get(user.id)||1)-1));if(!pendingStreamCounts.get(user.id))pendingStreamCounts.delete(user.id);req.removeListener('close',entry.end);res.removeListener('close',entry.end);res.end();}};streams.add(entry);let lastRevision=-1;
    try{
      const latest=await accounts.identify(req);if(!full(latest))throw error(403,'Доступ к Radar завершён.');res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no','Vary':'Cookie'});res.flushHeaders?.();
      async function check(){if(checking||ended)return;checking=true;try{const current=await accounts.identify(req);if(closed||!full(current)){entry.end();return;}const db=await load();if(db.revision!==lastRevision){const kind=lastRevision<0?'ready':'radar-update';lastRevision=db.revision;if(!res.write('event: '+kind+'\ndata: '+JSON.stringify({revision:db.revision})+'\n\n'))entry.end();}else if(!res.write(': heartbeat\n\n'))entry.end();}catch{entry.end();}finally{checking=false;}}
      await check();if(ended)return;timer=setInterval(()=>{void check();},streamHeartbeatMs);timer.unref?.();lifetime=setTimeout(entry.end,streamLifetimeMs);lifetime.unref?.();req.once('close',entry.end);res.once('close',entry.end);
    }catch(cause){entry.end();if(!res.headersSent)throw cause;}
  }
  async function handle(req,res,url,user){
    const route=url.pathname;if(!route.startsWith('/api/radar')&&!route.startsWith('/api/admin/radar'))return false;
    if(!/^\/api\/(?:admin\/)?radar(?:\/|$)/.test(route))return false;
    try{
      if(!['GET','HEAD','OPTIONS'].includes(req.method))accounts.checkRequest(req);
      if(route==='/api/radar/config'&&req.method==='GET'){if(!user)throw error(401,'Войдите в аккаунт.');json(res,200,{enabled:config.enabled,mode:config.mode,aiEnabled:config.aiEnabled,notificationsEnabled:config.notificationsEnabled,marketReactionEnabled:config.marketReactionEnabled,access:{tier:full(user)?'pro':canAccess(user)?'free':'locked',realtime:full(user)},freeDelaySeconds:config.freeDelaySeconds,allowedPlans:config.allowedPlans});return true;}
      if(route.startsWith('/api/admin/radar')){
        requireAdmin(user);
        if(route==='/api/admin/radar'&&req.method==='GET'){json(res,200,await feed(user,url.searchParams,{admin:true}));return true;}
        if(route==='/api/admin/radar'&&req.method==='POST'){json(res,201,await adminCreate(user,await readJson(req)));return true;}
        if(route==='/api/admin/radar/sync'&&req.method==='POST'){only(await readJson(req),[]);if(!config.enabled||config.mode==='off')throw error(409,'Источники Radar отключены. Выберите режим на сервере.');await jobs.sync();json(res,200,{providers:safeProviders(await load())});return true;}
        const match=route.match(/^\/api\/admin\/radar\/([A-Za-z0-9_-]{1,100})(\/merge)?$/);
        if(match&&match[2]&&req.method==='POST'){json(res,200,await merge(user,match[1],await readJson(req)));return true;}
        if(match&&!match[2]&&['PATCH','DELETE'].includes(req.method)){json(res,200,await adminPatch(user,match[1],await readJson(req),{remove:req.method==='DELETE'}));return true;}
        throw error(405,'Метод Radar не поддерживается.');
      }
      requireAccess(user);
      if(route==='/api/radar/stream'&&req.method==='GET'){await stream(req,res,user);return true;}
      if(route==='/api/radar/companies'&&req.method==='GET'){await queue;json(res,200,{companies:clone((await load()).companies.filter(company=>company.active))});return true;}
      if(route==='/api/radar/subscriptions'&&req.method==='GET'){json(res,200,await subscriptions(user));return true;}
      if(route==='/api/radar/subscriptions'&&req.method==='POST'){json(res,201,await addSubscription(user,await readJson(req)));return true;}
      const subscription=route.match(/^\/api\/radar\/subscriptions\/([A-Za-z0-9_-]{1,100})$/);if(subscription&&req.method==='DELETE'){json(res,200,await removeSubscription(user,subscription[1]));return true;}
      if(route==='/api/radar'&&req.method==='GET'){json(res,200,await feed(user,url.searchParams));return true;}
      if(route==='/api/radar/important'&&req.method==='GET'){json(res,200,await feed(user,url.searchParams,{important:true}));return true;}
      const company=route.match(/^\/api\/radar\/company\/([A-Za-z0-9_.-]{1,30})$/);if(company&&req.method==='GET'){json(res,200,await feed(user,url.searchParams,{ticker:company[1]}));return true;}
      const event=route.match(/^\/api\/radar\/([A-Za-z0-9_-]{1,100})$/);if(event&&req.method==='GET'){json(res,200,await detail(user,event[1]));return true;}
      throw error(405,'Метод Radar не поддерживается.');
    }catch(cause){if(res.headersSent){res.end();return true;}if(cause.status)json(res,cause.status,{error:cause.message,...(cause.code?{code:cause.code}:{})});else safeFailure(res,cause,{scope:'radar',route});}return true;
  }
  return {handle,config,canAccess,canRealtime,webhookPaths:[],seedDemo,ingestBatch,notificationsFor,getForNotification,markNotificationSent,readDatabase:async()=>{await queue;return clone(await load());},start:async()=>{if(config.enabled)await jobs.start();},close:async()=>{closed=true;for(const stream of streams)stream.end();await jobs.close();await queue;}};
}
