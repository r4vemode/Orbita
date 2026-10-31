/* Only explicitly enrolled editor views use this guard. Drafts stay in memory
   during a temporary connection failure; a changed account clears them. */
(() => {
 function watch(owner,{workspace,clear,intervalMs=30000}={}){
  const A=window.OrbitaAccess,root=document.getElementById(workspace);if(!root||!owner?.id)throw Error('Не удалось проверить редакцию.');
  const visibility=root.style.visibility,inert=root.inert,status=document.createElement('p'),retry=document.createElement('button');status.setAttribute('role','status');status.hidden=true;retry.type='button';retry.textContent='Повторить проверку';retry.hidden=true;root.before(status,retry);
  let invalidated=false,stopped=false,pending=null,timer=null,controller=null,focusState=null;
  function mask(text){if(!focusState&&root.contains(document.activeElement)){const node=document.activeElement;focusState={node};try{focusState.start=node.selectionStart;focusState.end=node.selectionEnd;focusState.direction=node.selectionDirection;}catch{}}root.style.visibility='hidden';root.inert=true;status.textContent=text;status.hidden=false;}
  function schedule(){clearTimeout(timer);if(!stopped&&!document.hidden)timer=setTimeout(()=>{void check();},intervalMs);}
  function stop(){stopped=true;clearTimeout(timer);controller?.abort();document.removeEventListener('visibilitychange',visible);window.removeEventListener('pagehide',stop);}
  function changed(){invalidated=true;focusState=null;stop();clear?.();for(const form of root.querySelectorAll('form'))form.reset();for(const field of root.querySelectorAll('input,textarea,select')){field.value='';if('checked'in field)field.checked=false;field.disabled=true;}root.hidden=true;mask('Аккаунт или права редакции изменились. Открываем страницу заново…');retry.hidden=true;location.replace(location.pathname+location.search);}
  async function check(){
   if(stopped)return false;if(pending)return pending;mask('Проверяем доступ к редакции…');retry.hidden=true;
   controller=new AbortController();const active=controller,timeout=setTimeout(()=>active.abort(),8000);
   pending=(async()=>{try{const data=await A.request('/api/me',{signal:active.signal});if(stopped)return false;if(!Object.hasOwn(data,'user'))throw Error('Invalid identity response');const current=data.user;if(!current||current.id!==owner.id||current.access?.isAdmin!==true||current.security?.adminEnrollmentRequired){changed();return false;}if(!document.hidden){root.style.visibility=visibility;root.inert=inert;status.hidden=true;const saved=focusState;focusState=null;if(saved?.node.isConnected&&!saved.node.disabled){saved.node.focus({preventScroll:true});if(Number.isInteger(saved.start)&&Number.isInteger(saved.end))try{saved.node.setSelectionRange(saved.start,saved.end,saved.direction);}catch{}}}return true;}
    catch(cause){if(!stopped){if([401,403].includes(cause.status)){changed();return false;}mask('Не удалось проверить доступ. Несохранённые поля остаются в этой вкладке. Повторите проверку перед продолжением.');retry.hidden=false;}return false;}finally{clearTimeout(timeout);if(controller===active)controller=null;}})();
   try{return await pending;}finally{pending=null;schedule();}
  }
  async function ensure(){if(!await check())throw Object.assign(Error(invalidated?'Аккаунт изменился.':'Не удалось проверить доступ к редакции.'),{status:invalidated?403:503,code:invalidated?'ACCOUNT_CHANGED':'ACCOUNT_UNCONFIRMED'});}
  async function request(...args){await ensure();const result=await A.request(...args);await ensure();return result;}
  function visible(){if(document.hidden){clearTimeout(timer);mask('Проверяем доступ к редакции…');}else void check();}
  retry.onclick=()=>{void check();};document.addEventListener('visibilitychange',visible);window.addEventListener('pagehide',stop);schedule();return {check,ensure,request,stop};
 }
 window.OrbitaAdminSession={watch};
})();
