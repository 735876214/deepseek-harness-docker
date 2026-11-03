#!/usr/bin/env bash
# 解析某个上游版本在 npm 上可安装的版本号。
# 若该精确版本已发布则输出它；否则输出 npm latest；都没有则输出空。
# 直接查询 npm registry HTTP API，无需本机 npm CLI。
#
# 用法：bash scripts/resolve-npm-version.sh <upstream-version>
set -euo pipefail

VER="${1:-}"
REG="https://registry.npmjs.org/@deepseek-ai%2Fdsh"

json=$(curl -fsS -m 20 -H "User-Agent: dsh-tracker" "$REG" 2>/dev/null || true)
if [ -z "$json" ]; then
  echo ""
  exit 0
fi

echo "$json" | python3 - "$VER" <<'PY'
import sys, json
d = json.load(sys.stdin)
ver = sys.argv[1]
versions = set(d.get("versions", {}).keys())
if ver and ver in versions:
    print(ver)
else:
    print(d.get("dist-tags", {}).get("latest") or "")
PY
