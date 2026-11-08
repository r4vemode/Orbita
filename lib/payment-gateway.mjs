import {error} from './http.mjs';

export function cloudPaymentsGateway({publicId,apiSecret,fetchImpl=globalThis.fetch}){
  return async(method,payload,requestId)=>{
    if(!['subscriptions/create','subscriptions/get','subscriptions/find','subscriptions/cancel','payments/get','payments/refund'].includes(method))throw Error('Unsupported payment operation');
    let response;
    try{response=await fetchImpl('https://api.cloudpayments.ru/'+method,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',Authorization:'Basic '+Buffer.from(publicId+':'+apiSecret).toString('base64'),...(requestId?{'X-Request-ID':requestId}:{})},body:JSON.stringify(payload)});}
    catch{throw error(503,'Платёжный провайдер временно недоступен. Состояние операции будет проверено повторно.','PROVIDER_UNAVAILABLE');}
    if(!response.ok)throw error(503,'Платёжный провайдер временно недоступен.','PROVIDER_UNAVAILABLE');
    let result;
    try{
      if(response.body){let size=0,chunks=[];for await(const chunk of response.body){size+=chunk.length;if(size>262144)throw Error('oversize');chunks.push(chunk);}result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
      else result=await response.json();
    }catch{throw error(502,'Некорректный ответ платёжного провайдера.','PROVIDER_RESPONSE_INVALID');}
    if(result?.Success!==true)throw error(503,'Провайдер не подтвердил выполнение операции. Проверьте её состояние позже.','PROVIDER_OPERATION_UNCONFIRMED');
    return result.Model??null;
  };
}
