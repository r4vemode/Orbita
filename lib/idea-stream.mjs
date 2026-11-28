import {hasSubscription, requireMember} from './access.mjs';
import {error} from './http.mjs';

const READY = 'retry: 8000\nevent: ready\ndata: {}\n\n';
const UPDATED = 'event: ideas-update\ndata: {}\n\n';
const HEARTBEAT = ': heartbeat\n\n';

export function createIdeaStream({
  accounts, ideas, heartbeatMs = 12000, lifetimeMs = 300000, maxConnections = 64, perAccount = 3
}) {
  const clients = new Set();
  let closed = false;

  const unsubscribe = ideas.subscribe(() => {
    for (const client of clients) void client.check(true);
  });

  async function open(req, res, user, releaseRequest) {
    requireMember(user);
    if (closed) throw error(503, 'Сервис обновлений завершает работу.');
    const connectedForUser = [...clients].filter(client => client.userId === user.id).length;
    if (connectedForUser >= perAccount || clients.size >= maxConnections) {
      throw error(429, 'Слишком много подключений к обновлениям идей.', 'IDEA_STREAM_LIMIT');
    }

    let opened = false, ended = false, checking = false, pending = false;
    let heartbeat, lifetime;
    const client = {userId:user.id, check, end};

    function end() {
      if (ended) return;
      ended = true;
      clients.delete(client);
      clearInterval(heartbeat);
      clearTimeout(lifetime);
      res.off('close', end);
      if (res.headersSent && !res.destroyed && !res.writableEnded) res.end();
    }

    async function check(update = false) {
      pending ||= update;
      if (!opened || ended || checking) return;
      checking = true;
      try {
        const current = await accounts.identify(req);
        if (ended || closed || current?.id !== user.id || !hasSubscription(current)) {
          end();
          return;
        }
        const frame = pending ? UPDATED : HEARTBEAT;
        pending = false;
        if (!res.write(frame)) end();
      } catch {
        end();
      } finally {
        checking = false;
      }
    }

    clients.add(client);
    res.once('close', end);
    try {
      const current = await accounts.identify(req);
      requireMember(current);
      if (current.id !== user.id) throw error(401, 'Войдите в аккаунт.');
      if (closed) throw error(503, 'Сервис обновлений завершает работу.');
      if (ended || res.destroyed) return;
      res.writeHead(200, {
        'Content-Type':'text/event-stream; charset=utf-8',
        'Cache-Control':'no-store, no-transform',
        'Vary':'Cookie',
        'X-Accel-Buffering':'no'
      });
      opened = true;
      releaseRequest?.();
      pending = false;
      if (!res.write(READY)) {
        end();
        return;
      }
      heartbeat = setInterval(() => { void check(); }, heartbeatMs);
      heartbeat.unref();
      lifetime = setTimeout(end, lifetimeMs);
      lifetime.unref();
    } catch (cause) {
      end();
      if (!res.headersSent && !res.destroyed) throw cause;
    }
  }

  function close() {
    closed = true;
    unsubscribe();
    for (const client of clients) client.end();
  }

  return {open, close};
}
