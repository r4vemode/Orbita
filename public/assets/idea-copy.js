/* Presentation only: preserve the author's stored publication and audit trail. */
(() => {
  const pending = 'Сигнал опубликован. Уровни и условия будут добавлены автором.';
  window.OrbitaIdeaCopy = {
    summary(d) {
      if (d.summary !== pending) return d.summary || '';
      if ([d.entry, d.stop, d.target].every(n => Number.isFinite(n) && n > 0))
        return 'Уровни и условия опубликованы. Проверяйте текущий статус и историю изменений автора.';
      return pending;
    }
  };
})();
