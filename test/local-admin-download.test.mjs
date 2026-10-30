import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv,randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm,access,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createAccounts} from '../lib/accounts.mjs';
import {derivePassword} from '../lib/password-work.mjs';
import {decodeConfig,provision,prepared,localEnvironment} from '../admin-download/setup.mjs';

function seal(config){const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('ORBITA-LOCAL-ADMIN-v1'));const data=Buffer.concat([cipher.update(JSON.stringify(config)),cipher.final()]);return {key:key.toString('base64url'),envelope:{version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')}};}
async function fixture(){
  const root=await mkdtemp(path.join(tmpdir(),'orbita-admin-installer-'));await mkdir(path.join(root,'public/assets'),{recursive:true});
  await writeFile(path.join(root,'public/assets/account.js'),"function go(user){\n    if (user.security?.adminEnrollmentRequired) { location.assign('/security.html?enroll=1'); return; }\n    if (!user.emailVerified) location.assign('/security.html?verify=1');\n}\n");
  const salt=randomBytes(16).toString('hex'),hash=(await derivePassword('synthetic-installer-password',salt,64)).toString('hex'),config={version:1,bundleId:randomUUID(),email:'local-admin@example.test',salt,hash},sealed=seal(config);
  return {root,config,...sealed,close:()=>rm(root,{recursive:true,force:true})};
}

test('local installer authenticates encrypted configuration before writing accounts and rejects corruption without revealing secrets',async()=>{
  const f=await fixture();try{
    assert.deepEqual(decodeConfig(f.envelope,f.key),f.config);assert.ok(!JSON.stringify(f.envelope).includes(f.config.email));assert.ok(!JSON.stringify(f.envelope).includes(f.config.hash));
    const malformed=seal({...f.config,salt:[f.config.salt]});assert.throws(()=>decodeConfig(malformed.envelope,malformed.key));
    assert.equal(await prepared(f.root,{env:{}}),false);await assert.rejects(access(path.join(f.root,'data')),{code:'ENOENT'});
    for(const envelope of [f.envelope,{...f.envelope,tag:Buffer.alloc(16).toString('base64')}])await assert.rejects(provision(f.root,envelope,randomBytes(32).toString('base64url'),{env:{}}),cause=>!cause.message.includes(f.config.email)&&!cause.message.includes(f.key));
    await assert.rejects(access(path.join(f.root,'data')),{code:'ENOENT'});
  }finally{await f.close();}
});

test('local installer preserves other users, subscriptions and MFA, revokes only owner sessions and does not reset a later password',async()=>{
  const f=await fixture();try{
    const accounts=await createAccounts(path.join(f.root,'data'),{publicOrigin:'',mailer:{configured:false}}),other={id:randomUUID(),email:'preserve@example.test',role:'member',subscriptions:[{plan:'pro',expiresAt:'2090-01-01T00:00:00.000Z'}]},owner={id:randomUUID(),email:f.config.email,role:'member',salt:randomBytes(16).toString('hex'),hash:'old',emailVerified:false,mfa:{enabled:true,secret:{iv:'keep',data:'keep',tag:'keep'},recoveryHashes:['keep']}};
    await accounts.transact(db=>{db.users=[other,owner];db.sessions=[{userId:owner.id,hash:'owner-session'},{userId:other.id,hash:'other-session'}];db.securityTokens=[{userId:owner.id},{userId:other.id}];db.authChallenges=[{userId:owner.id},{userId:other.id}];});
    await provision(f.root,f.envelope,f.key,{env:{}});let db=await accounts.readDatabase(),installed=db.users.find(user=>user.id===owner.id);
    assert.deepEqual(db.users.find(user=>user.id===other.id),other);assert.equal(installed.role,'admin');assert.equal(installed.hash,f.config.hash);assert.equal(installed.emailVerified,false);assert.equal(installed.consents,undefined);assert.deepEqual(installed.mfa,owner.mfa);assert.deepEqual(db.sessions,[{userId:other.id,hash:'other-session'}]);assert.deepEqual(db.securityTokens,[{userId:other.id}]);assert.deepEqual(db.authChallenges,[{userId:other.id}]);
    assert.equal(await prepared(f.root,{env:{}}),true);await accounts.transact(db=>{db.users.find(user=>user.id===owner.id).hash='updated-by-owner';});await provision(f.root,f.envelope,f.key,{env:{}});db=await accounts.readDatabase();assert.equal(db.users.find(user=>user.id===owner.id).hash,'updated-by-owner');
    const script=await readFile(path.join(f.root,'public/assets/account.js'),'utf8');assert.ok(script.indexOf('adminEnrollmentRequired')<script.indexOf('LOCAL_ADMIN_DIRECT_ENTRY'));assert.ok(script.indexOf('LOCAL_ADMIN_DIRECT_ENTRY')<script.indexOf('!user.emailVerified'));assert.ok(!script.includes(f.config.email));assert.ok(!script.includes(f.config.hash));
    await accounts.transact(db=>{db.users.find(user=>user.id===owner.id).role='member';});assert.equal(await prepared(f.root,{env:{}}),false);await provision(f.root,f.envelope,f.key,{env:{}});assert.equal((await accounts.readDatabase()).users.find(user=>user.id===owner.id).role,'admin');
  }finally{await f.close();}
});

test('local installer refuses public environments and data symlinks; child environment excludes operator secrets',async()=>{
  const f=await fixture();try{
    for(const env of [{NODE_ENV:'production'},{ORBITA_PUBLIC_ORIGIN:'https://public.example.test'},{HOST:'0.0.0.0'}])await assert.rejects(provision(f.root,f.envelope,f.key,{env}));
    await assert.rejects(access(path.join(f.root,'data')),{code:'ENOENT'});await symlink(path.join(f.root,'public'),path.join(f.root,'data'),'dir');await assert.rejects(provision(f.root,f.envelope,f.key,{env:{}}));await assert.rejects(access(path.join(f.root,'public/accounts.json')),{code:'ENOENT'});
    const env=localEnvironment(f.root,{PATH:process.env.PATH,CLOUDPAYMENTS_API_SECRET:'operator-secret',RESEND_API_KEY:'operator-mail',TELEGRAM_BOT_TOKEN:'operator-token',NODE_OPTIONS:'private-option',RADAR_AI_API_KEY:'operator-ai'});assert.equal(env.HOST,'127.0.0.1');assert.equal(env.ORBITA_DATA_DIR,path.join(f.root,'data'));for(const key of ['CLOUDPAYMENTS_API_SECRET','RESEND_API_KEY','TELEGRAM_BOT_TOKEN','NODE_OPTIONS','RADAR_AI_API_KEY'])assert.equal(env[key],undefined);
  }finally{await f.close();}
});
