#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"
if [ -x "$ROOT/release/linux-unpacked/gitdesk" ]; then
  exec "$ROOT/release/linux-unpacked/gitdesk" "$@"
fi
if ! command -v node >/dev/null 2>&1 && [ -x "$ROOT/.tools/node-v24.21.0-linux-x64/bin/node" ]; then
  PATH="$ROOT/.tools/node-v24.21.0-linux-x64/bin:$PATH"
  export PATH
fi
if [ ! -f "$ROOT/out/main/index.cjs" ]; then
  printf '%s\n' 'Build GitDesk first: npm install && npm run build' >&2
  exit 1
fi
exec node "$ROOT/node_modules/electron/cli.js" "$ROOT" "$@"
