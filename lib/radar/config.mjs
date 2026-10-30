const boolean=(env,name,fallback)=>{
  const value=env[name];if(value===undefined||value==='')return fallback;
  if(value==='true'||value==='1')return true;if(value==='false'||value==='0')return false;
  throw Error(name+': используйте true или false.');
};
const integer=(env,name,fallback,min,max)=>{
  const value=env[name];if(value===undefined||value==='')return fallback;
  if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<min||Number(value)>max)throw Error(name+': некорректное значение.');
  return Number(value);
};
export function radarConfiguration(env=process.env){
  const mode=env.RADAR_PROVIDER_MODE||'off';if(!['off','mock','live'].includes(mode))throw Error('RADAR_PROVIDER_MODE: используйте off, mock или live.');
  const allowedPlans=(env.RADAR_ALLOWED_PLANS||'pro').split(',').map(value=>value.trim());
  if(!allowedPlans.length||new Set(allowedPlans).size!==allowedPlans.length||allowedPlans.some(value=>!['pro','exclusive'].includes(value)))throw Error('RADAR_ALLOWED_PLANS: используйте pro и/или exclusive.');
  return Object.freeze({enabled:boolean(env,'RADAR_ENABLED',true),aiEnabled:boolean(env,'RADAR_AI_ENABLED',false),notificationsEnabled:boolean(env,'RADAR_NOTIFICATIONS_ENABLED',false),marketReactionEnabled:boolean(env,'RADAR_MARKET_REACTION_ENABLED',true),freeEnabled:boolean(env,'RADAR_FREE_ENABLED',false),freeDelaySeconds:integer(env,'RADAR_FREE_DELAY_SECONDS',900,60,86400),freeLimit:integer(env,'RADAR_FREE_LIMIT',5,1,10),allowedPlans:Object.freeze(allowedPlans),mode});
}
