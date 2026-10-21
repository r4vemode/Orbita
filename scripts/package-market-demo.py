"""Build the dependency-free offline demo from the same assets served by Orbita."""
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
html = (PUBLIC / "market-demo.html").read_text(encoding="utf-8")
html = html.replace('<link rel="stylesheet" href="assets/market-demo.css">',
                    '<style>' + (PUBLIC / "assets/market-demo.css").read_text(encoding="utf-8") + '</style>')
for name in ("market-demo-engine.js", "market-demo.js"):
    script = (PUBLIC / "assets" / name).read_text(encoding="utf-8")
    if "</script" in script.lower():
        raise ValueError("Inline script contains an unsafe HTML closing tag")
    html = html.replace(f'<script src="assets/{name}"></script>', '<script>' + script + '</script>')
readme = """ORBITA / Пульс рынка — демо концепции AlgoPack

1. Распакуйте ZIP.
2. Откройте index.html в Chrome, Edge, Firefox или Safari.
Node.js, установка и регистрация не нужны. После распаковки работает офлайн.

Что попробовать:
— фильтры, поиск, сортировку и избранное в скринере;
— выбор тикера, интервалы свечей 1 / 5 / 15 минут;
— сценарии «Всплеск объёмов» и «Давление продавцов»;
— ползунок и воспроизведение учебной сессии;
— лонг / шорт, объём в лотах, риск до стопа и отношение прибыли к риску;
— сохранение и экспорт учебного черновика .txt;
— кнопку «Как это работает» и пояснения к метрикам.

Все данные синтетические: это не реальные котировки MOEX и не торговые сигналы.
Ключ API не нужен. Запросы в сеть не отправляются. Внешние ссылки открываются
только по вашему нажатию. Настоящие сигналы и аккаунты Orbita сюда не включены.
Избранное и максимум 30 черновиков сохраняются только в этом браузере,
если он разрешает локальное хранилище. Для переноса используйте экспорт .txt.
Лоты учебные; расчёт не учитывает комиссии, проскальзывание и стоимость шорта.

Демо не публикует идеи, не выдаёт подписку и не отправляет заявки брокеру.
Для теста самого ЛК Orbita нужен основной проект, сервер Node.js и подписка,
выданная администратором; инструкция находится в docs/testing.md.
"""
destination = ROOT / "demos" / "Orbita-AlgoPack-demo.zip"
destination.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for name, text in (("index.html", html), ("README.txt", readme)):
        info = zipfile.ZipInfo(name, date_time=(2026, 10, 21, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, text.encode("utf-8"))
with zipfile.ZipFile(destination) as archive:
    assert archive.testzip() is None
print(destination)
