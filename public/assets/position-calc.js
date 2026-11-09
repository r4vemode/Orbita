/* Position size from capital and risk: "how many lots can I take so that the
   stop costs me no more than X% of my capital". Exchange specs (lot size,
   point value, margin) come from MOEX; without them the result is marked as an
   estimate. Commissions and slippage are not included. */
(() => {
  'use strict';
  const ok = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
  function calc({ market, entry, stop, capital, riskPct, spec = null }) {
    if (![entry, stop, capital, riskPct].every(ok) || entry === stop) return { ok: false, error: 'Укажите капитал и риск больше нуля.' };
    if (riskPct > 100) return { ok: false, error: 'Риск — не больше 100% капитала.' };
    const riskMoney = capital * riskPct / 100, move = Math.abs(entry - stop), warnings = [];
    if (market === 'futures') {
      if (!spec || spec.kind !== 'future') return { ok: false, error: 'Нет биржевых параметров контракта (стоимость шага цены). Расчёт недоступен.' };
      const pointValue = spec.stepPrice / spec.minStep, perContract = move * pointValue, count = Math.floor(riskMoney / perContract);
      const margin = ok(spec.margin) ? count * spec.margin : null;
      if (!count) warnings.push(`Риск на 1 контракт (${perContract.toFixed(0)} ₽) больше выбранного. Увеличьте капитал или % риска.`);
      if (margin && margin > capital) warnings.push('Гарантийное обеспечение больше капитала — брокер не откроет такую позицию.');
      return { ok: true, kind: 'future', count, unit: 'контр.', riskMoney, actualRisk: count * perContract, perUnit: perContract, margin, warnings };
    }
    if (market === 'stocks') {
      const lotSize = spec?.lotSize || null, size = lotSize || 1, lots = Math.floor(riskMoney / (move * size)), shares = lots * size, value = shares * entry;
      if (!lotSize) warnings.push('Размер лота не получен с биржи — расчёт в штуках (1 лот = 1 акция).');
      if (!lots) warnings.push(`Риск на 1 лот (${(move * size).toFixed(2)} ₽) больше выбранного. Увеличьте капитал или % риска.`);
      if (value > capital) warnings.push(`Позиция (${Math.round(value).toLocaleString('ru-RU')} ₽) больше капитала — понадобится плечо. Можно взять меньше: риск тогда будет ниже.`);
      return { ok: true, kind: 'stock', count: lots, shares, lotSize, unit: 'лот.', riskMoney, actualRisk: shares * move, perUnit: move * size, value, warnings };
    }
    const units = riskMoney / move, value = units * entry;
    if (value > capital) warnings.push('Объём позиции больше капитала — понадобится плечо.');
    return { ok: true, kind: 'crypto', count: Math.floor(units * 1e6) / 1e6, unit: 'ед.', riskMoney, actualRisk: units * move, perUnit: move, value, warnings };
  }
  window.OrbitaPositionCalc = { calc };
})();
