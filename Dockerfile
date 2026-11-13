# syntax=docker/dockerfile:1
# DeepSeek Harness (dsh) packaged for Docker.
# 仅构建 linux/amd64（按约定）。上游引擎要求 Node >= 24.9.0。
FROM --platform=linux/amd64 node:24-bookworm-slim

# 上游版本（npm 版本，不带 dsh-v 前缀）。CI 在跟踪到新版本时会改写此处。
ARG DSH_VERSION=0.2.2-rc.3
ENV DSH_VERSION=$DSH_VERSION

# 运行时可配置参数（可在 docker-compose / .env 覆盖）
ENV DSH_HOME=/data \
    DSH_PROFILE=web \
    DSH_PORT=3080 \
    DSH_DSH_PORT=3081 \
    DSH_EXTRA_ARGS="" \
    NODE_ENV=production

# 安装官方已发布的启动器（与 `npx @deepseek-ai/dsh web` 同一产物）。
RUN npm install -g --no-audit --no-fund "@deepseek-ai/dsh@${DSH_VERSION}" \
    && dsh --version || true

WORKDIR /app
COPY healthcheck.js /app/healthcheck.js
COPY auth-gateway.js /app/auth-gateway.js
COPY login.html /app/login.html
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh /app/healthcheck.js /app/auth-gateway.js

# 持久化目录：profiles、cordis.patch.yml、插件等
VOLUME ["/data"]
EXPOSE 3080

# 健康检查探 /login（网关常驻 200），确认鉴权网关存活
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=5 \
    CMD ["node", "/app/healthcheck.js"]

# 入口改为鉴权网关：网关再拉起 dsh（内部回环端口，token 由网关自动注入转发）
ENTRYPOINT ["/app/entrypoint.sh"]
