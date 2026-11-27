import {error} from '../http.mjs';

const audiences={all:'Все',pro:'PRO и EXCLUSIVE',exclusive:'Только EXCLUSIVE'};
const choose={bcAll:'all',bcPro:'pro',bcExclusive:'exclusive'};
const cancel={text:'Отмена',action:'cancel'};
const screen=(step,text,rows,extra={})=>({session:{type:'editor-content',section:'broadcast',step,...extra},text,rows});

export function createTelegramDeliveryWorkflow({notifications,store,publicOrigin}={}){
  if(!notifications?.enqueueBroadcast||!notifications?.statistics)return null;
  const destination=new URL('/telegram-admin.html#broadcast',publicOrigin).href;
  return {async handle({user,session,command,text,action,operationId,authorize}){
    if(action==='stats'||command==='stats'){
      await authorize();
      const result=await notifications.statistics();
      const lines=[
        'ORBITA · Доставка',
        `В очереди: ${result.pending}. Старейшая задача: ${result.oldestPendingSeconds} с.`,
        `Подтверждено Telegram API: ${result.telegramSent}. Ошибки: ${result.failed}. Бот заблокирован: ${result.blocked}.`,
        ...result.broadcasts.map(batch=>`Рассылка: аудитория ${batch.planned} · отправлено ${batch.sent} · ошибки ${batch.failed} · блокировки ${batch.blocked}`)
      ];
      if(result.lastSuccess)lines.splice(3,0,'Последняя отправка: '+new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'short'}).format(new Date(result.lastSuccess))+' МСК');
      return {text:lines.join('\n'),backToMenu:true};
    }
    if(action==='broadcast'||command==='broadcast'){
      return screen('audience','Рассылка редакции · выберите аудиторию. Получатели должны разрешить уведомления о материалах.',[
        [{text:'Все',action:'bcAll'}],
        [{text:'PRO и выше',action:'bcPro'},{text:'Только EXCLUSIVE',action:'bcExclusive'}],[cancel]
      ]);
    }
    if(session?.section!=='broadcast')return null;
    if(session.step==='audience'&&Object.hasOwn(choose,action)){
      const audience=choose[action];
      return screen('text','Аудитория · '+audiences[audience]+'\nОтправьте текст рассылки, до 3 000 символов.',[[cancel]],{audience});
    }
    if(session.step==='text'&&typeof text==='string'&&text.trim()){
      if(text.length>3000)throw error(400,'Сократите текст до 3 000 символов.');
      const message=text.trim(),audience=session.audience;
      return screen('confirm',`Предпросмотр · ${audiences[audience]}\n\n${message}\n\nПодтвердите полномочия на сайте, затем отправьте рассылку.`,[
        [{text:'Подтвердить на сайте ↗',url:destination}],
        [{text:'Поставить в очередь',action:'bcConfirm'},cancel]
      ],{message,audience});
    }
    if(session.step==='confirm'&&action==='bcConfirm'){
      const issue=await authorize();
      const authorizeBroadcast=async()=>{
        const current=await authorize();
        await store.useBroadcastGrant(current,operationId);
        return current;
      };
      const result=await notifications.enqueueBroadcast({owner:issue,operationId,audience:session.audience,text:session.message,authorize:authorizeBroadcast});
      await store.audit(issue,'broadcast-queued',null,{id:result.id,planned:result.planned,audience:session.audience});
      return {text:`Рассылка поставлена в очередь. Получателей: ${result.planned}.`,backToMenu:true};
    }
    return null;
  }};
}
