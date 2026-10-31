import assert from 'node:assert/strict';

// The caller owns an isolated beta fixture. Requests are delayed only in this
// browser context; no working publications or external services participate.
export async function runAdminRaceFlows({session,browser,record}){
 const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'ru-RU',timezoneId:'Europe/Moscow'}),check=record||(async(_title,work)=>work());
 try{
  await context.route('https://fonts.googleapis.com/**',route=>route.abort());await context.route('https://fonts.gstatic.com/**',route=>route.abort());
  const owner=session.accounts.find(account=>account.role==='admin');const login=await context.request.post(session.base+'/api/login',{headers:{Origin:session.base},data:{email:owner.email,password:owner.password}});assert.equal(login.status(),200);
  const page=await context.newPage(),errors=[];page.on('pageerror',cause=>errors.push(cause.name));
  await check('Редакция: медленная публикация блокирует смену контекста и сохраняет соседний черновик',async()=>{
   await page.goto(session.base+'/admin.html');await page.waitForFunction(()=>document.querySelectorAll('#ideaList [data-id]').length>1&&!document.getElementById('refreshIdeas').disabled);
   const records=await(await context.request.get(session.base+'/api/admin/ideas')).json(),published=records.records.filter(record=>record.published);assert.ok(published.length>1);const [first,other]=published;
   await page.locator('[data-id="'+first.id+'"]').click();await page.locator('#fullComposer').evaluate(node=>node.open=true);await page.locator('#ideaForm [name=ticker]').fill('LOCALDRAFT');await page.locator('#eventAction').selectOption('note');await page.locator('#eventNote').fill('Учебная медленная публикация');
   let release,entered;const gate=new Promise(resolve=>{release=resolve;}),intercepted=new Promise(resolve=>{entered=resolve;});
   await page.route('**/api/admin/ideas/*/events',async route=>{entered();await gate;await route.continue();},{times:1});
   await page.locator('#saveEvent').click();await intercepted;
   try{
    for(const id of ['clearFullForm','refreshIdeas','refreshUsers','newIdea'])assert.equal(await page.locator('#'+id).isDisabled(),true,id);
    assert.ok(await page.locator('#ideaList [data-id]').evaluateAll(nodes=>nodes.every(node=>node.disabled)));
    await page.locator('[data-id="'+other.id+'"]').evaluate(node=>node.click());await page.locator('#clearFullForm').evaluate(node=>node.click());
    assert.equal(await page.locator('#ideaList .active').getAttribute('data-id'),first.id);assert.equal(await page.locator('#ideaForm [name=ticker]').inputValue(),'LOCALDRAFT');
   }finally{release();}
   await page.waitForFunction(()=>!document.getElementById('saveEvent').disabled&&document.getElementById('eventNote').value==='');assert.equal(await page.locator('#ideaForm [name=ticker]').inputValue(),'LOCALDRAFT');assert.ok(await page.locator('#ideaList [data-id]').evaluateAll(nodes=>nodes.every(node=>!node.disabled)));assert.deepEqual(errors,[]);
   page.once('dialog',dialog=>dialog.accept());await page.locator('#clearFullForm').click();
  });
 }finally{await context.close();}
}
