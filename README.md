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
| `DSH_PORT` | `3080` | **鉴权网关**对外监听端口（浏览器访问此端口） |
| `DSH_DSH_PORT` | `3081` | `dsh web` 实际运行的内部端口（仅回环；其 `?token=` 由网关自动抓取并注入转发） |
| `DSH_LOGIN_PASSWORD` | 空（随机生成） | 登录页访问口令。**留空则容器启动随机生成并打印到日志**（`docker logs` 查看），便于首次登录 |
| `DSH_SESSION_SECRET` | 空（随机） | 会话签名密钥。留空 = 每次启动随机（重启需重新登录）；固定后重启仍保持登录态 |
| `DSH_SECURE_COOKIE` | 空 | 在 TLS 反向代理之后运行时设为 `1`，给登录 Cookie 加 `Secure` 标记 |
| `DSH_LOGIN_MAX_FAILS` | `8` | 同一 IP 连续登录失败次数上限，超过即锁定 |
| `DSH_LOGIN_LOCK_SECONDS` | `300` | 触发上限后的锁定时长（秒） |
| `DSH_HOME` | `/data` | 数据目录（持久化卷：profiles、`cordis.patch.yml`、插件） |
| `DSH_EXTRA_ARGS` | 空 | 透传额外 `dsh` 参数，如 `--from-default-profile web` |
| `TZ` | `Asia/Shanghai` | 容器内时区 |
| `HTTP_PROXY` / `HTTPS_PROXY` | 空 | 透传代理（部分模型 API 需走代理） |

示例（`.env`）：

```ini
IMAGE_TAG=latest
DSH_PORT=3080
DSH_DSH_PORT=3081
DSH_PROFILE=web
DSH_LOGIN_PASSWORD=        # 留空=首次启动随机生成，见 docker logs
TZ=Asia/Shanghai
# DSH_EXTRA_ARGS=--from-default-profile web
```

### 登录页（免 token 访问）

本镜像在 `dsh web` 前内置了一个**零依赖的鉴权网关**，用来取代每次都要从日志里抄的 `?token=…`：

- 浏览器访问 `http://<主机IP>:3080/`（或任意路径）会自动跳到 `/login` 登录页；
- 输入**访问口令**后，网关签发一个会话 Cookie，之后 30 天内免登录；
- `dsh web` 仍在内部端口运行并自带 token 围栏。网关启动时会从 `dsh` 的日志中抓取它打印的 session token，并**透明地注入到每一个转发给 dsh 的请求**上，同时改写 dsh 返回的重定向地址（去掉 token、换回对外地址）。因此终端用户**完全无需接触那个 `?token=…`**。

登录口令：

- 未设置 `DSH_LOGIN_PASSWORD` 时，容器启动时随机生成一个并打印到日志：
  ```bash
  docker logs <容器名> | grep "login password"
  ```
- 生产环境建议在 `.env` 里固定 `DSH_LOGIN_PASSWORD`，并固定 `DSH_SESSION_SECRET`（否则容器重启后会话失效、且口令也会变）。
- 退出登录访问 `/logout` 即可。

> **生产环境务必加 TLS**：`dsh web` 与网关本身都只提供明文 HTTP。对外暴露时，
> 请在前面再套一层反向代理（Caddy / Nginx）做 HTTPS，并把 `DSH_SECURE_COOKIE` 设为 `1`，
> 让登录 Cookie 带 `Secure` 标记。网关已处理 `/api` 信任围栏，无需再给 `dsh` 配 `--trusted-host`。

### 安全边界（网关已实现的防护）

| 项目 | 行为 |
|---|---|
| 口令校验 | 常量时间比较，不因长度/内容泄漏时序信息 |
| 暴力破解 | 同 IP 连续失败 `DSH_LOGIN_MAX_FAILS` 次后锁定 `DSH_LOGIN_LOCK_SECONDS` 秒，返回 `429` + `Retry-After` |
| 会话 Cookie | `HttpOnly` + `SameSite=Lax`，签名内含时间戳，**服务端可校验过期（30 天）**，不是只靠浏览器 Max-Age |
| 畸形输入 | Cookie 百分号编码异常、畸形 HTTP 请求、超长请求体（>4KB）均被安全处理，**不会打崩网关** |
| 登录页 | 带 `CSP`（禁止脚本）、`X-Frame-Options: DENY`（防点击劫持）、`X-Content-Type-Options: nosniff` |
| 日志 | 转发日志中的 `?token=` 已遮蔽为 `token=***`，避免凭据长期留在 `docker logs` |
| 错误信息 | 上游代理失败只返回 `502`，不回显内部地址/端口 |

> 注意：限速以**直连来源 IP** 计数（不信任 `X-Forwarded-For`，避免伪造绕过）。
> 若前面套了反向代理，所有请求的来源 IP 都是代理地址，等价于全局限速——单用户场景下这符合预期。

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
  3. 若有新已发布版本：更新 `VERSION` / `UPSTREAM_VERSION` / `Dockerfile` ARG / `CHANGELOG.md`，提交并打 git 标签 `upstream/<version>`，推送；
  4. **紧接着显式触发 `publish.yml`**（`gh workflow run`）。这一步是必须的：GitHub 规定
     **用 `GITHUB_TOKEN` 推送 tag 不会再触发其他工作流**，单靠 `push: tags` 指望 `publish.yml`
     自动跑起来是行不通的（会静默断链）。

- **`publish.yml`**（由 `track-update.yml` 派发 / `upstream/*` 标签推送 / 手动触发）
  1. 读取版本与上游 commit；
  2. 用 `docker/build-push-action` 构建 `linux/amd64` 镜像；
  3. 推送到 GHCR，标签 `latest` + 版本 + `upstream-<commit7>`，并写入溯源 OCI 标签；
  4. 校验 GHCR 包可见性，若为 `private` 会输出告警（GitHub 没有改可见性的 REST 端点，
     首次发布后如需公开请在包设置里改一次）。

整个链路：上游发版 → (≤6h) 自动检测到 → 自动改文件+打标签 → 自动构建并发布镜像。你只需在 NAS 上 `docker compose pull && up -d` 即可升级。

> 本地也可手动检查：`bash scripts/track-upstream.sh`，输出 `OK` / `PENDING` / `UPDATE`。

---

## 5. 仓库结构

```
deepseek-harness-docker/
├── Dockerfile                 # node:24-bookworm-slim (amd64) + npm -g @deepseek-ai/dsh
├── docker-compose.yml         # 清晰配置项 + 持久化卷 + 端口
├── entrypoint.sh              # 拉起鉴权网关（网关再启动 dsh）
├── auth-gateway.js            # 零依赖 Node 鉴权网关：登录页 / 会话校验 / 反向代理 dsh
├── login.html                 # 登录页
├── healthcheck.js             # Node 内置 http 健康检查（探 /login）
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
