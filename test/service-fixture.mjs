import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAccounts} from '../lib/accounts.mjs';
import {createIdeas} from '../lib/ideas.mjs';
import {LEGAL_VERSION} from '../lib/access.mjs';

export async function serviceFixture(build,accountOptions={}){
 const directory=await mkdtemp(join(tmpdir(),'orbita-service-')),emails=[];
 let accounts,service;
 const server=http.createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://'+req.headers.host);
  if(service.webhookPaths.includes(url.pathname))accounts.checkRequest({method:'GET',headers:req.headers});else accounts.checkRequest(req);
  if(await accounts.handle(req,res,url))return;
  if(await service.handle(req,res,url,await accounts.identify(req)))return;
  res.writeHead(404).end();
 }catch(e){res.writeHead(e.status||500,{'Content-Type':'application/json'}).end(JSON.stringify({error:e.message}));}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 accounts=await createAccounts(directory,{publicOrigin:base,mailer:async mail=>{emails.push(mail);return {delivered:true};},...accountOptions});
 const ideas=await createIdeas(directory);service=await build({directory,accounts,ideas});
 async function request(path,{method='GET',body,cookie,headers={}}={}){
  const response=await fetch(base+path,{method,headers:{Origin:base,...(body!==undefined?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...headers},...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
  return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
 }
 async function register(email){return request('/api/register',{method:'POST',body:{email,password:'test-password-long-2026',acceptTerms:true,acceptPrivacy:true,legalVersion:LEGAL_VERSION}});}
 async function verify(account){const email=emails.findLast(mail=>mail.to===account.data.user.email),token=new URL(email.text.match(/https?:\/\/\S+/)[0]).hash.slice(7);return request('/api/security/verify-email',{method:'POST',body:{token}});}
 return {directory,base,accounts,ideas,service,emails,request,register,verify,async close(){await service.close?.();await accounts.flushMail();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}};
}
