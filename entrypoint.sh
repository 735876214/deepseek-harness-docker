#!/bin/sh
set -e

# 确保数据目录存在（$DSH_HOME 持久化 profiles/插件/配置）
mkdir -p "${DSH_HOME:-/data}"

# dsh web 拒绝通配符地址（0.0.0.0），必须绑定到本容器某个具体接口 IP，
# 才能被容器外的宿主机/Docker 端口映射访问到。
# 策略：
#   - 若 DSH_HOST 设为某个具体 IP（非 0.0.0.0），直接使用；
#   - 否则（默认）自动探测本容器 IP 作为监听地址。
if [ -n "${DSH_HOST:-}" ] && [ "${DSH_HOST}" != "0.0.0.0" ]; then
  BIND_HOST="$DSH_HOST"
else
  # 取第一个非回环地址；多网卡/多 IP 时优先非 127 的接口地址
  BIND_HOST=$(hostname -i 2>/dev/null | tr ' ' '\n' | grep -v '^127\.' | grep -v '^::1$' | head -1)
  if [ -z "$BIND_HOST" ]; then
    BIND_HOST=$(ip -4 addr show eth0 2>/dev/null | grep -o 'inet [0-9.]*' | awk '{print $2}' | head -1)
  fi
  [ -z "$BIND_HOST" ] && BIND_HOST="127.0.0.1"
fi

echo "dsh: binding web on ${BIND_HOST}:${DSH_PORT:-3080} (profile=${DSH_PROFILE:-web})"

# dsh 只解析自身 flag，其余参数透传给被启动的 profile（web）。
# --no-open：容器内不尝试打开浏览器。
# ${DSH_EXTRA_ARGS} 不加引号，便于透传多个额外参数（如 --trusted-host）。
exec dsh "${DSH_PROFILE:-web}" \
  --no-open \
  --host "$BIND_HOST" \
  --port "${DSH_PORT:-3080}" \
  ${DSH_EXTRA_ARGS}
