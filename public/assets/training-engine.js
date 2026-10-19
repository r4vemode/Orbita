/* Educational linear position model; no broker orders or market prices. */
(() => {
  function createTrade({ side = 'long', entry, quantity, leverage = 1, stop }) {
    if (!['long', 'short'].includes(side)) throw Error('Выберите лонг или шорт.');
    if (![entry, quantity, leverage, stop].every(Number.isFinite)) throw Error('Заполните все параметры числами.');
    if (entry <= 0 || entry > 1e9) throw Error('Цена входа должна быть больше нуля и не выше 1 млрд ₽.');
    if (quantity <= 0 || quantity > 1e9) throw Error('Количество должно быть больше нуля и не выше 1 млрд единиц.');
    if (leverage < 1 || leverage > 10) throw Error('Учебное плечо: от 1 до 10.');
    if (stop <= 0 || (side === 'long' ? stop >= entry : stop <= entry)) {
      throw Error(side === 'long' ? 'Для лонга стоп должен быть выше нуля и ниже входа.' : 'Для шорта стоп должен быть выше входа.');
    }
    return { side, entry, quantity, leverage, stop, price: entry, status: 'open', exit: null, reason: null };
  }

  function movePrice(trade, price) {
    if (!Number.isFinite(price) || price <= 0) throw Error('Учебная цена должна быть положительной.');
    // A recovered quote cannot reopen a position that already exited.
    if (trade.status === 'closed') return trade;
    const sign = trade.side === 'long' ? 1 : -1;
    const marginBoundary = trade.entry - sign * trade.entry / trade.leverage;
    const crossed = level => sign * (price - level) <= 0;
    const barriers = [{ price: trade.stop, reason: 'stop' }];
    if (marginBoundary > 0) barriers.push({ price: marginBoundary, reason: 'margin' });
    const hit = barriers.filter(b => crossed(b.price)).sort((a, b) => sign * (b.price - a.price))[0];
    return hit
      ? { ...trade, price: hit.price, exit: hit.price, status: 'closed', reason: hit.reason }
      : { ...trade, price };
  }

  function summarize(trade) {
    const sign = trade.side === 'long' ? 1 : -1;
    const notional = trade.entry * trade.quantity;
    const margin = notional / trade.leverage;
    const gross = ((trade.exit ?? trade.price) - trade.entry) * sign * trade.quantity;
    return { notional, margin, gross, positionPercent: gross / notional * 100, marginPercent: gross / margin * 100, marginBoundary: trade.entry - sign * trade.entry / trade.leverage };
  }

  globalThis.OrbitaTraining = Object.freeze({ createTrade, movePrice, summarize });
})();
