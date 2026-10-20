(() => {
  const plans={pro:{name:'Orbita Pro',price:2999},exclusive:{name:'Orbita Exclusive',price:4999}};
  let user=null;
  function safeNext(value,fallback='/subscriptions.html'){try{const url=new URL(value,location.origin);if(url.origin!==location.origin||!['/app.html','/calculator.html','/learn.html','/admin.html','/subscriptions.html','/strategy.html','/strategies.html'].includes(url.pathname))return fallback;return url.pathname+url.search;}catch{return fallback;}}
  async function request(url,options={}){let r;try{r=await fetch(url,{cache:'no-store',...options,headers:{'Content-Type':'application/json',...options.headers}});}catch{throw Error('Нет связи с сервером. Проверьте запуск сайта через npm start и подключение.');}let data;try{if(!r.headers.get('content-type')?.includes('application/json'))throw Error();data=await r.json();}catch{throw Error('Сервер аккаунтов не отвечает. Запустите проект командой npm start; Live Server и GitHub Pages не поддерживают регистрацию.');}if(!r.ok)throw Object.assign(Error(data.error||'Не удалось выполнить запрос.'),{status:r.status,code:data.code});return data;}
  async function current(){const data=await request('/api/me');user=data.user;return user;}
  async function requireSubscription(){const value=await current();if(!value){location.replace('/account.html?next='+encodeURIComponent(safeNext(location.pathname+location.search)));return null;}if(!value.access?.hasSubscription){location.replace('/subscriptions.html?next='+encodeURIComponent(safeNext(location.pathname+location.search)));return null;}return value;}
  async function requireAdmin(){const value=await current();if(!value){location.replace('/account.html?next=/admin.html');return null;}if(!value.access?.isAdmin){location.replace('/subscriptions.html?error=admin');return null;}return value;}
  window.OrbitaAccess={request,current,requireSubscription,requireAdmin,safeNext,plans,get user(){return user;}};
  window.addEventListener('pageshow',event=>{if(event.persisted&&['/app.html','/calculator.html','/learn.html','/admin.html'].includes(location.pathname))location.reload();});
})();
