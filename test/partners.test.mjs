import test from 'node:test';
import assert from 'node:assert/strict';
import {safePartnerUrl,normalisePartnerOffers} from '../public/assets/brokers.js';
test('partner links accept HTTPS referrals and reject unsafe or credential-bearing addresses',()=>{
 assert.equal(safePartnerUrl('https://example.com/open?ref=orbita'),'https://example.com/open?ref=orbita');
 for(const url of ['',null,'javascript:alert(1)','http://example.com','https://user:password@example.com'])assert.equal(safePartnerUrl(url),null);
 const rows=normalisePartnerOffers([{name:'',url:'',markets:['stocks','unknown','stocks']}]);assert.deepEqual(rows[0].markets,['stocks']);assert.equal(rows[0].url,null);
});
