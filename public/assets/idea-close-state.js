/* Closure badges use the member's authorized feed. Storage holds only IDs and baselines. */
(() => {
  'use strict';
  const tiers = ['pro', 'exclusive'];
  const closeTypes = new Set(['manual', 'target', 'stop', 'early-close']);
  const positive = value => Number.isFinite(value) && value > 0;
  const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id);
  const validTime = value => Number.isFinite(value) && value > 0;
  const tierOf = record => record.tier || (record.d?.strategy === 'Orbita Exclusive' ? 'exclusive' : 'pro');

  function result(record) {
    if (record?.d?.state !== 'closed' || record.erroneous) return null;
    if (Number.isFinite(record.meta?.finalResultPct)) return record.meta.finalResultPct;
    const { d, meta } = record;
    if (!positive(d.entry) || !positive(meta?.exit)) return null;
    const value = (meta.exit / d.entry - 1) * (d.dir === 'ШОРТ' ? -100 : 100);
    return Number.isFinite(value) ? value : null;
  }

  function closed(record) {
    return record?.published === true && validId(record.id) && !record.id.startsWith('demo-')
      && !record.archived && !record.demo && !record.isDemo && !record.demoHistory && !record.localMarketHistory
      && result(record) !== null;
  }

  function closureTime(record) {
    const { meta } = record;
    // A manually entered execution time may be backdated. The journal's event
    // time is when the editor actually published the exit.
    const events = meta?.events ?? [];
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]?.[3];
      if (!closeTypes.has(event?.type)) continue;
      const at = Date.parse(event.at);
      if (Number.isFinite(at)) return at;
      break;
    }
    return typeof meta?.closedAt === 'string' ? Date.parse(meta.closedAt) : NaN;
  }

  function create(accountId, suppliedStorage) {
    const key = 'orbita.idea-close.v1.' + encodeURIComponent(accountId);
    let storage = suppliedStorage;
    if (storage === undefined) {
      try { storage = window.localStorage; } catch { storage = null; }
    }
    const baselines = {};
    const readIds = new Set();
    const observedIds = new Set();
    let current = new Map();
    let available = new Set();

    function readStorage(name) {
      try { return storage?.getItem(name) ?? null; } catch { return null; }
    }

    function writeStorage(name, value) {
      try { storage?.setItem(name, value); } catch {}
    }

    const baselineKey = tier => key + '.baseline.' + tier;
    const readKey = id => key + '.read.' + id;

    function readBaseline(tier) {
      if (validTime(baselines[tier])) return;
      let saved;
      try { saved = JSON.parse(readStorage(baselineKey(tier))); } catch { return; }
      if (!validTime(saved?.time) || !Array.isArray(saved.ids)) return;
      baselines[tier] = saved.time;
      for (const id of saved.ids) if (validId(id)) readIds.add(id);
    }

    function broadcast() {
      // Each read marker has its own key, so simultaneous acknowledgements in
      // other tabs cannot overwrite one another. This key just signals changes.
      writeStorage(key, Math.random().toString(36));
    }

    function pending(record) {
      if (readIds.has(record.id)) return false;
      const at = closureTime(record);
      if (Number.isFinite(at) && at < baselines[tierOf(record)]) return false;
      if (readStorage(readKey(record.id)) !== '1') return true;
      readIds.add(record.id);
      return false;
    }

    function update(records, availableTiers = tiers, observedAt = Date.now()) {
      if (!Array.isArray(records) || !Array.isArray(availableTiers)) return [];
      for (const tier of tiers) readBaseline(tier);
      const previous = available;
      const allowed = new Set(tiers.filter(tier => availableTiers.includes(tier)));
      const snapshot = new Map(records.filter(record => closed(record) && allowed.has(tierOf(record))).map(record => [record.id, record]));
      for (const tier of allowed) {
        if (validTime(baselines[tier])) continue;
        const ids = [...snapshot.values()].filter(record => tierOf(record) === tier).map(record => record.id);
        const time = baselines[tier] = validTime(observedAt) ? observedAt : Date.now();
        for (const id of ids) readIds.add(id);
        writeStorage(baselineKey(tier), JSON.stringify({ time, ids }));
      }
      const fresh = [];
      for (const record of snapshot.values()) {
        if (!observedIds.has(record.id) && previous.has(tierOf(record)) && pending(record)) fresh.push(record);
        observedIds.add(record.id);
      }
      available = allowed;
      current = snapshot;
      return fresh;
    }

    function unread(tier = 'all') {
      let count = 0;
      for (const record of current.values()) if ((tier === 'all' || tierOf(record) === tier) && pending(record)) count++;
      return count;
    }

    function acknowledge(tier = 'all') {
      let changed = false;
      for (const record of current.values()) {
        if ((tier !== 'all' && tierOf(record) !== tier) || !pending(record)) continue;
        readIds.add(record.id);
        writeStorage(readKey(record.id), '1');
        changed = true;
      }
      if (changed) broadcast();
    }

    return { key, update, unread, acknowledge };
  }

  window.OrbitaIdeaCloseState = { create, result };
})();
