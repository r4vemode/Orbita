import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createRadarJobs} from '../lib/radar/jobs.mjs';

const provider=(id,fetchEvents)=>({id,name:id,enabled:true,interval:1000,fetchEvents});

test('Radar startup persistence failure still schedules every independent source and retries the failed one',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});let failed=false;const fetched=[];
 const jobs=createRadarJobs({providers:['first','second'].map(id=>provider(id,async()=>{fetched.push(id);return {events:[]};})),onEvents:async()=>({inserted:0}),onState:async state=>{if(state.id==='first'&&!failed){failed=true;throw Error('temporary fixture storage failure');}}});
 try{
  await assert.rejects(jobs.start(),/temporary fixture storage failure/);
  t.mock.timers.tick(1);await nextTurn();assert.deepEqual([...fetched].sort(),['first','second']);
  assert.ok(jobs.status().every(state=>state.status==='online'));
 }finally{await jobs.close();}
});

test('Radar resumes automatic polling after the final provider-state write fails',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});let fetched=0,failed=false;
 const jobs=createRadarJobs({providers:[provider('source',async()=>{fetched++;return {events:[],cursor:'page-'+fetched};})],onEvents:async()=>({inserted:0}),onState:async state=>{if(state.status==='online'&&!failed){failed=true;throw Error('temporary fixture state write failure');}}});
 try{
  await jobs.start();t.mock.timers.tick(1);await nextTurn();assert.equal(fetched,1);
  t.mock.timers.tick(1001);await nextTurn();assert.equal(fetched,2,'A failed state write must not permanently stop automatic polling');
  assert.equal(jobs.status()[0].status,'online');
 }finally{await jobs.close();}
});
