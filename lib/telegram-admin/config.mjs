const fail=()=>{throw Object.assign(Error('Проверьте TELEGRAM_ADMIN_*: отдельный токен, username, secret, HTTPS-адрес и срок черновика.'),{code:'TELEGRAM_ADMIN_CONFIGURATION'});};
export function telegramAdminConfiguration(env=process.env){
 const flag=env.TELEGRAM_ADMIN_BOT_ENABLED??'false';
 if(!['true','false','1','0'].includes(flag))fail();
 const enabled=['true','1'].includes(flag),botToken=env.TELEGRAM_ADMIN_BOT_TOKEN||'',botUsername=(env.TELEGRAM_ADMIN_BOT_USERNAME||'').replace(/^@/,''),webhookSecret=env.TELEGRAM_ADMIN_WEBHOOK_SECRET||'';
 const minutes=env.TELEGRAM_ADMIN_DRAFT_TTL_MINUTES??'30';
 if(!/^\d{1,3}$/.test(minutes)||Number(minutes)<1||Number(minutes)>120)fail();
 let publicOrigin=null;
 try{const url=new URL(env.ORBITA_PUBLIC_ORIGIN||'');if(url.protocol==='https:'&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash)publicOrigin=url.origin;}catch{}
 const valid=/^\d{5,20}:[A-Za-z0-9_-]{20,}$/.test(botToken)&&/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(botUsername)&&/^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret)&&!!publicOrigin;
 if(enabled&&(!valid||botToken===env.TELEGRAM_BOT_TOKEN))fail();
 return Object.freeze({enabled,configured:enabled&&valid,botToken,botUsername:/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(botUsername)?botUsername:null,webhookSecret,publicOrigin,draftTtlMs:Number(minutes)*60000});
}
