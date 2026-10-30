import assert from 'node:assert/strict';
import {totp} from '../lib/account-security.mjs';

// The caller supplies an isolated local-beta fixture and owns its teardown.
// This suite never writes real business information or calls a payment service.
export async function runLegalFlows({session,browser,record}){
  const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'ru-RU',timezoneId:'Europe/Moscow',reducedMotion:'reduce'}),guest=await browser.newContext({locale:'ru-RU',timezoneId:'Europe/Moscow'});
  const errors=[],owner=session.accounts.find(account=>account.role==='admin'),free=session.accounts.find(account=>account.role==='free');
  for(const target of [context,guest]){await target.route('https://fonts.googleapis.com/**',route=>route.abort());await target.route('https://fonts.gstatic.com/**',route=>route.abort());}
  const fields=['ownerKind','ownerName','inn','ogrn','address','supportEmail','privacyEmail','hostingDetails','processorsDetails'];
  let page,firstVersion,firstHtml;
  const api=async(route,{method='GET',data,expected=200,target=context}={})=>{const response=await target.request.fetch(session.base+route,{method,headers:{Origin:session.base},...(data===undefined?{}:{data})});assert.equal(response.status(),expected,route);return response;};
  const fill=async profile=>{for(const [name,value]of Object.entries(profile))name==='ownerKind'?await page.locator('[name=ownerKind]').selectOption(value):await page.locator(`#legalForm [name="${name}"]`).fill(value);};
  const save=async()=>{const response=page.waitForResponse(value=>value.request().method()==='PUT'&&new URL(value.url()).pathname==='/api/admin/legal');await page.locator('#saveLegal').click();const result=await response;assert.equal(result.status(),200);await page.waitForFunction(()=>!document.getElementById('saveLegal').disabled&&document.getElementById('legalMessage').textContent.startsWith('Черновик сохранён.'));return result.json();};
  const publish=async password=>{await page.locator('#legalPublishForm [name=password]').fill(password);await page.locator('#legalReviewed').check();const response=page.waitForResponse(value=>value.request().method()==='POST'&&new URL(value.url()).pathname==='/api/admin/legal/publish');page.once('dialog',dialog=>dialog.accept());await page.locator('#publishLegal').click();return response;};
  const profile={ownerKind:'self-employed',ownerName:'Учебный исполнитель QA <img src=x onerror=alert(1)>',inn:syntheticInn(),ogrn:'',address:'Учебный адрес для приёмки. Не реальные реквизиты.',supportEmail:'help@legal-qa.example.test',privacyEmail:'privacy@legal-qa.example.test',hostingDetails:'Учебное локальное размещение для приёмки. Не сведения о рабочем хостинге.',processorsDetails:'Учебная среда: внешние провайдеры отключены. Все данные вымышлены; это не описание рабочего сервиса.'};
  try{
    await record('Документы: доступ редакции и частный черновик без раскрытия посетителям',async()=>{
      assert.equal((await guest.request.get(session.base+'/api/admin/legal')).status(),401);assert.equal((await guest.request.get(session.base+'/api/admin/legal/preview?document=offer')).status(),401);
      await api('/api/login',{method:'POST',data:{email:free.email,password:free.password},target:guest});assert.equal((await guest.request.get(session.base+'/api/admin/legal')).status(),403);assert.equal((await guest.request.get(session.base+'/api/admin/legal/preview?document=privacy')).status(),403);
      page=await context.newPage();page.on('pageerror',cause=>errors.push(cause.name));await page.goto(session.base+'/account.html');await page.locator('[name=email]').fill(owner.email);await page.locator('[name=password]').fill(owner.password);await page.locator('#submit').click();await page.waitForURL('**/security.html?verify=1');
      await page.goto(session.base+'/legal-admin.html');await page.waitForSelector('#legalWorkspace:not([hidden])');for(const field of fields)assert.equal(await page.locator(`#legalForm [name="${field}"]`).inputValue(),'');assert.equal(await page.locator('#openPublish').isDisabled(),true);
      await fill({ownerName:profile.ownerName});await save();const metadata=await(await api('/api/legal',{target:guest})).json();assert.equal(metadata.published,false);assert.equal(metadata.profile.ownerName,'');const publicHtml=await(await api('/offer.html',{target:guest})).text();assert.ok(!publicHtml.includes('Учебный исполнитель QA'));
      const preview=await api('/api/admin/legal/preview?document=offer'),html=await preview.text();assert.match(preview.headers()['content-type'],/text\/html/);assert.match(preview.headers()['cache-control'],/no-store/);assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img src=x onerror=alert(1)>'));assert.equal(await page.locator('#openPublish').isDisabled(),true);
    });

    await record('Документы: обязательные поля, контроль ИНН и повторное подтверждение пароля',async()=>{
      await fill({...profile,inn:profile.inn.slice(0,-1)+String((Number(profile.inn.at(-1))+1)%10)});await save();assert.equal(await page.locator('#openPublish').isDisabled(),true);assert.match(await page.locator('#legalReadiness').innerText(),/ИНН/);
      await fill({inn:profile.inn});await save();assert.equal(await page.locator('#openPublish').isEnabled(),true);await page.locator('#openPublish').click();assert.equal(await page.locator('#publishCodeField').isVisible(),false);
      const denied=await publish('Wrong-legal-fixture-password');assert.ok([401,403].includes(denied.status()));await page.waitForFunction(()=>!document.getElementById('publishLegal').disabled&&document.getElementById('publishMessage').textContent.length>0);assert.equal(await page.locator('#legalPublishForm [name=password]').inputValue(),'');assert.equal(await page.locator('#legalPublishForm [name=code]').inputValue(),'');assert.equal(await page.locator('#legalReviewed').isChecked(),false);assert.equal((await(await api('/api/legal',{target:guest})).json()).published,false);
      const accepted=await publish(owner.password);assert.equal(accepted.status(),200);const result=await accepted.json();firstVersion=result.currentVersion;assert.ok(firstVersion);await page.waitForFunction(()=>document.getElementById('legalMessage').textContent.startsWith('Новая редакция опубликована.'));assert.equal(await page.locator('#publishPanel').isVisible(),false);
      const publicProfile=await(await api('/api/legal',{target:guest})).json();assert.equal(publicProfile.version,firstVersion);assert.equal(publicProfile.profile.ownerName,profile.ownerName);firstHtml=await(await api('/offer.html',{target:guest})).text();assert.ok(firstHtml.includes('&lt;img'));assert.ok(!firstHtml.includes('<img src=x onerror=alert(1)>'));
    });

    await record('Документы: новая редакция сохраняет прежний текст и правильные ссылки архива',async()=>{
      const changedName='Вторая учебная редакция QA';await fill({ownerName:changedName});await save();assert.equal((await(await api('/api/legal',{target:guest})).json()).profile.ownerName,profile.ownerName);
      await page.locator('#openPublish').click();const accepted=await publish(owner.password);assert.equal(accepted.status(),200);const result=await accepted.json();assert.notEqual(result.currentVersion,firstVersion);assert.equal(result.versions.length,2);await page.waitForFunction(()=>!document.getElementById('publishLegal').disabled&&document.getElementById('publishPanel').hidden);
      assert.equal((await(await api('/api/legal',{target:guest})).json()).profile.ownerName,changedName);assert.equal(await(await api('/offer.html?version='+encodeURIComponent(firstVersion),{target:guest})).text(),firstHtml);
      const historical=page.locator('#legalVersions a[href="offer.html?version='+firstVersion+'"]');assert.equal(await historical.count(),1);assert.equal(await historical.getAttribute('rel'),'noopener noreferrer');assert.equal(await page.locator('#legalVersions .legal-version').count(),2);
    });

    await record('Документы: конфликт сохраняет набранное, поля защиты очищаются, мобильная форма помещается',async()=>{
      const current=await(await api('/api/admin/legal')).json();await api('/api/admin/legal',{method:'PUT',data:{revision:current.revision,profile:{...current.draft,address:'Сохранено из второй учебной вкладки'}}});
      await fill({ownerName:'Мои несохранённые реквизиты'});const conflict=page.waitForResponse(value=>value.request().method()==='PUT'&&new URL(value.url()).pathname==='/api/admin/legal');await page.locator('#saveLegal').click();assert.equal((await conflict).status(),409);await page.waitForFunction(()=>document.getElementById('legalMessage').textContent.includes('другой вкладке'));assert.equal(await page.locator('#legalForm [name=ownerName]').inputValue(),'Мои несохранённые реквизиты');assert.equal(await page.locator('#openPublish').isDisabled(),true);
      page.once('dialog',dialog=>dialog.accept());await page.locator('#reloadLegal').click();await page.waitForFunction(()=>document.getElementById('legalMessage').textContent==='Загружен актуальный черновик.');assert.equal(await page.locator('#legalForm [name=address]').inputValue(),'Сохранено из второй учебной вкладки');
      for(const width of [320,390]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
      await page.locator('#openPublish').click();await page.locator('#legalPublishForm [name=password]').fill(owner.password);assert.equal(await page.evaluate(password=>Object.values(localStorage).concat(Object.values(sessionStorage)).some(value=>String(value).includes(password)),owner.password),false);await page.goto(session.base+'/admin.html');await page.goBack();await page.waitForSelector('#legalWorkspace:not([hidden])');assert.equal(await page.locator('#legalPublishForm [name=password]').inputValue(),'');assert.equal(await page.locator('#legalPublishForm [name=code]').inputValue(),'');assert.deepEqual(errors,[]);
    });

    await record('Документы: публикация требует новый второй фактор и отклоняет использованный резервный код',async()=>{
      let secret='',codes=[],stage='подключение второго фактора';
      try{
        const setup=await(await api('/api/security/mfa/setup',{method:'POST',data:{password:owner.password}})).json();secret=setup.secret;assert.equal(typeof secret,'string');
        const confirmation=await(await api('/api/security/mfa/confirm',{method:'POST',data:{code:totp(secret)}})).json();secret='';codes=confirmation.recoveryCodes;assert.equal(codes.length,10);await page.reload();await page.waitForSelector('#legalWorkspace:not([hidden])');
        stage='проверка обязательного кода';await page.locator('#openPublish').click();assert.equal(await page.locator('#publishCodeField').isVisible(),true);await page.locator('#legalPublishForm [name=password]').fill(owner.password);await page.locator('#legalReviewed').check();assert.equal(await page.locator('#legalPublishForm [name=code]').evaluate(input=>input.checkValidity()),false);
        stage='публикация с резервным кодом';await page.locator('#legalPublishForm [name=code]').fill(codes[0]);const accepted=await publish(owner.password);assert.equal(accepted.status(),200);const result=await accepted.json();assert.equal(result.versions.length,3);await page.waitForFunction(()=>document.getElementById('publishPanel').hidden&&!document.getElementById('openPublish').disabled);assert.equal(await page.locator('#legalPublishForm [name=password]').inputValue(),'');assert.equal(await page.locator('#legalPublishForm [name=code]').inputValue(),'');
        stage='отклонение повторного резервного кода';await page.locator('#openPublish').click();await page.locator('#legalPublishForm [name=code]').fill(codes[0]);const rejected=await publish(owner.password);assert.equal(rejected.status(),401);await page.waitForFunction(()=>!document.getElementById('publishLegal').disabled&&document.getElementById('publishMessage').textContent.length>0);assert.equal((await(await api('/api/admin/legal')).json()).versions.length,3);assert.equal(await page.locator('#legalPublishForm [name=password]').inputValue(),'');assert.equal(await page.locator('#legalPublishForm [name=code]').inputValue(),'');assert.deepEqual(errors,[]);
      }catch{throw Error('Защищённая публикация не прошла этап «'+stage+'». Секрет и резервные коды исключены из отчёта.');}
      finally{secret='';codes.length=0;}
    });
  }finally{await context.close();await guest.close();}
}

function syntheticInn(){
  const digits=[...'9900000000'].map(Number),sum=weights=>weights.reduce((total,weight,index)=>total+weight*digits[index],0)%11%10;
  digits.push(sum([7,2,4,10,3,5,9,4,6,8]));digits.push(sum([3,7,2,4,10,3,5,9,4,6,8]));return digits.join('');
}
