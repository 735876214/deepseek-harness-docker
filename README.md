# deepseek-harness-docker

把 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 `dsh` 启动器封装为**可直接在 NAS / 电脑 Docker 环境拉取运行**的镜像，并**自动跟踪上游版本变化、自动重建并发布新镜像**，全程无需人工重复打包。

- 镜像仓库（GHCR）：`ghcr.io/735876214/deepseek-harness-docker`
- 仅构建 `linux/amd64`（按约定）
- 运行方式与原项目完全一致：`dsh web`（Web UI，默认端口 `3080`）

---

## 1. 快速开始

### 方式 A：docker compose（推荐）

```bash
git clone https://github.com/735876214/deepseek-harness-docker.git
cd deepseek-harness-docker
cp config/dsh.env.example .env     # 按需修改端口/数据目录等
docker compose up -d
```

浏览器打开 `http://<你的主机IP>:3080`。

### 方式 B：一条命令直接拉起

```bash
docker run -d --name deepseek-harness \
  -p 3080:3080 \
  -v dsh-data:/data \
  --restart unless-stopped \
  ghcr.io/735876214/deepseek-harness-docker:latest
```

> 升级时只需 `docker compose pull && docker compose up -d`（compose 已设 `pull_policy: always`）。

---

## 2. 可配置参数

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `IMAGE_TAG` | `latest` | 镜像标签：`latest` / 具体版本如 `0.2.2-alpha.3` / `upstream-<commit7>`（仅 compose/.env 用） |
| `DSH_PROFILE` | `web` | 启动的 profile（如 `web`/`sdk`/`headless`） |
| `DSH_HOST` | 自动（容器 IP） | 监听地址。**留空则由容器自动探测自身 IP 并绑定**——`dsh web` 出于安全拒绝 `0.0.0.0` 通配符，必须绑定具体接口 IP 才能被外部访问；多网卡时也可手动填某个具体 IP |
| `DSH_PORT` | `3080` | 监听端口 |
| `DSH_HOME` | `/data` | 数据目录（持久化卷：profiles、`cordis.patch.yml`、插件） |
| `DSH_EXTRA_ARGS` | 空 | 透传额外 `dsh` 参数，如 `--from-default-profile web` |
| `TZ` | `Asia/Shanghai` | 容器内时区 |
| `HTTP_PROXY` / `HTTPS_PROXY` | 空 | 透传代理（部分模型 API 需走代理） |

示例（`.env`）：

```ini
IMAGE_TAG=latest
DSH_PORT=3080
DSH_PROFILE=web
TZ=Asia/Shanghai
# DSH_EXTRA_ARGS=--from-default-profile web
```

> **远程/反代访问提示**：`dsh web` 带有 `/api` 浏览器信任围栏。若从其他机器或域名访问，
> 可能需要在 `DSH_EXTRA_ARGS` 中加入 `--trusted-host <你的主机或域名>`（可重复），
> 例如：`DSH_EXTRA_ARGS=--trusted-host app.example.com`。

---

## 3. 版本标识与溯源

每个镜像带有以下标签（在 GHCR 可见，也可 `docker inspect` 查看 OCI 标签）：

- `latest`：当前最新已封装的上游版本
- `<upstream-version>`：如 `0.2.2-alpha.3`
- `upstream-<commit7>`：对应上游 commit 短哈希，精确锁定来源

溯源手段（三者一致，互相印证）：

1. **镜像 OCI 标签**：`io.deepseek.upstream.repo` / `io.deepseek.upstream.version` / `io.deepseek.upstream.commit`
2. **仓库文件 `UPSTREAM_VERSION`**：记录上游 tag、版本、commit、npm 版本与跟踪日期
3. **git 标签 `upstream/<version>`**：每次发版打注解标签，指向当次更新提交

```bash
# 查看镜像溯源信息
docker inspect ghcr.io/735876214/deepseek-harness-docker:latest \
  | python -c "import sys,json;l=json.load(sys.stdin)[0]['Config']['Labels'];[print(k,'=',v) for k,v in l.items() if 'deepseek' in k or 'source' in k]"
```

---

## 4. 自动跟踪与发布（无需人工打包）

本仓库通过两个 GitHub Actions 工作流实现全自动更新：

- **`track-update.yml`**（每 6 小时 + 可手动触发）
  1. 调 GitHub API 取上游最新 `dsh-v*` tag，按 semver 取最新；
  2. 确认对应 npm 版本已发布（`@deepseek-ai/dsh`）——未发布则进入 `PENDING` 等待；
  3. 若有新已发布版本：更新 `VERSION` / `UPSTREAM_VERSION` / `Dockerfile` ARG / `CHANGELOG.md`，提交并打 git 标签 `upstream/<version>`，推送。

- **`publish.yml`**（由 `upstream/*` 标签推送或手动触发）
  1. 读取版本与上游 commit；
  2. 用 `docker/build-push-action` 构建 `linux/amd64` 镜像；
  3. 推送到 GHCR，标签 `latest` + 版本 + `upstream-<commit7>`，并写入溯源 OCI 标签。

整个链路：上游发版 → (≤6h) 自动检测到 → 自动改文件+打标签 → 自动构建并发布镜像。你只需在 NAS 上 `docker compose pull && up -d` 即可升级。

> 本地也可手动检查：`bash scripts/track-upstream.sh`，输出 `OK` / `PENDING` / `UPDATE`。

---

## 5. 仓库结构

```
deepseek-harness-docker/
├── Dockerfile                 # node:24-bookworm-slim (amd64) + npm -g @deepseek-ai/dsh
├── docker-compose.yml         # 清晰配置项 + 持久化卷 + 端口
├── entrypoint.sh              # 启动 dsh web --no-open --host --port
├── healthcheck.js             # Node 内置 http 健康检查
├── config/dsh.env.example     # 全部可配置参数示例
├── scripts/
│   ├── track-upstream.sh      # 上游版本跟踪（核心）
│   └── resolve-npm-version.sh # 解析 npm 可安装版本
├── .github/workflows/
│   ├── track-update.yml       # 定时跟踪 + 打标签
│   └── publish.yml            # 构建并发布 GHCR 镜像
├── VERSION / UPSTREAM_VERSION / CHANGELOG.md   # 版本与溯源
├── LICENSE                    # MIT（来自上游）
└── README.md
```

## 6. 许可

本封装以 MIT 许可分发，与上游一致。上游版权 © 2026 DeepSeek。
