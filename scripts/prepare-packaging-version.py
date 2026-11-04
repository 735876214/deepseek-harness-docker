#!/usr/bin/env python3
"""推导并落地「打包版本号」。

版本模型
--------
    打包版本 = <上游版本>-r<打包修订号>          例：0.2.2-alpha.3-r2

  - 上游发了新版本            -> 修订号重置为 1，并刷新 UPSTREAM_VERSION / Dockerfile ARG
  - 上游未变、但重新打包(force) -> 修订号 +1
  - 上游未变、也没 force       -> 不动任何文件（changed=false）

这样「同一个上游版本可以有多次打包」，每次打包都有唯一且不可变的
<VERSION> 标签 + git 标签 upstream/<VERSION>，与镜像一一对应。

输入（环境变量）
---------------
  FORCE=1|true          : 上游无变化时也递增修订号
  TRACK_RESULT          : 跟踪结果 JSON，默认 track_result.json
  GITHUB_OUTPUT         : 若存在则写入 packaging_version / changed / upstream_version
输出
----
  stdout 打印一行摘要；写文件 VERSION、PACKAGING_REVISION、UPSTREAM_VERSION、
  Dockerfile(ARG DSH_VERSION)、CHANGELOG.md（仅 changed=true 时）。
"""
from __future__ import annotations

import datetime
import json
import os
import re
import sys

TRACK_RESULT = os.environ.get("TRACK_RESULT", "track_result.json")
FORCE = (os.environ.get("FORCE") or "").strip().lower() in {"1", "true", "yes"}
TODAY = datetime.date.today().isoformat()

VER_RE = re.compile(r"^(?P<up>.+?)-r(?P<rev>\d+)$")


def read_kv(path: str) -> dict[str, str]:
    data: dict[str, str] = {}
    if not os.path.exists(path):
        return data
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            data[key.strip()] = value.strip().strip('"')
    return data


def write_kv(path: str, header: str, items: list[tuple[str, str]]) -> None:
    lines = [header] if header else []
    lines += [f"{k}={v}" for k, v in items]
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def read_text(path: str) -> str:
    """读取单值文件（VERSION / PACKAGING_REVISION 就是纯值，不是 key=value）。"""
    if not os.path.exists(path):
        return ""
    with open(path, encoding="utf-8") as f:
        return f.read().strip()


def current_state() -> tuple[str, int]:
    """返回 (上游版本, 打包修订号)，以 VERSION 为准，缺失时回落到 UPSTREAM_VERSION。"""
    upstream = read_kv("UPSTREAM_VERSION").get("UPSTREAM_VERSION", "")
    revision = read_text("PACKAGING_REVISION")
    version = read_text("VERSION")

    m = VER_RE.match(version)
    if m:
        return (upstream or m.group("up"), int(m.group("rev")))
    try:
        return (upstream, int(revision) if revision else 1)
    except ValueError:
        return (upstream, 1)


def prepend_changelog(entry: str) -> None:
    """在首个版本条目之前插入新条目，保留原有历史（不可截断尾部）。"""
    with open("CHANGELOG.md", encoding="utf-8") as f:
        text = f.read()
    anchor = text.find("# Changelog")
    idx = text.find("\n## ", anchor if anchor >= 0 else 0)
    if idx >= 0:
        head, tail = text[: idx + 1], text[idx + 1 :]
    else:
        head, tail = text.rstrip("\n") + "\n\n", ""
    with open("CHANGELOG.md", "w", encoding="utf-8") as f:
        f.write(head + entry + tail)


def set_dockerfile_arg(upstream: str) -> None:
    with open("Dockerfile", encoding="utf-8") as f:
        text = f.read()
    text = re.sub(r"ARG DSH_VERSION=[^\n]*", f"ARG DSH_VERSION={upstream}", text, count=1)
    with open("Dockerfile", "w", encoding="utf-8") as f:
        f.write(text)


def main() -> int:
    track: dict = {}
    if os.path.exists(TRACK_RESULT):
        with open(TRACK_RESULT, encoding="utf-8") as f:
            track = json.load(f)

    status = str(track.get("status", "")).upper()
    cur_up, cur_rev = current_state()

    if status == "UPDATE":
        new_up = track["version"]
        new_rev = 1
        tag = track.get("tag", "")
        commit = track.get("commit", "")
        npm = track.get("npm_version") or new_up
        write_kv(
            "UPSTREAM_VERSION",
            "# 上游版本溯源真值（由 scripts/track-upstream.sh 自动维护）",
            [
                ("UPSTREAM_TAG", tag),
                ("UPSTREAM_VERSION", new_up),
                ("UPSTREAM_COMMIT", commit),
                ("UPSTREAM_REPO", "https://github.com/deepseek-ai/deepseek-harness"),
                ("NPM_VERSION", npm),
                ("TRACKED_AT", TODAY),
            ],
        )
        prepend_changelog(
            f"## {new_up}-r{new_rev}\n"
            f"- 打包版本：`{new_up}-r{new_rev}`（上游发新版本，修订号重置为 1）\n"
            f"- 上游 tag：`{tag}`\n"
            f"- 上游 commit：`{commit}`\n"
            f"- npm 版本：`{npm}`\n"
            f"- 封装时间：{TODAY}\n\n"
        )
        changed = True
        reason = "upstream-update"
    elif FORCE:
        new_up, new_rev = cur_up, cur_rev + 1
        state = read_kv("UPSTREAM_VERSION")
        prepend_changelog(
            f"## {new_up}-r{new_rev}\n"
            f"- 打包版本：`{new_up}-r{new_rev}`（上游未变，重新打包）\n"
            f"- 上游版本：`{new_up}`（commit `{state.get('UPSTREAM_COMMIT', '')}`）\n"
            f"- 封装时间：{TODAY}\n\n"
        )
        changed = True
        reason = "repackage"
    else:
        new_up, new_rev = cur_up, cur_rev
        changed = False
        reason = "no-change"

    full = f"{new_up}-r{new_rev}"
    if changed:
        with open("VERSION", "w", encoding="utf-8") as f:
            f.write(full + "\n")
        with open("PACKAGING_REVISION", "w", encoding="utf-8") as f:
            f.write(f"{new_rev}\n")
        set_dockerfile_arg(new_up)

    print(f"packaging version: {full} (changed={str(changed).lower()}, reason={reason})")

    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"packaging_version={full}\n")
            f.write(f"upstream_version={new_up}\n")
            f.write(f"packaging_revision={new_rev}\n")
            f.write(f"changed={'true' if changed else 'false'}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
