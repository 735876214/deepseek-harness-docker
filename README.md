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
| `IMAGE_TAG` | `latest` | 镜像标签：`latest` / 不可变打包版本 `0.2.2-alpha.3-r2` / 上游版本 `0.2.2-alpha.3` / `upstream-<上游commit7>` / `sha-<打包commit7>`（仅 compose/.env 用） |
| `DSH_PROFILE` | `web` | 启动的 profile（如 `web`/`sdk`/`headless`） |
| `DSH_PORT` | `3080` | **鉴权网关**对外监听端口（浏览器访问此端口） |
| `DSH_DSH_PORT` | `3081` | `dsh web` 实际运行的内部端口（仅回环；其 `?token=` 由网关自动抓取并注入转发） |
| `DSH_LOGIN_PASSWORD` | 空（随机生成） | 登录页访问口令。**留空则容器启动随机生成并打印到日志**（`docker logs` 查看），便于首次登录 |
| `DSH_SESSION_SECRET` | 空（随机） | 会话签名密钥。留空 = 每次启动随机（重启需重新登录）；固定后重启仍保持登录态 |
| `DSH_SECURE_COOKIE` | 空 | 纯 HTTP（如局域网直连）留空；TLS 反代场景设为 `1` 给 Cookie 加 `Secure`。HTTPS 下必须设，否则浏览器不回传 Cookie 导致 401 |
| `DSH_REWRITE_ORIGIN` | `1`（本修改版新增） | 把转发给 dsh 的 `Host`/`Origin` 重写为内部 loopback，放行局域网/反代下的「添加工作区」。设 `0` 恢复官方透传行为（远程添加工作区会 403）。详见第 2.1 节 |
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
> 让登录 Cookie 带 `Secure` 标记。本修改版网关在转发层统一声明 loopback 来源（见 2.1），
> **无需**再给 `dsh` 配 `--trusted-host`（该参数在新版 dsh 上本来也是空转）。

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

### 2.1 远程访问：局域网 IP / 反向代理下添加工作区（本修改版重点）

#### 背景与两个典型报错

上游 `dsh` 出于安全，把「目录选择/列举」类接口（`directoryPicker/list`、`host.pickDirectory`、
`host.listDirectory`、`workspace.create` 等）列为 **loopback-only 特权方法**——以空 trusted-host
列表评估，**只接受来自 `127.0.0.1`/`localhost` 的请求**。官方封装网关原样透传浏览器的 Host，
于是从局域网 IP 或反代域名访问时会出现：

| 访问方式 | 报错 | 触发环节 |
|---|---|---|
| `http://192.168.x.x:3080/` | `client api: directoryPicker/list failed: transport failure for /api/directoryPicker/list: HTTP 403` | dsh 的 Host/Origin 来源围栏（特权接口只认 loopback） |
| 反代 `https://域名/` | `dsh web authentication required; reopen the URL printed by dsh web` | 会话 Cookie 因 `Domain`/协议不匹配未保存，token 注入链断裂后的 401 |

#### 修改版做了什么（不改动官方 dsh）

仅改造 `auth-gateway.js` 的转发层，**dsh 二进制与启动参数完全不动**：

1. **Host/Origin 重写**（核心，`DSH_REWRITE_ORIGIN=1`）：网关把转发给 dsh 的请求头
   `Host`/`Origin`/`Referer` 统一改写为 `http://127.0.0.1:<DSH_DSH_PORT>`，并移除
   `X-Forwarded-*`/`X-Real-IP`/`Forwarded`，让 dsh 的信任围栏把请求当作本机请求 → 403 消失。
   HTTP 与 WebSocket upgrade 两条路径都生效。真正的访问控制由**网关自身的登录鉴权**承担。
2. **对外重定向地址修正**：`Location` 中的内部回环地址改写为**对外完整 origin**（含协议），
   协议优先取 `X-Forwarded-Proto`，其次按 `DSH_SECURE_COOKIE` 推断，避免 HTTPS 反代下跳到 http。
3. **Cookie 清洗**：去掉 dsh 下发 Cookie 的 `Domain` 属性使其成为 host-only，浏览器按实际
   访问的外部域名保存并带回，避免反复注入 token 导致的 401；HTTPS 下补 `Secure`。
4. **token 抓取正则放宽**：兼容不同上游版本的 token 字符，避免抓不到导致 401。

#### 部署步骤

```bash
# 1. 编辑 .env（关键三项）
#   DSH_REWRITE_ORIGIN=1         # 默认即开启
#   DSH_LOGIN_PASSWORD=<强口令>  # 必须固定
#   DSH_SESSION_SECRET=<长随机串> # 必须固定，否则重启掉登录
#   DSH_SECURE_COOKIE=1          # 反代 HTTPS 场景

# 2. 用修改后的源码构建并启动（见下方「从源码构建」）
docker compose build && docker compose up -d

# 3. 看日志确认开关生效、口令与 token 正常
docker logs -f deepseek-harness | grep -E "origin rewrite|login password|dsh-gateway"
# 期望出现: dsh-gateway: origin rewrite = ON (...)

# 4. 浏览器访问并登录，然后测试「添加工作区」是否不再 403
```

#### 反向代理关键配置（以 Nginx / lucky 等为例）

反代必须正确传递 Host、协议与外部地址，否则第 2、3 项修正无法生效：

```nginx
location / {
    proxy_pass http://127.0.0.1:3080;          # 指向网关对外端口，不是内部 3081
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Host  $host;
    proxy_set_header X-Forwarded-Proto $scheme;   # HTTPS 反代时为 https
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;

    # WebSocket 转发（dsh 的流式 RPC 依赖 upgrade）
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;                    # 长连接不要过早断开
    proxy_buffering off;
}
```

检查清单：反代目标端口 = `DSH_PORT`（默认 3080）；`X-Forwarded-Proto=https`；WebSocket
的 `Upgrade`/`Connection` 头已透传；`DSH_SECURE_COOKIE=1`；口令与会话密钥已固定。

#### 从源码构建（本修改版）

GHCR 上的官方镜像**不含本修改**。本修改版需从仓库源码本地构建（仅 amd64）。
仓库已提供 `docker-compose.local.yml`（带 `build` 段），一条命令完成构建与启动：

```bash
cp config/dsh.env.example .env    # 按实际情况填写
docker compose -f docker-compose.local.yml up -d --build
```

该 compose 会本地构建 `auth-gateway.js` 修改后的镜像（标签 `deepseek-harness-docker:local`），
不包含 `pull_policy: always`，避免启动时把本地镜像覆盖回官方镜像。升级官方 dsh 时同步
`Dockerfile` 里的 `DSH_VERSION` 后重新 `--build` 即可，网关改造与 dsh 版本解耦。

> 安全说明：来源重写意味着「能通过网关登录的人即拥有本机特权接口权限」。务必设置强口令、
> 固定会话密钥，并仅在可信范围暴露；网关已实现口令校验、限速、会话过期等防护作为边界。

---

## 3. 版本标识与溯源

### 版本模型

```
打包版本 = <上游版本>-r<打包修订号>          例：0.2.2-alpha.3-r2
           └ 上游 dsh 版本      └ 第几次打包该版本

上游发新版本            → 修订号重置为 1     （0.2.2-alpha.3-r1 → 0.2.3-r1）
上游未变、重新打包(force) → 修订号 +1         （0.2.2-alpha.3-r1 → 0.2.2-alpha.3-r2）
```

**每个打包版本唯一且不可变**，对应一次镜像构建 + 一个 git 注解标签 `upstream/<打包版本>`，
两者严格一一对应。真值文件：`VERSION`（打包版本）、`PACKAGING_REVISION`（修订号）、
`UPSTREAM_VERSION`（上游 tag/commit/npm 版本）。

### 镜像标签

| 标签 | 示例 | 可变性 | 用途 |
|---|---|---|---|
| `latest` | `latest` | 浮动 | 始终指向最新构建，NAS 日常升级用 |
| `<打包版本>` | `0.2.2-alpha.3-r2` | **不可变** | 精确锁定到某一次打包（可复现） |
| `<上游版本>` | `0.2.2-alpha.3` | 浮动别名 | 该上游版本的最新打包 |
| `upstream-<上游commit7>` | `upstream-05b1cae` | 不可变 | 上游源码来源 |
| `sha-<打包commit7>` | `sha-9f3c1ab` | 不可变 | 产出该镜像的本仓库提交 |

生产环境建议钉死不可变标签，例如：

```yaml
image: ghcr.io/735876214/deepseek-harness-docker:0.2.2-alpha.3-r2
```

### 溯源手段（互相印证）

1. **镜像 OCI 标签**
   - 上游来源：`io.deepseek.upstream.repo` / `io.deepseek.upstream.version` / `io.deepseek.upstream.commit`
   - 打包来源：`io.deepseek.packaging.version` / `io.deepseek.packaging.revision`，
     以及标准 `org.opencontainers.image.revision`（= 构建该镜像的打包仓库提交）
2. **仓库文件**：`VERSION`（打包版本）、`PACKAGING_REVISION`（修订号）、
   `UPSTREAM_VERSION`（上游 tag、版本、commit、npm 版本、跟踪日期）
3. **git 标签 `upstream/<打包版本>`**：每次打包打一个注解标签，指向当次发布提交

```bash
# 查看镜像溯源信息
docker inspect ghcr.io/735876214/deepseek-harness-docker:latest \
  | python -c "import sys,json;l=json.load(sys.stdin)[0]['Config']['Labels'];[print(k,'=',v) for k,v in l.items() if 'deepseek' in k or 'opencontainers' in k]"
```

校验三元组是否一致（本地）：

```bash
echo "$(cat UPSTREAM_VERSION | grep '^UPSTREAM_VERSION=' | cut -d= -f2)-r$(cat PACKAGING_REVISION)"  # 应等于 cat VERSION
```

---

## 4. 自动跟踪与发布（无需人工打包）

本仓库通过两个 GitHub Actions 工作流实现全自动更新：

- **`track-update.yml`**（每 6 小时 + 可手动触发）
  1. 调 GitHub API 取上游最新 `dsh-v*` tag，按 semver 取最新；
  2. 确认对应 npm 版本已发布（`@deepseek-ai/dsh`）——未发布则进入 `PENDING` 等待；
  3. 由 `scripts/prepare-packaging-version.py` 推导打包版本：新上游版本 → 修订号重置为 `1`；
     手动 `force` → 修订号 `+1`；两者都更新 `VERSION` / `PACKAGING_REVISION` /
     `UPSTREAM_VERSION` / `Dockerfile` ARG / `CHANGELOG.md` 并提交；
  4. 打 git 注解标签 `upstream/<打包版本>` 并推送；
  5. **紧接着显式触发 `publish.yml`**（`gh workflow run`）。这一步是必须的：GitHub 规定
     **用 `GITHUB_TOKEN` 推送 tag 不会再触发其他工作流**，单靠 `push: tags` 指望 `publish.yml`
     自动跑起来是行不通的（会静默断链）。

- **`publish.yml`**（由 `track-update.yml` 派发 / `upstream/*` 标签推送 / 手动触发）
  1. 读取打包版本、上游版本、npm 版本与上游 commit，并**校验** `VERSION == <上游版本>-r<修订号>`
     （不一致直接失败，防止版本文件漂移）；
  2. 用 `docker/build-push-action` 构建 `linux/amd64` 镜像（`--build-arg DSH_VERSION=<npm 版本>`）；
  3. 推送到 GHCR：`latest` + `<打包版本>` + `<上游版本>` + `upstream-<上游commit7>` +
     `sha-<打包commit7>`，并写入上游/打包两类溯源 OCI 标签；
  4. 校验 GHCR 包可见性，若为 `private` 会输出告警（GitHub 没有改可见性的 REST 端点，
     首次发布后如需公开请在包设置里改一次）。

**手动重新打包**（改了封装代码但上游未变时）：

```bash
# GitHub → Actions → "Track Upstream & Tag" → Run workflow → force 勾选
# 结果：修订号 +1（如 -r1 → -r2），新 tag upstream/<打包版本>，自动触发镜像构建发布
```

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
│   ├── track-upstream.sh            # 上游版本跟踪（核心）
│   ├── prepare-packaging-version.py # 推导打包版本 <上游>-r<修订号>，落地版本文件
│   └── resolve-npm-version.sh       # 解析 npm 可安装版本
├── .github/workflows/
│   ├── track-update.yml       # 定时跟踪 + 递增修订号 + 打标签 + 触发发布
│   └── publish.yml            # 构建并发布 GHCR 镜像
├── VERSION / PACKAGING_REVISION / UPSTREAM_VERSION / CHANGELOG.md   # 版本与溯源
├── LICENSE                    # MIT（来自上游）
└── README.md
```

## 6. 许可

本封装以 MIT 许可分发，与上游一致。上游版权 © 2026 DeepSeek。
