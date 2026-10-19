import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/assets/training-engine.js';

const { createTrade, movePrice, summarize } = globalThis.OrbitaTraining;
const position = (overrides = {}) => createTrade({ side: 'long', entry: 100, quantity: 10, leverage: 1, stop: 95, ...overrides });

test('leverage changes required margin and return on margin at fixed quantity, not cash P&L', () => {
  const cash = summarize(movePrice(position(), 110));
  const leveraged = summarize(movePrice(position({ leverage: 5 }), 110));
  assert.equal(cash.gross, 100);
  assert.equal(leveraged.gross, 100);
  assert.equal(leveraged.notional, 1000);
  assert.equal(leveraged.margin, 200);
  assert.equal(leveraged.positionPercent, 10);
  assert.equal(leveraged.marginPercent, 50);
});

test('short earns on falling prices and stops on rising prices', () => {
  const short = position({ side: 'short', stop: 105 });
  assert.equal(summarize(movePrice(short, 90)).gross, 100);
  const closed = movePrice(short, 120);
  assert.equal(closed.exit, 105);
  assert.equal(closed.reason, 'stop');
  assert.equal(summarize(closed).gross, -50);
});

test('stop closes at the first crossed barrier and remains closed after price recovery', () => {
  const closed = movePrice(position({ leverage: 5 }), 60);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.exit, 95);
  assert.equal(movePrice(closed, 130), closed);
  assert.equal(summarize(movePrice(closed, 130)).gross, -50);
});

test('a distant stop cannot protect against modeled margin exhaustion in either direction', () => {
  const long = movePrice(position({ leverage: 10, stop: 80 }), 75);
  assert.equal(long.reason, 'margin');
  assert.equal(long.exit, 90);
  assert.equal(summarize(long).marginPercent, -100);
  const short = movePrice(position({ side: 'short', leverage: 10, stop: 120 }), 130);
  assert.equal(short.reason, 'margin');
  assert.equal(short.exit, 110);
  assert.equal(summarize(short).gross, -100);
});

test('invalid direction, stop side and nonpositive inputs are rejected', () => {
  assert.throws(() => position({ side: 'other' }));
  assert.throws(() => position({ stop: 101 }));
  assert.throws(() => position({ side: 'short', stop: 95 }));
  assert.throws(() => position({ quantity: 0 }));
  assert.throws(() => position({ entry: Infinity }));
  assert.throws(() => position({ leverage: 11 }));
});
