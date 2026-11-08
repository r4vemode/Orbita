import {createHash} from 'node:crypto';
import '../public/assets/backtest-engine.js';
const engine=globalThis.OrbitaBacktest;
export const {validate,example,ENGINE_VERSION}=engine;
export function runBacktest(input){
 const bytes=typeof input==='string'?input:JSON.stringify(input);
 if(Buffer.byteLength(bytes)>16*1024*1024)throw Error('Файл бэктеста превышает 16 МиБ.');
 const document=typeof input==='string'?JSON.parse(input):input;
 return {...engine.run(document),provenance:{algorithm:'sha256',inputSha256:createHash('sha256').update(bytes).digest('hex'),scope:typeof input==='string'?'exact-input-utf8':'JSON.stringify(input)',verification:'operator-supplied-unverified'}};
}
