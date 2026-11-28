import assert from 'node:assert/strict';
import test from 'node:test';
import {createIdeaStream} from '../lib/idea-stream.mjs';
import {startLocalBeta} from '../scripts/beta-local.mjs';
import {serviceFixture} from './service-fixture.mjs';

const streamPath = '/api/ideas/stream';
const ready = 'retry: 8000\nevent: ready\ndata: {}\n\n';
const updated = 'event: ideas-update\ndata: {}\n\n';

function frames(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let remaining = '';
  return async () => {
    for (;;) {
      const boundary = remaining.indexOf('\n\n');
      if (boundary >= 0) {
        const frame = remaining.slice(0, boundary + 2);
        remaining = remaining.slice(boundary + 2);
        if (!frame.startsWith(':')) return frame;
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) return null;
      remaining += decoder.decode(chunk.value, {stream:true});
    }
  };
}

test('the app delivers protected idea invalidations without occupying its ordinary HTTP request slots', {timeout:15000}, async () => {
  const beta = await startLocalBeta();
  const controller = new AbortController();
  try {
    const get = (path, cookie) => fetch(beta.base + path, {
      headers:cookie ? {Cookie:cookie} : {},
      signal:AbortSignal.any([controller.signal, AbortSignal.timeout(6500)])
    });
    const post = (path, body, cookie) => fetch(beta.base + path, {
      method:'POST', headers:{Origin:beta.base,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},
      body:JSON.stringify(body)
    });
    const signedIn = {};
    for (const [role, credentials] of beta.accounts.map(account => [account.role, account])) {
      const {email, password} = credentials;
      const response = await post('/api/login', {email, password});
      assert.equal(response.status, 200);
      signedIn[role] = {cookie:response.headers.get('set-cookie').split(';')[0],account:(await response.json()).user};
    }

    assert.equal((await get(streamPath)).status, 401);
    assert.equal((await get(streamPath, signedIn.free.cookie)).status, 403);
    const clients = [];
    for (const role of ['pro', 'exclusive', 'admin']) {
      const {cookie} = signedIn[role];
      for (let i = 0; i < 3; i++) {
        const stream = await get(streamPath, cookie);
        assert.equal(stream.status, 200);
        assert.match(stream.headers.get('content-type'), /^text\/event-stream/);
        assert.match(stream.headers.get('cache-control'), /no-store/);
        assert.equal(stream.headers.get('x-accel-buffering'), 'no');
        assert.equal(stream.headers.get('vary'), 'Cookie');
        const next = frames(stream);
        assert.equal(await next(), ready);
        clients.push({role,next});
      }
    }
    assert.equal((await get(streamPath, signedIn.pro.cookie)).status, 429);

    const before = Date.now();
    const response = await get('/api/ideas', signedIn.pro.cookie);
    assert.equal(response.status, 200);
    const feed = await response.json();
    assert.equal(feed.viewerId, signedIn.pro.account.id);
    assert.ok(Number.isSafeInteger(feed.observedAt) && feed.observedAt >= before && feed.observedAt <= Date.now());

    const created = await post('/api/admin/ideas', {mode:'quick', d:{ticker:'SBER',dir:'ЛОНГ'}}, signedIn.admin.cookie);
    assert.equal(created.status, 201);
    assert.deepEqual(await Promise.all(clients.map(client => client.next())), clients.map(() => updated));

    const revoked = await post('/api/admin/subscriptions', {
      userId:signedIn.pro.account.id, plan:'pro', expiresAt:null, reason:'Завершение тестовой подписки.'
    }, signedIn.admin.cookie);
    assert.equal(revoked.status, 200);
    assert.equal((await post('/api/admin/ideas', {mode:'quick', d:{ticker:'GAZP',dir:'ЛОНГ'}}, signedIn.admin.cookie)).status, 201);
    for (const client of clients) assert.equal(await client.next(), client.role === 'pro' ? null : updated);
    assert.equal((await get('/api/ideas', signedIn.pro.cookie)).status, 403);
  } finally {
    controller.abort();
    await beta.close();
  }
});

test('idea stream heartbeat revokes idle sessions and returns the shared stream capacity', {timeout:7000}, async () => {
  const fixture = await serviceFixture(({accounts, ideas}) => {
    const stream = createIdeaStream({accounts, ideas, heartbeatMs:25, lifetimeMs:5000, maxConnections:1});
    return {
      webhookPaths:[],
      async handle(req, res, url, user) {
        if (url.pathname !== streamPath) return false;
        await stream.open(req, res, user);
        return true;
      },
      close:stream.close
    };
  });
  const controller = new AbortController();
  try {
    const first = await fixture.register('first@idea-stream.example.test');
    const second = await fixture.register('second@idea-stream.example.test');
    await fixture.accounts.promote(first.data.user.email);
    await fixture.accounts.promote(second.data.user.email);
    const open = cookie => fetch(fixture.base + streamPath, {
      headers:{Cookie:cookie},
      signal:AbortSignal.any([controller.signal, AbortSignal.timeout(4000)])
    });
    const initial = await open(first.cookie);
    assert.equal(initial.status, 200);
    const next = frames(initial);
    assert.equal(await next(), ready);
    assert.equal((await open(second.cookie)).status, 429);

    const logout = await fixture.request('/api/logout', {method:'POST',cookie:first.cookie});
    assert.equal(logout.status, 200);
    assert.equal(await next(), null);
    const replacement = await open(second.cookie);
    assert.equal(replacement.status, 200);
    const replacementNext = frames(replacement);
    assert.equal(await replacementNext(), ready);
    fixture.service.close();
    assert.equal(await replacementNext(), null);
  } finally {
    controller.abort();
    await fixture.close();
  }
});
