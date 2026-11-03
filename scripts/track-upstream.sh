#!/usr/bin/env bash
# 跟踪上游 deepseek-ai/deepseek-harness 的新发布版本，决定是否需要重建封装镜像。
#
# 输出：
#   - stdout 打印一条状态行
#   - 写入 track_result.json：
#     {"status":"OK|PENDING|UPDATE",
#      "current_version":..., "version":..., "tag":...,
#      "commit":..., "npm_version":..., "published_at":...}
#
# status 含义：
#   OK      —— 已是最新已发布版本，无需动作
#   PENDING —— 上游有更新 tag，但对应 npm 版本尚未发布（等待，不构建）
#   UPDATE  —— 上游有新版本且 npm 已发布，需要更新封装
#
# 用法：bash scripts/track-upstream.sh
set -euo pipefail

REPO="${UPSTREAM_REPO:-deepseek-ai/deepseek-harness}"
STATE_FILE="${STATE_FILE:-UPSTREAM_VERSION}"
OUT="${TRACK_OUT:-track_result.json}"

CURRENT_VERSION=""
if [ -f "$STATE_FILE" ]; then
  CURRENT_VERSION=$(grep '^UPSTREAM_VERSION=' "$STATE_FILE" | head -n1 | cut -d= -f2- | tr -d '"' || true)
fi

# 1) 拉取上游 tags，保留 dsh-v*，提取 (version, tag, commit)
MAP_JSON=$(curl -fsS -m 30 -H "Accept: application/vnd.github+json" -H "User-Agent: dsh-tracker" \
  "https://api.github.com/repos/${REPO}/tags?per_page=100" \
  | python3 - <<'PY'
import sys, json
data = json.load(sys.stdin)
out = []
for t in data:
    n = t.get("name", "")
    if n.startswith("dsh-v"):
        out.append({"tag": n, "version": n[5:], "commit": t.get("commit", {}).get("sha", "")})
print(json.dumps(out))
PY
)

# 2) 按 semver 取最新，并确认 npm 是否已发布该版本
RESULT=$(echo "$MAP_JSON" | python3 - "$CURRENT_VERSION" <<'PY'
import sys, json, urllib.request

def parse(v):
    v = v.strip()
    if "-" in v:
        main, pre = v.split("-", 1)
    else:
        main, pre = v, ""
    nums = [int(x) for x in main.split(".")] if main else [0, 0, 0]
    while len(nums) < 3:
        nums.append(0)
    pre_ids = []
    if pre:
        for p in pre.split("."):
            pre_ids.append((0, int(p)) if p.isdigit() else (1, p))
    # (版本号, 发布版优先于预发布, 预发布标识)
    return (nums, 0 if pre_ids else 1, pre_ids)

cands = json.load(sys.stdin)
current = sys.argv[1]
cands.sort(key=lambda c: parse(c["version"]), reverse=True)
best = cands[0] if cands else None
if not best:
    print(json.dumps({"status": "OK", "current_version": current}))
    sys.exit(0)

ver = best["version"]
try:
    req = urllib.request.Request(
        "https://registry.npmjs.org/@deepseek-ai%2Fdsh",
        headers={"User-Agent": "dsh-tracker"},
    )
    d = json.load(urllib.request.urlopen(req, timeout=30))
    published = ver in set(d.get("versions", {}).keys())
    npm_latest = d.get("dist-tags", {}).get("latest", "")
except Exception:
    published = False
    npm_latest = ""

best["npm_version"] = ver if published else ""
best["current_version"] = current
best["published_at"] = ""
if not published:
    best["status"] = "PENDING"
    best["note"] = f"upstream {ver} not yet on npm (latest={npm_latest})"
elif ver != current:
    best["status"] = "UPDATE"
else:
    best["status"] = "OK"
print(json.dumps(best))
PY
)

echo "$RESULT" | tee "$OUT"
STATUS=$(echo "$RESULT" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status'))")
echo "TRACK_STATUS=$STATUS"
