#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Установите Node.js 24 LTS: https://nodejs.org/en/download"
  echo "После установки закройте и снова откройте VS Code, затем запустите этот файл."
  read -r -p "Нажмите Enter для выхода…" || true
  exit 1
fi
if ! node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'; then
  echo "Нужен Node.js 22 или новее. Рекомендуется Node.js 24 LTS."
  read -r -p "Нажмите Enter для выхода…" || true
  exit 1
fi
npm ci --ignore-scripts --no-audit --no-fund
echo "Локальная Орбита: http://127.0.0.1:3000/account.html"
echo "Случайный тестовый пароль появится ниже. Для остановки нажмите Ctrl+C."
exec npm run local
