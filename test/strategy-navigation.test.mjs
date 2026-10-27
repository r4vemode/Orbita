import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../public/assets/strategies.js',import.meta.url),'utf8');
const catalog=[{name:'Momentum RU',slug:'momentum-ru',plan:'pro'},{name:'Orbita Exclusive',slug:'orbita-exclusive',plan:'exclusive',exclusive:true}].map(strategy=>({...strategy,label:'Стратегия',markets:['Акции'],horizon:'1–5 дней',points:[],lessons:strategy.exclusive?[{id:'exclusive-read',title:'Контекст',description:'Обзор подхода'}]:[]}));
async function render({user=null,page='detail',slug='orbita-exclusive'}={}){
  const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:''});return nodes.get(id);};
  const pathname=page==='catalog'?'/strategies.html':'/strategy.html',search=page==='catalog'?'':'?strategy='+slug;
  const context=vm.createContext({window:{ORBITA_STRATEGIES:catalog,addEventListener(){}},location:{pathname,search},URLSearchParams,fetch:async()=>({ok:true,json:async()=>({user})}),OrbitaStore:{escape:value=>String(value??''),refresh:async()=>{if(!user?.access?.activePlans?.length&&!user?.access?.isAdmin)throw Object.assign(Error('Subscription required'),{status:user?403:401});},read:()=>({records:[]})},document:{body:{dataset:{strategyPage:page}},getElementById:node,querySelector:()=>null,addEventListener(){}}});
  await vm.runInContext(source,context);return node(page==='catalog'?'strategyCards':'strategyDetail').innerHTML;
}
const hrefs=html=>[...html.matchAll(/href="([^"]+)"/g)].map(match=>new URL(match[1].replaceAll('&amp;','&'),'https://orbita.example'));

test('public strategy purchase links carry the correct independent tariff in catalog and detail',async()=>{
  const free={access:{activePlans:[]}};
  const links=hrefs(await render({page:'catalog',user:free})).filter(url=>url.pathname==='/subscriptions.html');assert.deepEqual(links.map(url=>url.searchParams.get('plan')),['pro','exclusive']);
  for(const strategy of catalog){const detail=hrefs(await render({slug:strategy.slug,user:free})).filter(url=>url.pathname==='/subscriptions.html');assert.ok(detail.length>=2);assert.ok(detail.every(url=>url.searchParams.get('plan')===strategy.plan));}
});

test('guest strategy login preserves plan and a local strategy return target',async()=>{
  for(const strategy of catalog){const links=hrefs(await render({slug:strategy.slug}));const login=links.find(url=>url.pathname==='/account.html');assert.ok(login);assert.equal(login.searchParams.get('plan'),strategy.plan);assert.equal(login.searchParams.get('next'),'/strategy.html?strategy='+strategy.slug);}
});

test('a paid strategy still links directly to its preselected calculator',async()=>{
  for(const strategy of catalog){const links=hrefs(await render({slug:strategy.slug,user:{access:{activePlans:[strategy.plan]}}})),calculator=links.find(url=>url.pathname==='/calculator.html');assert.ok(calculator);assert.equal(calculator.searchParams.get('strategy'),strategy.name);assert.equal(links.filter(url=>url.pathname==='/subscriptions.html').length,0);}
});

test('Exclusive article purchase links select Exclusive for guests, free users and Pro subscribers',async()=>{
  for(const user of [null,{access:{activePlans:[]}},{access:{activePlans:['pro']}}]){
    const links=hrefs(await render({user}));assert.equal(links.filter(url=>url.pathname==='/learn.html').length,0);
    const purchases=links.filter(url=>url.pathname==='/subscriptions.html');assert.ok(purchases.length>=3);assert.ok(purchases.every(url=>url.searchParams.get('plan')==='exclusive'));
  }
});
