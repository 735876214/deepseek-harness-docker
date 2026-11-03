#!/bin/sh
set -e

# 确保数据目录存在（$DSH_HOME 持久化 profiles/插件/配置）
mkdir -p "${DSH_HOME:-/data}"

# 启动鉴权网关：网关负责拉起 dsh web（内部端口 + --trusted-host 免 token），
# 并在对外端口提供登录页与会话校验。
exec node /app/auth-gateway.js
