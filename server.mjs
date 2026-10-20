import http from 'node:http';
import {readFile,realpath,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createAccounts} from './lib/accounts.mjs';
import {createIdeas} from './lib/ideas.mjs';
import {createNews} from './lib/news.mjs';
import {LEGAL_VERSION,PLANS,activePlans,hasSubscription,isAdmin,requireAdmin,requireMember} from './lib/access.mjs';
import {json,readJson,error} from './lib/http.mjs';
const root=await realpath(fileURLToPath(new URL('./public/',import.meta.url)));
const configuredDirectory=process.env.ORBITA_DATA_DIR||fileURLToPath(new URL('./data/',import.meta.url));
await mkdir(configuredDirectory,{recursive:true,mode:0o700});
const directory=await realpath(configuredDirectory);
if(directory===root||directory.startsWith(root+path.sep))throw Error('ORBITA_DATA_DIR должен находиться вне публичной папки public.');
const accounts=await createAccounts(directory),ideas=await createIdeas(directory),news=createNews(directory);
const lessons=JSON.parse(await readFile(new URL('./fixtures/lessons.json',import.meta.url),'utf8'));
const port=Number(process.env.PORT||3000),host=process.env.HOST||'127.0.0.1';
if(!Number.isInteger(port)||port<0||port>65535)throw Error('PORT должен быть числом от 0 до 65535.');
const types={'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
const memberPages=new Set(['/app.html','/calculator.html','/learn.html']);
const adminPages=new Set(['/admin.html']);
const paidAssets=new Set(['/assets/app.js','/assets/calculator.js','/assets/learning-data.js','/assets/learning.js','/assets/news.js','/assets/personal.js']);
const adminAssets=new Set(['/assets/admin.js']);
const removedAssets=new Set(['/assets/editor-seed.js']);
function redirect(res,destination){res.writeHead(303,{Location:destination,'Cache-Control':'no-store','Vary':'Cookie'});res.end();}
const server=http.createServer(async(req,res)=>{
 try{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
  if(!req.url?.startsWith('/')||req.url.startsWith('//'))throw error(400,'Некорректный путь.');
  const url=new URL(req.url,'http://localhost');
  let pathname;try{pathname=decodeURIComponent(url.pathname);}catch{throw error(400,'Некорректный адрес.');}
  if(pathname.includes('\\')||pathname.includes('\0'))throw error(400,'Некорректный путь.');
  // Authorize the normalized filesystem target, not an encoded URL alias.
  const target=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
  if(!target.startsWith(root+path.sep))throw error(403,'Доступ запрещён.');
  const canonical='/'+path.relative(root,target).split(path.sep).join('/');
  if(pathname.startsWith('/api/')){
   accounts.checkRequest(req);
   if(await accounts.handle(req,res,url))return;
   const user=await accounts.identify(req);
   if(url.pathname==='/api/public-config'&&req.method==='GET'){json(res,200,{legalVersion:LEGAL_VERSION,plans:PLANS,paymentsAvailable:false,supportEmail:process.env.ORBITA_SUPPORT_EMAIL||null});return;}
   if(url.pathname==='/api/ideas'&&req.method==='GET'){json(res,200,await ideas.list(user));return;}
   const single=url.pathname.match(/^\/api\/ideas\/([a-zA-Z0-9_-]+)$/);
   if(single&&req.method==='GET'){json(res,200,{record:await ideas.get(single[1],user)});return;}
   if(url.pathname==='/api/lessons'&&req.method==='GET'){requireMember(user);const exclusive=isAdmin(user)||activePlans(user).includes('exclusive');json(res,200,{lessons:lessons.filter(l=>exclusive||!l.id.startsWith('exclusive-'))});return;}
   if(url.pathname==='/api/news'){requireMember(user);if(await news(req,res,url))return;}
   if(url.pathname==='/api/admin/ideas'){
    requireAdmin(user);if(req.method==='GET'){json(res,200,await ideas.list(user));return;}if(req.method==='POST'){json(res,201,await ideas.create(user,await readJson(req)));return;}
   }
   const adminIdea=url.pathname.match(/^\/api\/admin\/ideas\/([a-zA-Z0-9_-]+)(\/events)?$/);
   if(adminIdea){requireAdmin(user);if(adminIdea[2]&&req.method==='POST'){json(res,200,await ideas.update(user,adminIdea[1],await readJson(req)));return;}if(!adminIdea[2]&&req.method==='PUT'){json(res,200,await ideas.update(user,adminIdea[1],await readJson(req)));return;}if(!adminIdea[2]&&req.method==='DELETE'){json(res,200,await ideas.remove(user,adminIdea[1]));return;}}
   throw error(404,'Неизвестный запрос.');
  }
  accounts.checkRequest(req);
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{Allow:'GET, HEAD'}).end();return;}
  if(removedAssets.has(canonical))throw error(404,'Файл не найден.');
  const protectedPage=memberPages.has(canonical)||adminPages.has(canonical)||canonical==='/subscriptions.html';
  const protectedAsset=paidAssets.has(canonical)||adminAssets.has(canonical);
  if(protectedPage||protectedAsset){
   const user=await accounts.identify(req);
   if(!user){if(protectedAsset)throw error(401,'Войдите в аккаунт.');redirect(res,'/account.html?next='+encodeURIComponent(canonical+url.search));return;}
   if(adminPages.has(canonical)||adminAssets.has(canonical)){if(!isAdmin(user)){if(protectedAsset)throw error(403,'Доступ только для администратора.');redirect(res,'/subscriptions.html?error=admin');return;}}
   else if(canonical!=='/subscriptions.html'&&!hasSubscription(user)){if(protectedAsset)throw error(403,'Для доступа нужна действующая подписка.');redirect(res,'/subscriptions.html?next='+encodeURIComponent(canonical+url.search));return;}
  }
  const real=await realpath(target).catch(e=>{if(e.code==='ENOENT'||e.code==='ENOTDIR')throw error(404,'Файл не найден.');throw e;});
  if(!real.startsWith(root+path.sep)||real!==target)throw error(403,'Доступ запрещён.');
  const bytes=await readFile(real);res.writeHead(200,{'Content-Type':(types[path.extname(real)]||'application/octet-stream')+'; charset=utf-8','Cache-Control':'no-store','Vary':'Cookie'});res.end(req.method==='HEAD'?undefined:bytes);
 }catch(e){if(!res.headersSent)json(res,e.status||500,{error:e.status?e.message:'Не удалось обработать запрос.'});else res.end();}
});
server.on('error',e=>{console.error(e.code==='EADDRINUSE'?`Port ${port} is busy. Stop the other server or set PORT.`:e.message);process.exitCode=1;});
server.listen(port,host,()=>console.log(`ORBITA: ${process.env.ORBITA_PUBLIC_ORIGIN||'http://'+host+':'+server.address().port}`));
