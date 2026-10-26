import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAccounts} from '../lib/accounts.mjs';
import {LEGAL_VERSION} from '../lib/access.mjs';

const repository=fileURLToPath(new URL('../',import.meta.url));

async function startServer(directory){
  const child=spawn(process.execPath,['server.mjs'],{
    cwd:repository,
    env:{...process.env,HOST:'127.0.0.1',PORT:'0',ORBITA_DATA_DIR:directory,ORBITA_PUBLIC_ORIGIN:''},
    stdio:['ignore','pipe','pipe']
  });
  let output='';
  const base=await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{child.kill();reject(Error('Server did not become ready. '+output));},10000);
    child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/ORBITA: (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timeout);resolve(match[1]);}});
    child.stderr.on('data',chunk=>{output+=chunk;});
    child.once('error',error=>{clearTimeout(timeout);reject(error);});
    child.once('exit',code=>{clearTimeout(timeout);reject(Error('Server exited with '+code+'. '+output));});
  });
  return {base,close:async()=>{if(child.exitCode!==null)return;await new Promise(resolve=>{child.once('exit',resolve);child.kill();});}};
}

// Use the raw request path so encoded aliases reach the server unchanged.
function request(base,path,{method='GET',body,cookie,origin=base,headers={}}={}){
  return new Promise((resolve,reject)=>{
    const req=http.request(base,{path,method,headers:{Origin:origin,...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{}),...headers}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const text=Buffer.concat(chunks).toString();let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,text,data,cookie:res.headers['set-cookie']?.[0]?.split(';')[0]});});
    });
    req.once('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
}

test('server enforces subscriptions and administrator permissions on direct and encoded requests',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'orbita-access-'));
  let server;
  try{
    server=await startServer(directory);const {base}=server;
    const register=async(email,extra={})=>request(base,'/api/register',{method:'POST',body:{email,password:'test-password-2026',acceptTerms:true,acceptPrivacy:true,legalVersion:LEGAL_VERSION,...extra}});
    const admin=await register('admin@example.test');assert.equal(admin.status,200);
    const administration=await createAccounts(directory,{publicOrigin:''});await administration.promote('admin@example.test');
    const unpaid=await register('unpaid@example.test',{
      role:'admin',subscriptions:[{plan:'exclusive',expiresAt:'2099-01-01T00:00:00Z'}],
      access:{isAdmin:true,hasSubscription:true,activePlans:['pro','exclusive']}
    });
    const pro=await register('pro@example.test'),exclusive=await register('exclusive@example.test');
    assert.equal(pro.status,200);assert.equal(exclusive.status,200);assert.equal(unpaid.status,200);
    const grant=async(account,plan,expiresAt=new Date(Date.now()+86400000).toISOString())=>request(base,'/api/admin/subscriptions',{method:'POST',cookie:admin.cookie,body:{userId:account.data.user.id,plan,expiresAt,reason:'Integration test access grant'}});
    assert.equal((await grant(pro,'pro')).status,200);assert.equal((await grant(exclusive,'exclusive')).status,200);
    const create=async(strategy,ticker)=>request(base,'/api/admin/ideas',{method:'POST',cookie:admin.cookie,body:{mode:'quick',d:{ticker,dir:'ЛОНГ',strategy}}});
    const publicIdea=await create('Momentum RU','PRO_ONLY'),exclusiveIdea=await create('Orbita Exclusive','EXCLUSIVE_ONLY');
    assert.equal(publicIdea.status,201);assert.equal(exclusiveIdea.status,201);
    const proId=publicIdea.data.record.id,exclusiveId=exclusiveIdea.data.record.id;

    await t.test('registration cannot forge privileges and requires current explicit consent',async()=>{
      assert.equal(unpaid.data.user.role,'member');assert.deepEqual(unpaid.data.user.subscriptions,[]);
      assert.equal(unpaid.data.user.access.hasSubscription,false);
      const me=await request(base,'/api/me',{cookie:unpaid.cookie});assert.equal(me.data.user.role,'member');assert.deepEqual(me.data.user.access.activePlans,[]);
      assert.equal((await register('no-consent@example.test',{acceptPrivacy:false})).status,400);
      assert.equal((await register('old-consent@example.test',{legalVersion:'old-version'})).status,400);
      assert.equal((await request(base,'/api/register',{method:'POST',origin:'https://outside.example',body:{email:'csrf@example.test',password:'test-password-2026',acceptTerms:true,acceptPrivacy:true,legalVersion:LEGAL_VERSION}})).status,403);
    });

    await t.test('guest and unpaid accounts cannot use member pages, assets or APIs',async()=>{
      for(const path of ['/app.html','/%61pp.html','/assets/../app.html','/assets/%2e%2e/app.html','/app.html%2f..%2fapp.html','/calculator.html','/learn.html']){
        const guest=await request(base,path);assert.equal(guest.status,303,path);assert.match(guest.headers.location,/^\/account\.html\?/);
        const member=await request(base,path,{cookie:unpaid.cookie});assert.equal(member.status,303,path);assert.match(member.headers.location,/^\/subscriptions\.html\?/);
      }
      assert.equal((await request(base,'/%61pp.html',{method:'HEAD'})).status,303);
      for(const path of ['/assets/app.js','/assets/%61pp.js','/assets//app.js','/assets/signal-visual.js','/assets/learning-data.js','/assets/news.js']){
        assert.equal((await request(base,path)).status,401,path);assert.equal((await request(base,path,{cookie:unpaid.cookie})).status,403,path);
      }
      for(const path of ['/api/ideas','/api/lessons','/api/news','/api/watchlist','/api/positions']){
        assert.equal((await request(base,path)).status,401,path);assert.equal((await request(base,path,{cookie:unpaid.cookie})).status,403,path);
      }
      for(const path of ['/api%2fideas','/%61pi/ideas','/api//ideas','/api/%2e/ideas'])assert.notEqual((await request(base,path,{cookie:unpaid.cookie})).status,200,path);
      assert.equal((await request(base,'/api/ideas',{cookie:unpaid.cookie,headers:{'X-Orbita-Plan':'exclusive','X-Orbita-Role':'admin'}})).status,403);
    });

    await t.test('public pages and metadata reveal no paid records or downloadable seeds',async()=>{
      for(const path of ['/','/strategies.html','/strategy.html?strategy=orbita-exclusive','/guide.html','/assets/guide.css','/assets/guide.js','/offer.html','/privacy.html','/refunds.html'])assert.equal((await request(base,path)).status,200,path);
      for(const path of ['/assets/editor-seed.js','/assets/%65ditor-seed.js','/assets//editor-seed.js','/fixtures/demo-ideas.json','/data/ideas.json','/data/accounts.json'])assert.equal((await request(base,path)).status,404,path);
      const catalog=await request(base,'/assets/strategy-data.js');assert.equal(catalog.status,200);
      assert.ok(!catalog.text.includes(proId)&&!catalog.text.includes(exclusiveId));assert.ok(!catalog.text.includes('exclusive-sber'));
      assert.equal((await request(base,'/assets/app.js',{cookie:pro.cookie})).status,200);
    });

    await t.test('Pro and Exclusive have separate idea and lesson access',async()=>{
      const proRows=await request(base,'/api/ideas',{cookie:pro.cookie});assert.equal(proRows.status,200);assert.deepEqual(proRows.data.records.map(r=>r.id),[proId]);
      const exclusiveRows=await request(base,'/api/ideas',{cookie:exclusive.cookie});assert.equal(exclusiveRows.status,200);assert.deepEqual(exclusiveRows.data.records.map(r=>r.id),[exclusiveId]);
      assert.equal((await request(base,'/api/ideas/'+exclusiveId,{cookie:pro.cookie})).status,404);
      assert.equal((await request(base,'/api/ideas/'+proId,{cookie:exclusive.cookie})).status,404);
      assert.equal((await request(base,'/api/ideas/'+exclusiveId,{cookie:exclusive.cookie})).status,200);
      const proLessons=await request(base,'/api/lessons',{cookie:pro.cookie}),exclusiveLessons=await request(base,'/api/lessons',{cookie:exclusive.cookie});
      assert.equal(proLessons.status,200);assert.equal(exclusiveLessons.status,200);
      assert.ok(proLessons.data.lessons.length>0);assert.ok(proLessons.data.lessons.every(l=>!l.id.startsWith('exclusive-')));
      assert.ok(exclusiveLessons.data.lessons.some(l=>l.id.startsWith('exclusive-')));
      for(const path of ['/app.html','/%61pp.html','/calculator.html','/learn.html'])assert.equal((await request(base,path,{cookie:pro.cookie})).status,200,path);
    });

    await t.test('only trusted administrator can grant access or publish and mutate ideas',async()=>{
      for(const account of [unpaid,pro,exclusive]){
        assert.equal((await request(base,'/api/admin/users',{cookie:account.cookie})).status,403);
        assert.equal((await request(base,'/api/admin/subscriptions',{method:'POST',cookie:account.cookie,body:{userId:account.data.user.id,plan:'exclusive',expiresAt:new Date(Date.now()+86400000).toISOString(),reason:'Forged grant'}})).status,403);
        assert.equal((await request(base,'/api/admin/ideas',{method:'POST',cookie:account.cookie,body:{mode:'quick',d:{ticker:'FORGED',dir:'ЛОНГ',strategy:'Momentum RU'}}})).status,403);
        assert.equal((await request(base,'/api/admin/ideas/'+proId+'/events',{method:'POST',cookie:account.cookie,body:{action:'note',note:'Forged update'}})).status,403);
        assert.equal((await request(base,'/api/admin/ideas/'+proId,{method:'DELETE',cookie:account.cookie})).status,403);
        assert.equal((await request(base,'/%61dmin.html',{cookie:account.cookie})).status,303);
        assert.equal((await request(base,'/assets/%61dmin.js',{cookie:account.cookie})).status,403);
      }
      assert.equal((await request(base,'/api/admin/users')).status,401);
      assert.equal((await request(base,'/admin.html',{cookie:admin.cookie})).status,200);
      assert.equal((await request(base,'/api/admin/ideas',{cookie:admin.cookie})).data.records.length,2);
      assert.equal((await request(base,'/api/admin/subscriptions',{method:'POST',cookie:admin.cookie,origin:'https://outside.example',body:{userId:pro.data.user.id,plan:'pro',expiresAt:null,reason:'Cross-origin revocation'}})).status,403);
    });

    await t.test('revocation and expiry immediately remove access from existing sessions',async()=>{
      assert.equal((await grant(pro,'pro',null)).status,200);
      assert.equal((await request(base,'/api/ideas',{cookie:pro.cookie})).status,403);
      assert.equal((await request(base,'/assets/app.js',{cookie:pro.cookie})).status,403);
      assert.equal((await request(base,'/app.html',{cookie:pro.cookie})).status,303);
      // A trusted server-side fixture simulates time passing without a timing-sensitive sleep.
      const filename=join(directory,'accounts.json'),db=JSON.parse(await readFile(filename,'utf8'));
      db.users.find(u=>u.id===exclusive.data.user.id).subscriptions[0].expiresAt=new Date(Date.now()-1000).toISOString();
      await writeFile(filename,JSON.stringify(db),{mode:0o600});
      assert.equal((await request(base,'/api/ideas',{cookie:exclusive.cookie})).status,403);
      assert.equal((await request(base,'/api/lessons',{cookie:exclusive.cookie})).status,403);
      assert.equal((await request(base,'/api/news',{cookie:exclusive.cookie})).status,403);
      const me=await request(base,'/api/me',{cookie:exclusive.cookie});assert.deepEqual(me.data.user.access.activePlans,[]);
      assert.equal((await request(base,'/api/admin/users',{cookie:admin.cookie})).status,200);
    });
  }finally{
    if(server)await server.close();await rm(directory,{recursive:true,force:true});
  }
});
