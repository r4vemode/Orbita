import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const source = await readFile(new URL('../public/assets/subscriptions.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const key = 'orbita.checkout.v1.test-user';
const makeOrder = (plan, status = 'pending', id = 'order-' + randomUUID()) => ({ id, plan, status, amount: plan === 'pro' ? 2999 : 4999, currency: 'RUB', checkoutUrl: 'https://orders.cloudpayments.ru/orders/' + id });

async function page({ storage = new Map(), search = '?plan=pro', checkout, orders = new Map(), preferred = null, verified = true } = {}) {
  const nodes = new Map(), listeners = {}, calls = [], remembered = [], navigation = [];
  const element = () => ({ hidden: false, disabled: false, textContent: '', scrollIntoView() {}, removeAttribute(name) { delete this[name]; } });
  const node = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const cards = ['pro', 'exclusive'].map(plan => ({ dataset: { plan }, classList: { toggle() {} }, querySelector: selector => node(plan + ':' + selector) }));
  const buttons = ['pro', 'exclusive'].map(plan => Object.assign(node(plan + ':[data-select]'), { dataset: { select: plan } }));
  const user = { id: 'test-user', email: 'test@example.test', emailVerified: verified, subscriptions: [], access: { hasSubscription: false } };
  const A = {
    plans: { pro: { name: 'Orbita Pro', price: 2999 }, exclusive: { name: 'Orbita Exclusive', price: 4999 } },
    current: async () => user, preferredPlan: () => preferred, rememberPlan: (...args) => remembered.push(args),
    request: async (url, options = {}) => {
      if (url === '/api/public-config') return { paymentsAvailable: true, mailEnabled: true };
      if (url === '/api/payments/config') return { configured: true, provider: 'cloudpayments' };
      if (url === '/api/payments/checkout') { const body = JSON.parse(options.body); calls.push(body); return checkout ? checkout(body, calls.length) : { order: makeOrder(body.plan) }; }
      if (url.startsWith('/api/payments/orders/')) {
        const order = orders.get(url.split('/').at(-1));
        if (!order) throw Object.assign(Error('Not found'), { status: 404 });
        return { order };
      }
      throw Error('Unexpected request: ' + url);
    }
  };
  const context = vm.createContext({
    OrbitaAccess: A, URL, URLSearchParams, AbortController, crypto: { randomUUID },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    location: { search, assign: url => navigation.push(url), replace: url => navigation.push(url) },
    document: { hidden: false, getElementById: node, querySelectorAll: selector => selector === '[data-plan]' ? cards : buttons, addEventListener: (name, listener) => { listeners[name] = listener; } },
    window: { addEventListener() {} }, setTimeout: () => 1, clearTimeout() {}
  });
  await vm.runInContext(source, context); await flush();
  return { node, buttons, calls, storage, navigation, remembered, listeners, user, choose: async plan => { buttons.find(button => button.dataset.select === plan).onclick(); await flush(); }, start: async () => { await node('createCheckout').onclick(); await flush(); } };
}

test('pending Pro does not block Exclusive; selecting Pro again restores its exact order and request', async () => {
  const orders = new Map(), p = await page({ orders, checkout: body => { const order = makeOrder(body.plan); orders.set(order.id, order); return { order }; } });
  await p.start();
  const pro = p.calls[0], proId = JSON.parse(p.storage.get(key)).requests.pro.orderId;
  assert.equal(p.node('createCheckout').disabled, true);
  await p.choose('exclusive');
  assert.equal(p.node('createCheckout').disabled, false);
  assert.equal(p.node('paymentOrder').hidden, true);
  assert.equal(p.node('verifyEmailLink').href, 'security.html?verify=1&plan=exclusive');
  await p.start();
  assert.equal(p.calls[1].plan, 'exclusive'); assert.notEqual(p.calls[1].requestId, pro.requestId);
  await p.choose('pro');
  assert.match(p.node('paymentOrderReference').textContent, new RegExp(proId));
  assert.equal(p.node('createCheckout').disabled, true);
  assert.equal(JSON.parse(p.storage.get(key)).requests.pro.requestId, pro.requestId);
  assert.deepEqual(p.remembered.at(-1), ['test-user', 'pro']);
  const reloaded = await page({ storage: p.storage, search: '', orders });
  assert.match(reloaded.node('paymentOrderReference').textContent, new RegExp(proId));
  assert.equal(reloaded.node('checkoutTitle').textContent, 'Orbita Pro');
  await reloaded.choose('exclusive');
  assert.match(reloaded.node('paymentOrderReference').textContent, /Orbita Exclusive/);
  assert.equal(reloaded.node('createCheckout').disabled, true);
});

test('unknown responses retain one request per tariff through switching and reload', async () => {
  const p = await page({ checkout: () => { throw Error('Connection interrupted'); } });
  await p.start(); const proId = p.calls[0].requestId;
  await p.choose('exclusive'); assert.equal(p.node('createCheckout').disabled, false);
  await p.start(); const exclusiveId = p.calls[1].requestId;
  await p.choose('pro'); await p.start(); assert.equal(p.calls[2].requestId, proId);
  const next = await page({ storage: p.storage, search: '?plan=exclusive', checkout: () => { throw Error('Still unavailable'); } });
  await next.start(); assert.equal(next.calls[0].requestId, exclusiveId);
  await next.choose('pro'); await next.start(); assert.equal(next.calls[1].requestId, proId);
});

test('in-flight checkout freezes switching and paid renewal requires an explicit new payment', async () => {
  let finish;
  const result = new Promise(resolve => { finish = resolve; });
  const p = await page({ checkout: () => result });
  const pending = p.start();
  assert.ok(p.buttons.every(button => button.disabled));
  await p.choose('exclusive'); assert.equal(p.node('checkoutTitle').textContent, 'Orbita Pro');
  finish({ order: makeOrder('pro', 'paid') }); await pending;
  assert.equal(p.node('createCheckout').disabled, true); assert.equal(p.node('newPayment').hidden, false);
  const first = p.calls[0].requestId;
  await p.choose('exclusive'); await p.choose('pro'); await p.start(); assert.equal(p.calls.length, 1);
  p.node('newPayment').onclick(); assert.equal(p.node('createCheckout').disabled, false);
  await p.start(); assert.equal(p.calls.length, 2); assert.notEqual(p.calls[1].requestId, first);
});

test('old return links cannot replace a newer unresolved request; old storage and preferred plan remain usable', async () => {
  const pending = { plan: 'exclusive', requestId: randomUUID(), orderId: null }, storage = new Map([[key, JSON.stringify(pending)]]);
  const old = makeOrder('exclusive', 'paid'), orders = new Map([[old.id, old]]);
  const p = await page({ storage, search: '?paymentOrder=' + old.id, orders, checkout: () => { throw Error('Unknown outcome'); } });
  assert.match(p.node('subscriptionError').textContent, /другой запрос/);
  await p.start(); assert.equal(p.calls[0].requestId, pending.requestId);
  assert.equal(JSON.parse(storage.get(key)).requests.exclusive.requestId, pending.requestId);
  const preferred = await page({ search: '', preferred: 'exclusive', verified: false });
  assert.equal(preferred.node('checkoutTitle').textContent, 'Orbita Exclusive');
  assert.equal(preferred.node('createCheckout').disabled, true);
  assert.equal(preferred.node('verifyEmailLink').href, 'security.html?verify=1&plan=exclusive');
});

test('returning creating order without its original request allows status checks but cannot create a duplicate checkout', async () => {
  const order = makeOrder('pro', 'creating'), orders = new Map([[order.id, order]]);
  const p = await page({ search: '?paymentOrder=' + order.id, orders });
  assert.equal(p.node('createCheckout').disabled, true);
  assert.match(p.node('checkoutMessage').textContent, /исходный запрос не сохранился/);
  assert.equal(p.node('recheckPayment').disabled, false);
  await p.start(); assert.equal(p.calls.length, 0);
  await p.node('recheckPayment').onclick(); assert.equal(p.calls.length, 0);
  await p.choose('exclusive'); assert.equal(p.node('createCheckout').disabled, false);
  await p.choose('pro'); assert.equal(p.node('createCheckout').disabled, true);
  await p.start(); assert.equal(p.calls.length, 0);
});
