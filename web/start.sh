#!/bin/sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo '需要 Node.js。请先安装 Node.js，再运行 sh start.sh。' >&2
  exit 1
fi
node transport.mjs --authorize --open
exec node server.mjs --open
