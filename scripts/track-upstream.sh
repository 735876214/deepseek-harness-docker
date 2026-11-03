#!/usr/bin/env bash
# 跟踪上游 deepseek-ai/deepseek-harness 的新发布版本，决定是否需要重建封装镜像。
#
# 输出：
#   - stdout 打印一条状态行
#   - 写入 track_result.json：
#     {"status":"OK|PENDING|UPDATE","current_version":...,"version":...,
#      "tag":...,"commit":...,"npm_version":...,"published_at":...}
#
# status 含义：
#   OK      —— 已是最新已发布版本，无需动作
#   PENDING —— 上游有更新 tag，但对应 npm 版本尚未发布（等待，不构建）
#   UPDATE  —— 上游有新版本且 npm 已发布，需要更新封装
#
# 用法：bash scripts/track-upstream.sh
set -euo pipefail

export UPSTREAM_REPO="${UPSTREAM_REPO:-deepseek-ai/deepseek-harness}"
export STATE_FILE="${STATE_FILE:-UPSTREAM_VERSION}"
export TRACK_OUT="${TRACK_OUT:-track_result.json}"

python3 - <<'PY'
import sys, json, os, urllib.request

repo = os.environ["UPSTREAM_REPO"]
state = os.environ["STATE_FILE"]
out = os.environ["TRACK_OUT"]

# 当前已封装版本
current = ""
if os.path.exists(state):
    for line in open(state, encoding="utf-8"):
        if line.startswith("UPSTREAM_VERSION="):
            current = line.split("=", 1)[1].strip().strip('"')

def get_json(url):
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "dsh-tracker",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    return json.load(urllib.request.urlopen(req, timeout=30))

# 1) 拉取上游 tags，保留 dsh-v*，提取 (version, tag, commit)
try:
    tags = get_json(f"https://api.github.com/repos/{repo}/tags?per_page=100")
except Exception as e:
    print(json.dumps({"status": "ERROR", "error": str(e)}))
    sys.exit(1)

cands = [
    {"tag": t["name"], "version": t["name"][5:], "commit": t.get("commit", {}).get("sha", "")}
    for t in tags
    if t.get("name", "").startswith("dsh-v")
]

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

cands.sort(key=lambda c: parse(c["version"]), reverse=True)
best = cands[0] if cands else None

if not best:
    result = {"status": "OK", "current_version": current}
else:
    ver = best["version"]
    # 2) 确认 npm 是否已发布该版本
    try:
        d = get_json("https://registry.npmjs.org/@deepseek-ai%2Fdsh")
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
    result = best

with open(out, "w", encoding="utf-8") as f:
    json.dump(result, f, indent=2)
print(json.dumps(result, ensure_ascii=False))
print("TRACK_STATUS=" + result.get("status", "ERROR"))
PY
