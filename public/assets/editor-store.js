/* Read-only browser view of the server's authorized idea feed. */
(() => {
  const clone = value => JSON.parse(JSON.stringify(value));
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const safe = value => typeof value === 'string' ? escape(value) : Array.isArray(value) ? value.map(safe) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safe(item)])) : value;
  const stamp = (at = new Date()) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(at)).replace(',', ' ·');
  let cache = { revision: 0, records: [] }, pending = null, fingerprint = '', generation=0,controller=null;
  const read = () => clone(cache);
  function replace(next) {
    const signature = JSON.stringify(next);
    cache = next;
    if (signature !== fingerprint) {
      fingerprint = signature;
      window.dispatchEvent(new CustomEvent('orbita:store-change'));
    }
  }
  async function refresh() {
    if (pending) return pending;
    const requestGeneration=generation;controller=new AbortController();
    pending = (async () => {
      let response, data;
      try {
        response = await fetch('/api/ideas', { credentials: 'same-origin', cache: 'no-store',signal:controller.signal });
        data = await response.json();
      } catch {
        throw Error('Не удалось загрузить идеи. Проверьте соединение и повторите попытку.');
      }
      if(requestGeneration!==generation)throw Error('Аккаунт изменился. Обновите страницу.');
      if (!response.ok) {
        replace({ revision: 0, records: [] });
        if ([401, 403].includes(response.status)) window.dispatchEvent(new CustomEvent('orbita:access-denied', { detail: { status: response.status } }));
        const fallback=response.status === 401 ? 'Войдите в аккаунт.' : response.status === 403 ? 'Для просмотра идей нужна действующая подписка.' : 'Не удалось загрузить идеи.';
        const error = new Error(window.OrbitaAccess?.supportMessage?.(data,fallback) ?? data.error ?? fallback);
        error.status = response.status;
        throw error;
      }
      if (!Array.isArray(data.records)) throw Error('Сервер вернул некорректный список идей.');
      replace({ revision: data.revision ?? 0, records: data.records.filter(record => record && record.published && record.d && typeof record.id === 'string') });
      return read();
    })();
    try { return await pending; }
    finally { pending = null;controller=null; }
  }
  const clear=()=>{generation++;controller?.abort();replace({revision:0,records:[]});};
  window.OrbitaStore = { read, refresh, clear, escape, safe, clone, stamp };
})();
