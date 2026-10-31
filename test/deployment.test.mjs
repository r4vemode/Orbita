import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {LEGAL_VERSION} from '../lib/access.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
const systemEnvironment=()=>Object.fromEntries(['PATH','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','TMPDIR'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
function docker(args){return new Promise(resolve=>{let stdout='',stderr='';const child=spawn('docker',args,{cwd:project,env:systemEnvironment(),stdio:['ignore','pipe','pipe']});const timer=setTimeout(()=>{child.kill('SIGKILL');resolve({code:null,stdout:'',stderr:'Docker command timed out'});},10000);child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',()=>{clearTimeout(timer);resolve(null);});child.once('exit',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});});}
function command(args,env,{timeoutMs=15000}={}){return new Promise((resolve,reject)=>{let stdout='',stderr='';const child=spawn(process.execPath,args,{cwd:project,env,stdio:['ignore','pipe','pipe']});const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Isolated deployment command timed out'));},timeoutMs);child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',cause=>{clearTimeout(timer);reject(cause);});child.once('exit',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});});}

test('HTTPS bootstrap starts with sales disabled, then requires MFA after the first owner is promoted',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'orbita-deployment-bootstrap-')),origin='https://deployment.example.test';
 const env={...systemEnvironment(),HOST:'127.0.0.1',PORT:'0',ORBITA_DATA_DIR:directory,ORBITA_PUBLIC_ORIGIN:origin,ORBITA_REQUIRE_ADMIN_MFA:'true',ORBITA_TRUSTED_PROXY_IPS:'127.0.0.1',ORBITA_LIVE_PAYMENTS_ENABLED:'false',ORBITA_RECEIPTS_CONFIRMED:'false',RADAR_PROVIDER_MODE:'off',MOEX_POSITIONS_MODE:'off'};
 const instrument="import http from 'node:http';const create=http.createServer;http.createServer=(...args)=>{const server=create(...args);server.once('listening',()=>process.stdout.write('ISOLATED_PORT:'+server.address().port+'\\n'));return server;};await import('./server.mjs');";
 const child=spawn(process.execPath,['--input-type=module','-e',instrument],{cwd:project,env,stdio:['ignore','pipe','pipe']});let tail='',base;
 const exited=new Promise(resolve=>{child.once('exit',resolve);child.once('error',()=>resolve(null));});
 try{
  base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('HTTPS bootstrap did not start')),10000);child.stdout.on('data',chunk=>{tail=(tail+chunk).slice(-2048);const match=tail.match(/ISOLATED_PORT:(\d+)/);if(match){clearTimeout(timer);resolve('http://127.0.0.1:'+match[1]);}});child.stderr.on('data',()=>{});child.once('error',cause=>{clearTimeout(timer);reject(cause);});child.once('exit',()=>{clearTimeout(timer);reject(Error('HTTPS bootstrap exited before readiness'));});});
  const request=async(route,{method='GET',body,cookie}={})=>fetch(base+route,{method,redirect:'manual',headers:{Host:'deployment.example.test',Origin:origin,...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});
  assert.equal((await request('/healthz')).status,200);assert.equal((await request('/readyz')).status,200);
  const config=await(await request('/api/public-config')).json();assert.equal(config.paymentsAvailable,false);assert.equal(config.mailEnabled,false);assert.equal(config.telegramEnabled,false);
  const email='deployment-owner@example.test',password='isolated-deployment-password-2026',response=await request('/api/register',{method:'POST',body:{email,password,acceptTerms:true,acceptPrivacy:true,legalVersion:LEGAL_VERSION}});assert.equal(response.status,200);
  const cookieHeader=response.headers.get('set-cookie');assert.match(cookieHeader,/; Secure/i);assert.match(cookieHeader,/HttpOnly/i);const cookie=cookieHeader.split(';')[0];
  const promotion=await command(['scripts/manage-access.mjs','admin',email],env);assert.equal(promotion.code,0,promotion.stderr);
  const me=await(await request('/api/me',{cookie})).json();assert.equal(me.user.security.adminEnrollmentRequired,true);assert.equal(me.user.access.isAdmin,false);assert.equal((await request('/admin.html',{cookie})).status,303);assert.equal((await request('/api/admin/support',{cookie})).status,403);assert.equal((await request('/security.html',{cookie})).status,200);
  const preflight=await command(['scripts/preflight.mjs','--production'],env);assert.equal(preflight.code,1);assert.match(preflight.stdout,/CLOUDPAYMENTS|RESEND_MAIL/);assert.match(preflight.stdout,/LEGAL_DOCUMENTS/);assert.ok(!preflight.stdout.includes(password));assert.ok(!preflight.stdout.includes(email));
 }finally{
  if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');let timer;await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},6000);})]);clearTimeout(timer);await exited;}
  await rm(directory,{recursive:true,force:true});
 }
});

test('rendered deployment keeps the application private, uses one exact trusted proxy and leaves live sales off',async t=>{
 const version=await docker(['compose','version']);if(!version||version.code!==0){t.skip('Docker Compose is optional for ordinary Node.js development.');return;}
 const directory=await mkdtemp(path.join(tmpdir(),'orbita-compose-config-'));
 try{
  await writeFile(path.join(directory,'compose.yaml'),await readFile(path.join(project,'deploy/compose.yaml')));
  const example=await readFile(path.join(project,'deploy/.env.example'),'utf8'),fixture=example.replace(/^ORBITA_DOMAIN=.*$/m,'ORBITA_DOMAIN=deployment.example.test').replace(/^ORBITA_BACKUP_PASSPHRASE=.*$/m,'ORBITA_BACKUP_PASSPHRASE=isolated-backup-passphrase-2026');await writeFile(path.join(directory,'.env'),fixture,{mode:0o600});
  const result=await docker(['compose','--env-file',path.join(directory,'.env'),'-f',path.join(directory,'compose.yaml'),'config','--format','json']);assert.equal(result?.code,0,result?.stderr);const config=JSON.parse(result.stdout),app=config.services.app,caddy=config.services.caddy;
  assert.equal(app.ports?.length||0,0);assert.notEqual(app.network_mode,'host');assert.notEqual(app.privileged,true);assert.equal(app.read_only,true);assert.ok(app.cap_drop.includes('ALL'));assert.ok(app.security_opt.includes('no-new-privileges:true'));assert.ok(!app.cap_add?.length);assert.ok(app.init);
  const env=app.environment;assert.equal(env.HOST,'0.0.0.0');assert.equal(env.PORT,'3000');assert.equal(env.ORBITA_PUBLIC_ORIGIN,'https://deployment.example.test');assert.equal(env.ORBITA_REQUIRE_ADMIN_MFA,'true');assert.equal(env.ORBITA_LIVE_PAYMENTS_ENABLED,'false');assert.equal(env.ORBITA_RECEIPTS_CONFIRMED,'false');assert.equal(env.CLOUDPAYMENTS_TEST_MODE,'false');assert.equal(env.RADAR_PROVIDER_MODE,'off');assert.equal(env.MOEX_POSITIONS_MODE,'off');
  const proxyIps=Object.values(caddy.networks).map(network=>network.ipv4_address).filter(Boolean);assert.deepEqual(env.ORBITA_TRUSTED_PROXY_IPS.split(','),proxyIps);assert.ok(!env.ORBITA_TRUSTED_PROXY_IPS.includes('/'));
  for(const target of [env.ORBITA_DATA_DIR,env.ORBITA_BACKUP_DIR]){assert.ok(target.startsWith('/')&&!target.startsWith('/app/public'));const mount=app.volumes.find(volume=>volume.target===target);assert.equal(mount.type,'bind');assert.notEqual(mount.bind?.create_host_path,true);}assert.notEqual(env.ORBITA_DATA_DIR,env.ORBITA_BACKUP_DIR);
  assert.ok(caddy.ports.length>=2&&caddy.ports.every(port=>[80,443].includes(port.target)));assert.ok(!Object.keys(caddy.environment).some(key=>/SECRET|TOKEN|PASSPHRASE|API_KEY/.test(key)));assert.equal(caddy.environment.ORBITA_DOMAIN,'deployment.example.test');assert.match(caddy.image,/@sha256:[a-f0-9]{64}$/);assert.ok(app.stop_grace_period==='20s'||app.stop_grace_period==='20s0ns');assert.match(JSON.stringify(app.healthcheck.test),/\/readyz/);
  const dockerfile=await readFile(path.join(project,'Dockerfile'),'utf8');assert.match(dockerfile,/^ARG NODE_IMAGE=node:24[^\n]+@sha256:[a-f0-9]{64}$/m);assert.match(dockerfile,/^USER node$/m);assert.doesNotMatch(dockerfile,/^COPY[^\n]*(?:admin-download|\.env|data\/|node_modules)/m);assert.match(dockerfile,/CMD \["node", "server\.mjs"\]/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
