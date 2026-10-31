/* Revalidate already-open paid views when the browser account or its access changes. */
(() => {
  const fingerprint=user=>JSON.stringify(user?{id:user.id,admin:user.access?.isAdmin===true,plans:[...(user.access?.activePlans||[])].sort(),member:user.access?.hasSubscription===true}:null);
  function watch(user,onChange,{intervalMs=30000}={}){
    const expected=fingerprint(user);let stopped=false,pending=null,timer=null,controller=null;
    function schedule(){clearTimeout(timer);if(!stopped&&!document.hidden)timer=setTimeout(()=>{void check();},intervalMs);}
    function stop(){stopped=true;clearTimeout(timer);controller?.abort();document.removeEventListener('visibilitychange',visible);window.removeEventListener('pagehide',stop);}
    async function check(){
      if(stopped)return false;if(pending)return pending;
      pending=(async()=>{
        controller=new AbortController();const timeout=setTimeout(()=>controller?.abort(),8000);
        try{
          const response=await fetch('/api/me',{credentials:'same-origin',cache:'no-store',signal:controller.signal});
          let next;if(response.status===401)next=null;else{if(!response.ok)return true;const data=await response.json();if(!Object.hasOwn(data,'user'))return true;next=data.user;}
          if(stopped)return false;if(fingerprint(next)!==expected){stop();onChange(next);return false;}return true;
        }catch{return !stopped;}
        finally{clearTimeout(timeout);controller=null;}
      })();
      try{return await pending;}finally{pending=null;schedule();}
    }
    function visible(){if(document.hidden)clearTimeout(timer);else void check();}
    document.addEventListener('visibilitychange',visible);window.addEventListener('pagehide',stop);schedule();
    return {check,stop};
  }
  window.OrbitaMemberSession={watch};
})();
