const initialCapital = 100;
const positionNotional = 10;
const moscow = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
const monthKey = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit',
});
const stamp = at => moscow.format(new Date(at)).replace(',', ' ·');
const sign = direction => direction === 'SHORT' ? -1 : 1;
const returnPercent = trade => (trade.exit / trade.entry - 1) * sign(trade.direction) * 100;

export function projectDemoTrade(trade) {
  const { id, tier, strategy, ticker, name, market, direction, openedAt, closedAt, entry, exit,
    stop, target, comment, analysis, closeReason, sourceUrl, candles } = trade;
  const result = returnPercent(trade);
  const outcome = result > 0 ? 'Закрыта в плюс' : result < 0 ? 'Закрыта в минус' : 'Закрыта без изменения цены';
  const entryLabel = stamp(openedAt), exitLabel = stamp(closedAt);
  const levels = { entry, stop, target };
  const event = (at, label, title, body, after) => [label, title, body, { at, after }];
  return {
    id, tier, published: true, demo: true, demoHistory: true,
    d: {
      ...levels, ticker, name, market, strategy, title: name, summary: comment,
      dir: direction === 'SHORT' ? 'ШОРТ' : 'ЛОНГ', state: 'closed', status: outcome, outcome,
      horizon: tier === 'exclusive' ? 'Среднесрочно' : 'Внутри дня',
      unit: market === 'crypto' ? 'USDT' : market === 'stocks' ? '₽' : 'ед. котировки',
      chartUrl: sourceUrl, chartPlaceholder: false, candles, analysis,
    },
    meta: {
      publishedAt: openedAt, enteredAt: openedAt, closedAt, updatedAt: closedAt,
      published: entryLabel, updated: exitLabel, exit, initial: levels, closeReason,
      events: [
        event(openedAt, entryLabel, 'Исторический сценарий', comment, levels),
        event(openedAt, entryLabel, 'Вход подтверждён', 'Условный вход по цене открытия свечи.', { entry }),
        event(closedAt, exitLabel, 'Закрыто', analysis?.exitReason || comment, { exit }),
      ],
    },
  };
}

const demoRows = trades => trades.map(trade => ({ ...trade, state: 'closed', pct: returnPercent(trade) }));

// Each scenario uses the same fixed fraction of starting capital. This lets
// overlapping positions contribute independently, without assuming executions,
// leverage, or trading costs. The existing calculator models those parameters.
export function historyStatistics({ tier, type, strategy, market, trades = [], published = [] }) {
  const rows = (type === 'demo' ? demoRows(trades) : published)
    .filter(row => row.tier === tier && row.state === 'closed' && !row.erroneous
      && (!strategy || row.strategy === strategy) && (!market || row.market === market))
    .sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt) || a.id.localeCompare(b.id));
  const dated = rows.filter(row => Number.isFinite(Date.parse(row.closedAt)));
  const months = new Map();
  const first = dated[0]?.closedAt;
  const capital = first ? [{ at: first, value: initialCapital }] : [];
  let equity = initialCapital;
  let peak = initialCapital;
  let maxDrawdownPercent = 0;
  let wins = 0, losses = 0, pricedTrades = 0, grossWins = 0, grossLosses = 0;
  for (const row of dated) {
    const month = monthKey.format(new Date(row.closedAt));
    const bucket = months.get(month) || { month, closedTrades: 0, wins: 0, losses: 0, returnPercent: 0 };
    months.set(month, bucket);
    bucket.closedTrades++;
    if (!Number.isFinite(row.pct)) continue;
    pricedTrades++;
    if (row.pct > 0) { wins++; bucket.wins++; grossWins += row.pct; }
    if (row.pct < 0) { losses++; bucket.losses++; grossLosses -= row.pct; }
    const change = positionNotional * row.pct / 100;
    equity += change;
    bucket.returnPercent += change / initialCapital * 100;
    peak = Math.max(peak, equity);
    maxDrawdownPercent = Math.max(maxDrawdownPercent, (peak - equity) / peak * 100);
    capital.push({ at: row.closedAt, value: equity });
  }
  return {
    tier, type, closedTrades: rows.length, pricedTrades, wins, losses,
    winRate: pricedTrades ? wins / pricedTrades * 100 : null,
    totalReturnPercent: (equity / initialCapital - 1) * 100,
    profitFactor: losses ? grossWins / grossLosses : null,
    maxDrawdownPercent, averageWinPercent: wins ? grossWins / wins : null,
    averageLossPercent: losses ? -grossLosses / losses : null,
    capital, monthly: [...months.values()], settings: { initialCapital, positionNotional },
  };
}
