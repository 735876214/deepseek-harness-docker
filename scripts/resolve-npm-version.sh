#!/usr/bin/env bash
# 解析某个上游版本在 npm 上可安装的版本号。
# 若该精确版本已发布则输出它；否则输出 npm latest；都没有则输出空。
# 直接查询 npm registry HTTP API（用 python urllib，无需本机 npm CLI）。
#
# 用法：bash scripts/resolve-npm-version.sh <upstream-version>
set -euo pipefail

export VER="${1:-}"
python3 - <<'PY'
import sys, json, urllib.request
ver = os.environ.get("VER", "")
try:
    req = urllib.request.Request(
        "https://registry.npmjs.org/@deepseek-ai%2Fdsh",
        headers={"User-Agent": "dsh-tracker"},
    )
    d = json.load(urllib.request.urlopen(req, timeout=30))
    versions = set(d.get("versions", {}).keys())
    if ver and ver in versions:
        print(ver)
    else:
        print(d.get("dist-tags", {}).get("latest") or "")
except Exception:
    print("")
PY
