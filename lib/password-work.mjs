import {scrypt} from 'node:crypto';
import {promisify} from 'node:util';
import {error} from './http.mjs';

const derive=promisify(scrypt);
const busy=()=>error(429,'Сервис входа занят. Подождите немного и повторите попытку.','PASSWORD_WORK_BUSY');

// Keep the existing password format and scrypt parameters. The process-wide
// budget prevents account requests from filling the shared libuv worker pool.
export function createPasswordWork({worker=derive,concurrency=2,maxQueue=8,timeoutMs=10000}={}){
 if(typeof worker!=='function'||!Number.isInteger(concurrency)||concurrency<1||!Number.isInteger(maxQueue)||maxQueue<0||!Number.isFinite(timeoutMs)||timeoutMs<1)throw Error('Invalid password work budget');
 let active=0;const waiting=[];
 function settle(task,cause,value){if(task.settled)return;task.settled=true;clearTimeout(task.timer);cause?task.reject(cause):task.resolve(value);}
 function drain(){while(active<concurrency&&waiting.length){const task=waiting.shift();if(!task.settled)start(task);}}
 function start(task){
  active++;
  const complete=(cause,value)=>{active--;settle(task,cause,value);drain();};
  Promise.resolve().then(()=>worker(...task.args)).then(value=>complete(null,value),cause=>complete(cause));
 }
 return (...args)=>{
  if(active>=concurrency&&waiting.length>=maxQueue)return Promise.reject(busy());
  return new Promise((resolve,reject)=>{
   const task={args,resolve,reject,settled:false,timer:null};
   task.timer=setTimeout(()=>{
    const index=waiting.indexOf(task);if(index>=0)waiting.splice(index,1);
    // Native crypto work cannot be cancelled. An expired active job retains its
    // slot until it actually settles, so timing out cannot exceed the budget.
    settle(task,busy());
   },timeoutMs);
   if(active<concurrency)start(task);else waiting.push(task);
  });
 };
}

export const derivePassword=createPasswordWork();
