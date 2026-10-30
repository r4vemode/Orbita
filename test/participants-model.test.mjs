import test from 'node:test';
import assert from 'node:assert/strict';
import {PARTICIPANT_CATALOG,positionSnapshot,issRows,normalizeIndexMembership,buildCoverage,normalizeFutoiResponse} from '../lib/participants-model.mjs';

const receivedAt='2026-10-30T10:01:00.000Z';
const now=()=>Date.parse(receivedAt);
const coverage=()=>buildCoverage([{assetcode:'SBER',sectype:'SR'}]);
const row=(clgroup,changes={})=>({ticker:'SR',clgroup,sess_id:100,seqnum:42,tradedate:'2026-10-30',tradetime:'13:00:00',trade_session_date:'2026-10-30',pos_long:clgroup==='YUR'?300:700,pos_short:clgroup==='YUR'?-650:-350,pos:clgroup==='YUR'?-350:350,...changes});
const normalize=(rows,options={})=>normalizeFutoiResponse(rows,{coverage:coverage(),receivedAt,now,...options});
const snapshot=changes=>positionSnapshot({symbol:'SBER',futuresCode:'SR',legal:{long:300,short:650},individual:{long:700,short:350},dataAsOf:'2026-10-30T10:00:00.000Z',receivedAt,...changes});
const table=(columns,data,block='futoi')=>({[block]:{columns,data}});

test('position shares use contracts within each direction, not numbers of people',()=>{
 const value=snapshot();
 assert.deepEqual(value.longShares,{legal:30,individual:70});
 assert.deepEqual(value.shortShares,{legal:65,individual:35});
 assert.deepEqual(value.net,{legal:-350,individual:350});
 assert.equal(value.totalLong,1000);assert.equal(value.totalShort,1000);
 assert.equal(value.market,'futures');assert.equal(value.unit,'contracts');assert.equal(value.countMetrics,null);assert.equal(value.status,'complete');
});

test('missing categories, empty positions and unbalanced snapshots never invent percentages',()=>{
 const missing=snapshot({individual:{}});
 assert.equal(missing.status,'incomplete');assert.equal(missing.totalLong,null);
 assert.deepEqual(missing.longShares,{legal:null,individual:null});assert.deepEqual(missing.shortShares,{legal:null,individual:null});
 const empty=snapshot({legal:{long:0,short:0},individual:{long:0,short:0}});
 assert.equal(empty.status,'empty');assert.deepEqual(empty.longShares,{legal:null,individual:null});
 const unbalanced=snapshot({legal:{long:301,short:650}});
 assert.equal(unbalanced.status,'unbalanced');assert.equal(unbalanced.totalLong,1001);
 assert.deepEqual(unbalanced.longShares,{legal:null,individual:null});assert.deepEqual(unbalanced.shortShares,{legal:null,individual:null});
});

test('official signed shorts are normalized and source market time ignores backfill systime',()=>{
 const value=normalize([row('YUR',{systime:'2027-01-01 00:00:00',pos_short_num:2}),row('FIZ',{systime:'2027-01-01 00:00:00',pos_long_num:999})])[0];
 assert.equal(value.symbol,'SBER');assert.equal(value.futuresCode,'SR');assert.equal(value.dataAsOf,'2026-10-30T10:00:00.000Z');
 assert.equal(value.legal.short,650);assert.equal(value.shortShares.legal,65);assert.equal(value.longShares.individual,70);assert.equal(value.countMetrics,null);
});

test('short signs, inconsistent net positions and unsafe amounts fail closed',()=>{
 for(const changes of [{pos_short:650},{pos:99},{pos_long:-1},{pos_short:-1.5},{pos_long:'300'},{pos_long:Number.MAX_SAFE_INTEGER+1}])assert.throws(()=>normalize([row('YUR',changes),row('FIZ')]),{code:'MOEX_INVALID_POSITIONS'});
 assert.throws(()=>snapshot({legal:{long:Number.MAX_SAFE_INTEGER,short:0},individual:{long:1,short:0}}),{code:'MOEX_INVALID_POSITIONS'});
});

test('categories from different sessions, revisions, market times and trading dates cannot be paired',()=>{
 for(const changes of [{sess_id:101},{seqnum:43},{tradetime:'13:00:01'},{tradedate:'2026-10-29'},{trade_session_date:'2026-10-31'}]){
  const value=normalize([row('YUR'),row('FIZ',changes)])[0];
  assert.equal(value.status,'incomplete');assert.deepEqual(value.longShares,{legal:null,individual:null});assert.deepEqual(value.shortShares,{legal:null,individual:null});
 }
});

test('latest incomplete revision is disclosed instead of blending with an older complete pair',()=>{
 const value=normalize([row('YUR'),row('FIZ'),row('YUR',{seqnum:43,tradetime:'13:00:01',pos_long:310,pos:-340})])[0];
 assert.equal(value.status,'incomplete');assert.equal(value.legal.long,310);assert.equal(value.individual.long,null);assert.equal(value.dataAsOf,'2026-10-30T10:00:01.000Z');
});

test('identical repeated groups are idempotent and conflicting repeats are rejected',()=>{
 assert.equal(normalize([row('YUR'),row('YUR'),row('FIZ')]).length,1);
 assert.throws(()=>normalize([row('YUR'),row('YUR',{pos_long:301,pos:-349}),row('FIZ')]),{code:'MOEX_CONFLICTING_SNAPSHOT'});
});

test('invalid calendar dates, overflowing clock values and future source times are rejected',()=>{
 for(const changes of [{tradedate:'2026-02-30'},{tradetime:'24:00:00'},{tradetime:'13:60:00'},{tradetime:'13:00:60'}])assert.throws(()=>normalize([row('YUR',changes)]),{code:'MOEX_INVALID_TIME'});
 assert.throws(()=>normalize([row('YUR',{tradetime:'14:00:00'})]),{code:'MOEX_FUTURE_SNAPSHOT'});
 for(const changes of [{sess_id:-1},{seqnum:NaN},{trade_session_date:'2026-02-30'}])assert.throws(()=>normalize([row('YUR',changes)]),{code:'MOEX_INVALID_SNAPSHOT'});
 assert.throws(()=>snapshot({dataAsOf:'2026-02-30T10:00:00Z'}),{code:'MOEX_INVALID_SNAPSHOT'});
 assert.throws(()=>snapshot({receivedAt:'2026-10-30T24:00:00Z'}),{code:'MOEX_INVALID_SNAPSHOT'});
});

test('unknown futures and unsupported participant categories produce no invented coverage',()=>{
 assert.deepEqual(normalize([row('YUR',{ticker:'UNKNOWN'}),row('FIZ',{ticker:'UNKNOWN'})]),[]);
 assert.deepEqual(normalize([row('OTHER')]),[]);
 assert.deepEqual(normalize([row('YUR'),row('FIZ')],{coverage:buildCoverage([])}),[]);
});

test('reference mapping is dynamic and repeated expiries do not duplicate one underlying',()=>{
 const values=buildCoverage([{assetcode:'YDEX',sectype:'YD',secid:'YDH7'},{assetcode:'YDEX',sectype:'YD',secid:'YDM7'},{assetcode:'SBER',sectype:'SR'}]);
 assert.equal(values.find(item=>item.symbol==='YDEX').futuresCode,'YD');
 assert.equal(values.filter(item=>item.symbol==='YDEX').length,1);
 const normalized=normalize([row('YUR',{ticker:'YD'}),row('FIZ',{ticker:'YD'})],{coverage:values});
 assert.equal(normalized.length,1);assert.equal(normalized[0].symbol,'YDEX');
 assert.equal(buildCoverage([{assetcode:'MIX',sectype:'MX'}]).find(item=>item.symbol==='IMOEX').futuresCode,'MX');
});

test('ambiguous futures families are unavailable and the initial catalog does not claim index membership',()=>{
 const value=buildCoverage([{assetcode:'YDEX',sectype:'YN'},{assetcode:'YDEX',sectype:'YD'}]).find(item=>item.symbol==='YDEX');
 assert.equal(value.futuresCode,null);assert.equal(value.coverage,'unavailable');assert.equal(value.coverageReason,'ambiguous-futures-family');
 for(const item of buildCoverage())assert.deepEqual(item.indexMembership,{verified:false,asOf:null,inIndex:null});
 assert.equal(PARTICIPANT_CATALOG.find(item=>item.symbol==='SBER').futuresCode,null);
});

test('dated index composition filters historical intervals and adds uncovered members honestly',()=>{
 const membership=normalizeIndexMembership(table(['ticker','from','till'],[
  ['SBER','2020-01-01',null],['AFLT','2026-10-30','2026-10-30'],['SBER','2020-01-01',null],['OLD','2020-01-01','2026-10-29'],['NEXT','2026-10-31',null]
 ],'tickers'),'2026-10-30',receivedAt);
 assert.deepEqual(membership.tickers,['AFLT','SBER']);assert.equal(membership.verified,true);assert.match(membership.sourceUrl,/\?date=2026-10-30$/);
 const values=buildCoverage([{assetcode:'SBER',sectype:'SR'}],membership);
 assert.deepEqual(values.find(item=>item.symbol==='SBER').indexMembership,{verified:true,asOf:'2026-10-30',inIndex:true});
 assert.equal(values.find(item=>item.symbol==='AFLT').coverage,'unavailable');
 assert.equal(values.find(item=>item.symbol==='LKOH').indexMembership.inIndex,false);
});

test('empty, malformed and invalid-date index membership is not marked verified',()=>{
 const valid=table(['ticker','from','till'],[['SBER','2020-01-01',null]],'tickers');
 assert.throws(()=>normalizeIndexMembership(valid,'2026-02-30',receivedAt),{code:'MOEX_INVALID_MEMBERSHIP'});
 assert.throws(()=>normalizeIndexMembership(table(['ticker'],[],'tickers'),'2026-10-30',receivedAt),{code:'MOEX_NO_MEMBERSHIP'});
 for(const data of [[['SBER','2026-02-30',null]],[['SBER','2026-10-31','2026-10-29']],[['<img>','2020-01-01',null]]])assert.throws(()=>normalizeIndexMembership(table(['ticker','from','till'],data,'tickers'),'2026-10-30',receivedAt),{code:'MOEX_INVALID_MEMBERSHIP'});
 assert.throws(()=>buildCoverage([],{verified:true,asOf:'2026-10-30',tickers:['<img>']}),{code:'MOEX_INVALID_MEMBERSHIP'});
 assert.throws(()=>buildCoverage([null]),{code:'MOEX_INVALID_REFERENCE'});
});

test('ISS tables support official uppercase columns but reject duplicate, ragged and oversized data',()=>{
 assert.deepEqual(issRows(table(['TICKER','CLGROUP'],[['SR','YUR']]),'futoi'),[{ticker:'SR',clgroup:'YUR'}]);
 for(const payload of [null,table(['ticker','TICKER'],[['SR','SR']]),table(['ticker'],[[]]),table(['bad column'],[['x']]),table(['ticker'],Array(20001).fill(['SR']))])assert.throws(()=>issRows(payload,'futoi'),{code:'MOEX_INVALID_RESPONSE'});
 assert.throws(()=>normalizeFutoiResponse(Array(20001).fill(row('YUR')),{coverage:coverage(),receivedAt,now}),{code:'MOEX_RESPONSE_LIMIT'});
 assert.throws(()=>normalize([null]),{code:'MOEX_INVALID_RESPONSE'});
});

test('canonical snapshots reject unsafe symbols, unsupported groups and fractional quantities',()=>{
 for(const changes of [{symbol:'<img>'},{underlyingTicker:'../SBER'},{futuresCode:'x'.repeat(31)},{group:'spot'},{name:'bad\nname'},{legal:{long:1.5,short:650}}])assert.throws(()=>snapshot(changes));
});
