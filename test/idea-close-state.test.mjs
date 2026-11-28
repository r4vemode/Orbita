import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../public/assets/idea-close-state.js', import.meta.url), 'utf8');
const at = Date.parse('2026-11-28T10:00:00Z');
const iso = offset => new Date(at + offset).toISOString();
const closed = (id, tier = 'pro', fields = {}) => ({
  id, tier, published:true,
  d:{state:'closed', ticker:'SBER', dir:'ЛОНГ', entry:100},
  meta:{closedAt:iso(3000), exit:104, events:[['stamp', 'Закрыта', 'Комментарий', {type:'early-close', at:iso(3000)}]]},
  ...fields
});
const open = id => closed(id, 'pro', {d:{state:'active', entry:100}});
const memory = () => {
  const contents = new Map();
  return {getItem:key => contents.get(key) ?? null, setItem:(key, value) => contents.set(key, value), all:() => [...contents]};
};
function load(storage = memory()) {
  const scope = {window:{localStorage:storage}};
  vm.runInNewContext(source, scope);
  return scope.window.OrbitaIdeaCloseState;
}

test('initial history is read and newly closed ideas accumulate once, with separate tier acknowledgement', () => {
  const state = load().create('member', memory());
  const old = closed('old'), first = closed('first'), second = closed('second'), higher = closed('higher', 'exclusive');
  assert.equal(state.update([old, open('first')], ['pro', 'exclusive'], at).length, 0);
  assert.equal(state.unread(), 0);
  assert.equal(state.update([old, first], ['pro', 'exclusive'], at + 4000)[0].id, first.id);
  assert.equal(state.update([old, first, second, higher], ['pro', 'exclusive'], at + 5000).length, 2);
  assert.equal(state.update([old, first, second, higher], ['pro', 'exclusive'], at + 6000).length, 0);
  assert.equal(state.unread(), 3);
  assert.equal(state.unread('pro'), 2);
  state.acknowledge('pro');
  assert.equal(state.unread('pro'), 0);
  assert.equal(state.unread('exclusive'), 1);
  state.acknowledge();
  assert.equal(state.unread(), 0);
});

test('a backdated execution and a closure never seen open are both unread across a reload', () => {
  const storage = memory();
  const a = load(storage).create('member');
  a.update([], ['pro'], at);
  const real = closed('backdated', 'pro', { meta:{
    closedAt:iso(-60000), exit:98,
    events:[['stamp', 'Выход', 'Личные подробности', {type:'early-close', at:iso(4000)}]]
  } });
  const historical = closed('old-import', 'pro', {meta:{closedAt:iso(-60000), exit:102}});
  const b = load(storage).create('member');
  assert.equal(b.update([real, historical], ['pro'], at + 5000).length, 0, 'initial mount does not animate');
  assert.equal(b.unread('pro'), 1);
  const other = load(storage).create('another-member');
  other.update([real], ['pro'], at + 5000);
  assert.equal(other.unread(), 0);
  b.acknowledge('pro');
  a.update([real, historical], ['pro'], at + 5000);
  assert.equal(a.unread(), 0, 'an acknowledgement carried across browser tabs');
  assert.doesNotMatch(JSON.stringify(storage.all()), /Личные|SBER|exit|ticker|resultPct/);
});

test('tabs acknowledging different snapshots cannot lose one another’s read markers', () => {
  const storage = memory(), {create} = load(storage);
  const first = create('member'), second = create('member');
  first.update([], ['pro'], at);
  const a = closed('a'), b = closed('b');
  first.update([a], ['pro'], at + 5000);
  second.update([b], ['pro'], at + 5000);
  const save = storage.setItem;
  storage.setItem = (key, value) => {
    if (key.endsWith('.read.a')) second.acknowledge();
    save(key, value);
  };
  first.acknowledge();
  const reloaded = create('member');
  reloaded.update([a,b], ['pro'], at + 6000);
  assert.equal(reloaded.unread(), 0);
});

test('only allowed real completed rows contribute, including after access changes or an editorial correction', () => {
  const state = load().create('member');
  state.update([], ['pro'], at);
  const legitimate = closed('legitimate'), premium = closed('premium', 'exclusive');
  const invalid = [
    closed('cancelled', 'pro', {d:{state:'cancelled', entry:100}}), open('partial'),
    closed('fixture', 'pro', {demo:true}), closed('demo-sample'), closed('local', 'pro', {localMarketHistory:true}),
    closed('scenario', 'pro', {demoHistory:true}), closed('archived', 'pro', {archived:true}),
    closed('error', 'pro', {erroneous:true}), closed('draft', 'pro', {published:false})
  ];
  assert.equal(state.update([legitimate, premium, ...invalid], ['pro'], at + 5000).length, 1);
  assert.equal(state.unread(), 1);
  assert.equal(state.unread('exclusive'), 0);
  state.update([legitimate, premium], ['pro', 'exclusive'], at + 6000);
  assert.equal(state.unread('exclusive'), 0, 'a newly entitled tier baselines its existing history');
  state.update([{...legitimate, erroneous:true}, premium], ['pro', 'exclusive'], at + 7000);
  assert.equal(state.unread(), 0);
  state.update([], [], at + 8000);
  assert.equal(state.unread(), 0);
});

test('weighted closing result takes precedence over the price of the last fill', () => {
  const {result} = load();
  assert.equal(result(closed('weighted', 'pro', {meta:{exit:80, finalResultPct:2}})), 2);
  const short = closed('short', 'pro', {d:{state:'closed', dir:'ШОРТ', entry:100}});
  assert.ok(Math.abs(result(short) + 4) < 1e-8);
  assert.equal(result(closed('flat', 'pro', {meta:{exit:100}})), 0);
  assert.equal(result(open('partial')), null);
  assert.equal(result({...short, erroneous:true}), null);
});
