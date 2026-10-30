#!/bin/sh
cd -- "$(dirname -- "$0")/.." || exit 1
exec node admin-download/setup.mjs
