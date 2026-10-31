import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../public/assets/admin-session.js',import.meta.url),'utf8');
const owner={id:'isolated-admin',access:{isAdmin:true},security:{adminEnrollmentRequired:false}};
function fixture({revoke}){
 let current=owner,cleared=false,redirect=null;
 const root={style:{visibility:''},inert:false,hidden:false,before(){},contains(){return false;},querySelectorAll(){return [];}};
 const document=new EventTarget();Object.assign(document,{hidden:false,activeElement:null,getElementById(){return root;},createElement(){return {setAttribute(){},hidden:false};}});
 const window=new EventTarget();window.OrbitaAccess={async request(url){if(url==='/api/me')return {user:current};if(revoke)current=null;throw Object.assign(Error('Action denied'),{status:401});}};
 vm.runInNewContext(source,{window,document,location:{pathname:'/support-admin.html',search:'',replace(value){redirect=value;}},AbortController,setTimeout,clearTimeout});
 const guard=window.OrbitaAdminSession.watch(owner,{workspace:'fixture',clear(){cleared=true;}});
 return {guard,root,cleared:()=>cleared,redirect:()=>redirect};
}
test('an authorization error after a request clears the old editor when its session was revoked',async()=>{
 const f=fixture({revoke:true});try{await assert.rejects(f.guard.request('/api/admin/fixture'),cause=>cause.code==='ACCOUNT_CHANGED');assert.equal(f.cleared(),true);assert.equal(f.root.hidden,true);assert.equal(f.redirect(),'/support-admin.html');}finally{f.guard.stop();}
});
test('a denied action preserves the editor draft when the same administrator is still authenticated',async()=>{
 const f=fixture({revoke:false});try{await assert.rejects(f.guard.request('/api/admin/fixture'),cause=>cause.status===401&&cause.message==='Action denied');assert.equal(f.cleared(),false);assert.equal(f.root.hidden,false);assert.equal(f.root.style.visibility,'');assert.equal(f.redirect(),null);}finally{f.guard.stop();}
});
