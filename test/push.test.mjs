import test from 'node:test';
import assert from 'node:assert/strict';
import {createECDH,createDecipheriv,hkdfSync,verify,createPublicKey} from 'node:crypto';
import {encryptPayload,vapidKeys,vapidHeader,validEndpoint} from '../lib/push.mjs';

test('RFC 8291 Appendix A test vector: aes128gcm body matches byte for byte',()=>{
 const body=encryptPayload('When I grow up, I want to be a watermelon',{p256dh:'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',auth:'BTBZMqHH6r4Tts7J_aSIgg'},{asPrivate:'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',salt:Buffer.from('DGv6ra1nlYgDCS1FRnbzlw','base64url')});
 assert.equal(body.toString('base64url'),'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('a browser-side decrypt recovers the payload; VAPID JWT verifies with the public key',()=>{
 const ua=createECDH('prime256v1');ua.generateKeys();const auth=Buffer.alloc(16,7);
 const body=encryptPayload('{"title":"SBER"}',{p256dh:ua.getPublicKey().toString('base64url'),auth:auth.toString('base64url')});
 const salt=body.subarray(0,16),idlen=body[20],asPublic=body.subarray(21,21+idlen),ct=body.subarray(21+idlen);
 const ikm=Buffer.from(hkdfSync('sha256',ua.computeSecret(asPublic),auth,Buffer.concat([Buffer.from('WebPush: info\0'),ua.getPublicKey(),asPublic]),32));
 const d=createDecipheriv('aes-128-gcm',Buffer.from(hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: aes128gcm\0'),16)),Buffer.from(hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: nonce\0'),12)));d.setAuthTag(ct.subarray(-16));
 const plain=Buffer.concat([d.update(ct.subarray(0,-16)),d.final()]);assert.equal(plain.subarray(0,-1).toString(),'{"title":"SBER"}');assert.equal(plain.at(-1),2);
 const keys=vapidKeys(),h=vapidHeader('https://fcm.googleapis.com/fcm/send/abc',keys,'https://orbita.example');
 const [,jwt,k]=h.match(/^vapid t=([^,]+), k=(.+)$/);assert.equal(k,keys.publicKey);const [a,b,sig]=jwt.split('.');
 assert.equal(JSON.parse(Buffer.from(b,'base64url')).aud,'https://fcm.googleapis.com');
 const raw=Buffer.from(keys.publicKey,'base64url'),pub=createPublicKey({key:{kty:'EC',crv:'P-256',x:raw.subarray(1,33).toString('base64url'),y:raw.subarray(33).toString('base64url')},format:'jwk'});
 assert.ok(verify('sha256',Buffer.from(a+'.'+b),{key:pub,dsaEncoding:'ieee-p1363'},Buffer.from(sig,'base64url')));
});

test('only real browser push services are accepted as endpoints (no SSRF)',()=>{
 for(const ok of ['https://fcm.googleapis.com/fcm/send/x','https://updates.push.services.mozilla.com/wpush/v2/x','https://web.push.apple.com/Q','https://wns2-par02p.notify.windows.com/w/?token=x'])assert.equal(validEndpoint(ok),true,ok);
 for(const bad of ['http://fcm.googleapis.com/x','https://169.254.169.254/latest','https://evil.example/fcm.googleapis.com','https://fcm.googleapis.com.evil.example/x','https://user:pw@fcm.googleapis.com/x'])assert.equal(validEndpoint(bad),false,bad);
});
