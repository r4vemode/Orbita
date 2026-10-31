// One independent, bounded job per provider. Failures never halt other sources.
export function createRadarJobs({providers=[],initialStates={},onEvents,onState,now=Date.now}={}){
  let stopped=true;const jobs=new Map();
  for(const provider of providers){
    if(!provider||typeof provider.id!=='string'||jobs.has(provider.id)||typeof provider.fetchEvents!=='function'||!Number.isFinite(provider.interval)||provider.interval<1000)throw Error('Invalid Radar provider');
    const previous=initialStates[provider.id]||{},state={lastFetch:null,lastSuccess:null,eventsToday:0,errorsToday:0,averageDelay:null,nextAttemptAt:null,error:null,day:null,totalDelay:0,delayCount:0,...previous,id:provider.id,name:provider.name||provider.id,status:provider.enabled?previous.status==='error'?'error':'idle':'disabled'};
    jobs.set(provider.id,{provider,running:null,timer:null,controller:null,attempt:Number.isSafeInteger(previous.attempt)?previous.attempt:0,cursor:typeof previous.cursor==='string'?previous.cursor:null,state});
  }
  const day=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now()));
  async function persist(job){await onState?.({...job.state,cursor:job.cursor,attempt:job.attempt});}
  function schedule(job,delay){if(stopped||!job.provider.enabled)return;clearTimeout(job.timer);job.timer=setTimeout(()=>{void run(job).catch(()=>{});},delay);job.timer.unref?.();}
  function run(job){
    if(job.running)return job.running;
    if(!job.provider.enabled)return Promise.resolve({id:job.provider.id,status:'disabled'});
    if(Date.parse(job.state.nextAttemptAt)>now()){schedule(job,Math.max(1,Date.parse(job.state.nextAttemptAt)-now()));return Promise.resolve({id:job.provider.id,status:job.state.status});}
    job.running=(async()=>{
      const currentDay=day();if(job.state.day!==currentDay){job.state.day=currentDay;job.state.eventsToday=0;job.state.errorsToday=0;job.state.totalDelay=0;job.state.delayCount=0;job.state.averageDelay=null;}
      job.controller=new AbortController();const timeout=setTimeout(()=>job.controller?.abort(),20000);timeout.unref?.();
      job.state.status='running';job.state.lastFetch=new Date(now()).toISOString();job.state.nextAttemptAt=null;
      try{
        await persist(job);
        const result=await job.provider.fetchEvents({cursor:job.cursor,signal:job.controller.signal});
        if(!result||!Array.isArray(result.events)||result.events.length>100)throw Object.assign(Error('Invalid provider batch'),{code:'INVALID_BATCH'});
        if(result.cursor!==undefined&&result.cursor!==null&&(typeof result.cursor!=='string'||result.cursor.length>1000))throw Object.assign(Error('Invalid provider cursor'),{code:'INVALID_CURSOR'});
        const processed=await onEvents(result.events,{provider:job.provider.id,signal:job.controller.signal});
        job.cursor=result.cursor??null;job.attempt=0;job.state.status='online';job.state.lastSuccess=new Date(now()).toISOString();job.state.error=null;
        job.state.eventsToday+=processed?.inserted||0;
        const delays=processed?.delays||[];for(const value of delays)if(Number.isFinite(value)&&value>=0){job.state.totalDelay+=value;job.state.delayCount++;}
        job.state.averageDelay=job.state.delayCount?Math.round(job.state.totalDelay/job.state.delayCount):null;
      }catch(cause){
        job.attempt++;job.state.errorsToday++;job.state.status='error';job.state.error=typeof cause?.code==='string'&&/^[A-Z][A-Z0-9_]{1,63}$/.test(cause.code)?cause.code:job.controller.signal.aborted?'PROVIDER_TIMEOUT':'PROVIDER_FAILED';
      }finally{
        clearTimeout(timeout);job.controller=null;
        const delay=Math.min(900000,job.provider.interval*2**Math.min(job.attempt,8));job.state.nextAttemptAt=stopped?null:new Date(now()+delay).toISOString();
        try{await persist(job);}finally{schedule(job,delay);}
      }
      return {id:job.provider.id,status:job.state.status};
    })().finally(()=>{job.running=null;});return job.running;
  }
  return {
    async start(){if(!stopped)return;stopped=false;let failure;for(const job of jobs.values()){try{await persist(job);}catch(cause){failure??=cause;}finally{schedule(job,Math.max(0,Date.parse(job.state.nextAttemptAt)-now())||0);}}if(failure)throw failure;},
    async sync(){const results=await Promise.allSettled([...jobs.values()].map(job=>run(job)));return results.map((result,index)=>result.status==='fulfilled'?result.value:{id:[...jobs.keys()][index],status:'error'});},
    status:()=>[...jobs.values()].map(job=>structuredClone(job.state)),
    async close(){stopped=true;for(const job of jobs.values()){clearTimeout(job.timer);job.controller?.abort();}await Promise.allSettled([...jobs.values()].map(job=>job.running).filter(Boolean));}
  };
}
