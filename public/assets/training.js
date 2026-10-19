(() => {
  const root = document.getElementById('tradeTraining');
  if (!root || !globalThis.OrbitaTraining) return;
  const $ = id => document.getElementById(id);
  const engine = globalThis.OrbitaTraining;
  const money = n => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 }).format(n);
  const percent = n => `${n > 0 ? '+' : ''}${n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}%`;
  let trade;

  function render() {
    const result = engine.summarize(trade);
    $('trainingPrice').value = money(trade.price);
    $('trainingNotional').textContent = money(result.notional);
    $('trainingMargin').textContent = money(result.margin);
    $('trainingPnl').textContent = `${result.gross > 0 ? '+' : ''}${money(result.gross)}`;
    $('trainingPnl').dataset.tone = result.gross < 0 ? 'negative' : result.gross > 0 ? 'positive' : 'neutral';
    $('trainingPositionReturn').textContent = percent(result.positionPercent);
    $('trainingMarginReturn').textContent = percent(result.marginPercent);
    $('trainingBoundary').textContent = result.marginBoundary > 0 ? money(result.marginBoundary) : '0 ₽';
    $('trainingPriceSlider').disabled = trade.status === 'closed';
    $('trainingReset').hidden = trade.status !== 'closed';
    $('trainingStatus').dataset.state = trade.status;
    $('trainingStatus').textContent = trade.status === 'open'
      ? `Позиция открыта · ${trade.side === 'long' ? 'лонг' : 'шорт'} · стоп ${money(trade.stop)}`
      : trade.reason === 'stop'
        ? `Стоп сработал на ${money(trade.exit)}. Результат зафиксирован. Откройте новую учебную сделку, чтобы продолжить.`
        : `Обеспечение исчерпано на ${money(trade.exit)}. Учебная позиция закрыта. Откройте новую сделку, чтобы продолжить.`;
    $('trainingPriceSlider').setAttribute('aria-valuetext', money(trade.price));
  }

  function start(event) {
    event?.preventDefault();
    try {
      const next = engine.createTrade({ side: $('trainingSide').value, entry: Number($('trainingEntry').value), quantity: Number($('trainingQuantity').value), leverage: Number($('trainingLeverage').value), stop: Number($('trainingStop').value) });
      trade = next;
      $('trainingPriceSlider').min = String(trade.entry * .5);
      $('trainingPriceSlider').max = String(trade.entry * 1.5);
      $('trainingPriceSlider').step = String(trade.entry / 1000);
      $('trainingPriceSlider').value = String(trade.entry);
      $('trainingMin').textContent = money(trade.entry * .5);
      $('trainingMax').textContent = money(trade.entry * 1.5);
      $('trainingError').textContent = '';
      $('trainingApply').textContent = 'Открыть новую учебную сделку';
      render();
    } catch (error) {
      $('trainingError').textContent = error.message;
    }
  }

  $('trainingForm').addEventListener('submit', start);
  $('trainingSide').addEventListener('change', () => {
    const entry = Number($('trainingEntry').value);
    if (entry > 0) $('trainingStop').value = String(Number((entry * ($('trainingSide').value === 'long' ? .95 : 1.05)).toFixed(4)));
  });
  $('trainingForm').addEventListener('input', () => {
    $('trainingPriceSlider').disabled = true;
    $('trainingError').textContent = '';
    $('trainingApply').textContent = 'Применить и открыть новую сделку';
    $('trainingStatus').textContent = 'Параметры изменены. Примените их, чтобы открыть новую учебную сделку.';
  });
  $('trainingPriceSlider').addEventListener('input', event => {
    trade = engine.movePrice(trade, Number(event.target.value));
    if (trade.status === 'closed') event.target.value = String(trade.price);
    render();
  });
  $('trainingReset').addEventListener('click', start);
  start();
})();
