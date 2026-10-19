"""Telegram -> ORBITA. Credentials and session stay on this machine."""
import asyncio
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data'
SYMBOLS = {'SBER': r'сбер|\bsber\b', 'LKOH': r'лукойл|\blkoh\b',
           'ROSN': r'роснефт|\brosn\b', 'GAZP': r'газпром(?!\s*нефт)|\bgazp\b',
           'BTC': r'биткоин|bitcoin|\bbtc\b', 'ETH': r'эфириум|ethereum|\beth\b',
           'Brent': r'\bbrent\b|брент'}

def classify(text):
    tickers = [key for key, pattern in SYMBOLS.items() if re.search(pattern, text, re.I)]
    topics = []
    if any(t in ('BTC', 'ETH') for t in tickers) or re.search(r'крипт|блокчейн', text, re.I): topics.append('crypto')
    if any(t not in ('BTC', 'ETH', 'Brent') for t in tickers): topics.append('stocks')
    if not topics or re.search(r'инфляц|ключев\w* ставк|фрс|нефть|\bцб\b', text, re.I): topics.append('macro')
    # Conservative rules: explicit profit changes, one identified company, no negation.
    positive = bool(re.search(r'прибыл\w*[^.!?\n]{0,40}(вырос|увеличил)|рост\w*\s+(чистой\s+)?прибыли', text, re.I))
    negative = bool(re.search(r'прибыл\w*[^.!?\n]{0,40}(снизил|сократил|упал)|снижен\w*\s+(чистой\s+)?прибыли', text, re.I))
    clear = len(tickers) == 1 and tickers[0] not in ('BTC', 'ETH', 'Brent') and not re.search(r'\bне\b|прогноз|ожида|слух|опроверг|\?', text, re.I)
    sentiment = 'positive' if clear and positive and not negative else 'negative' if clear and negative and not positive else 'neutral'
    return dict(tickers=tickers, topics=topics, sentiment=sentiment,
                sentimentAsset=tickers[0] if sentiment != 'neutral' else '',
                sentimentReason='В тексте указан рост прибыли; ожидания рынка не учтены.' if sentiment == 'positive' else 'В тексте указано снижение прибыли; ожидания рынка не учтены.' if sentiment == 'negative' else 'Однозначное влияние не определено.',
                urgent=bool(re.match(r'^\s*(?:🚨|‼|СРОЧНО\b|BREAKING\b)', text, re.I)))

def convert(message, channel_id, username):
    body = (message.message or '').strip()
    if not body: return None
    title = re.sub(r'\s+', ' ', body)
    return dict(id=f'tg:{channel_id}:{message.id}', title=title.encode('utf-16-le')[:552].decode('utf-16-le', errors='ignore')+'…' if len(title.encode('utf-16-le'))>560 else title,
                source='MarketTwits', publishedAt=message.date.isoformat(),
                url=f'https://t.me/{username}/{message.id}', **classify(body))

def atomic_write(path, payload):
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.news-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(payload, stream, ensure_ascii=False)
        os.replace(name, path)
    finally:
        if os.path.exists(name): os.unlink(name)

async def main():
    from telethon import TelegramClient, events
    DATA.mkdir(exist_ok=True, mode=0o700)
    api_id = os.environ.get('TELEGRAM_API_ID') or input('Telegram api_id: ').strip()
    from getpass import getpass
    api_hash = os.environ.get('TELEGRAM_API_HASH') or getpass('Telegram api_hash (скрыт): ').strip()
    if not api_id.isdigit() or not api_hash: raise SystemExit('Нужны api_id и api_hash из my.telegram.org')
    os.umask(0o077)
    client = TelegramClient(str(DATA/'telegram'), int(api_id), api_hash)
    await client.start()
    entity = await client.get_entity('markettwits')
    feed = DATA/'news.json'
    rows = {}
    if feed.exists():
        rows = {n['id']: n for n in json.loads(feed.read_text(encoding='utf-8'))['items']}
    lock = asyncio.Lock()
    def save():
        nonlocal rows
        rows = dict(sorted(rows.items(), key=lambda pair:pair[1]['publishedAt'], reverse=True)[:200])
        atomic_write(feed, {'items':list(rows.values()), 'syncedAt':datetime.now(timezone.utc).isoformat(), 'provider':'telegram'})
    async def sync():
        # Reconcile recent history after reconnect, including edits and deletions.
        async with lock:
            messages = [m async for m in client.iter_messages(entity, limit=200)]
            if messages:
                floor = min(m.id for m in messages)
                present = {f'tg:{entity.id}:{m.id}' for m in messages}
                for key in list(rows):
                    if key.startswith(f'tg:{entity.id}:') and int(key.rsplit(':',1)[1]) >= floor and key not in present: rows.pop(key)
            for message in messages:
                item = convert(message, entity.id, entity.username)
                key = f'tg:{entity.id}:{message.id}'
                if item: rows[key] = item
                else: rows.pop(key, None)
            save()
    async def update(event):
        async with lock:
            item = convert(event.message, entity.id, entity.username)
            key = f'tg:{entity.id}:{event.message.id}'
            if item: rows[key] = item
            else: rows.pop(key, None)
            save()
    async def deleted(event):
        async with lock:
            for mid in event.deleted_ids: rows.pop(f'tg:{entity.id}:{mid}', None)
            save()
    client.add_event_handler(update, events.NewMessage(chats=entity))
    client.add_event_handler(update, events.MessageEdited(chats=entity))
    client.add_event_handler(deleted, events.MessageDeleted(chats=entity))
    try:
        await sync()
        print('MarketTwits подключён. Оставьте этот процесс и npm start запущенными. Ctrl+C — остановить.')
        while True:
            await asyncio.sleep(60)
            try: await sync()
            except Exception as exc: print('Обновление временно недоступно:', type(exc).__name__)
    finally:
        await client.disconnect()

if __name__ == '__main__':
    try: asyncio.run(main())
    except KeyboardInterrupt: pass
