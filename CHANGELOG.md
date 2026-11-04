# Changelog

本仓库封装 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
的 `dsh` 启动器为可分发 Docker 镜像。每条记录对应一次上游发版。

版本模型：**打包版本 = `<上游版本>-r<打包修订号>`**（如 `0.2.2-alpha.3-r2`）。
上游发新版本时修订号重置为 `1`；同一上游版本重新打包（`force`）时修订号 `+1`。
因此每个「打包版本」唯一，对应一次不可变镜像构建。

镜像标签（发布到 GHCR `ghcr.io/735876214/deepseek-harness-docker`）：
- `latest`：当前最新打包版本（浮动）
- `<打包版本>`：如 `0.2.2-alpha.3-r2`，**不可变**，与 git 标签 `upstream/<打包版本>` 一一对应
- `<上游版本>`：如 `0.2.2-alpha.3`，浮动别名，指向该上游版本的最新一次打包
- `upstream-<上游commit7>`：上游源码来源
- `sha-<打包commit7>`：产出该镜像的本仓库提交

溯源方式：镜像 OCI 标签 `io.deepseek.upstream.*` / `io.deepseek.packaging.*`、
本目录 `UPSTREAM_VERSION` 与 `PACKAGING_REVISION`、以及 git 标签 `upstream/<打包版本>`。

## 0.2.2-alpha.3-r1
- 上游 tag：`dsh-v0.2.2-alpha.3`
- 上游 commit：`05b1cae8db6e674c5685101494d4eec24652424a`
- npm 版本：`0.2.2-alpha.3`
- 初始封装版本（Node 24 基础镜像，仅 amd64）。
- 打包增强：内置零依赖 Node 鉴权网关（`auth-gateway.js` + `login.html`），以登录页与会话 Cookie 取代 `dsh web` 每次都要的 `?token=`；dsh 仅在内部回环运行，其 token 由网关从启动日志抓取并透明注入转发。

### 审计修复（安全与自动化）

- **修复远程 DoS**：畸形 Cookie（如 `dsh_sess=%`）会让 `decodeURIComponent` 抛 `URIError`
  并直接终止网关进程——任何未认证请求都能打崩服务。改为安全解码 + 请求级异常兜底 +
  `clientError` 处理。
- **新增登录暴力破解防护**：同 IP 连续失败 8 次锁定 300 秒（`DSH_LOGIN_MAX_FAILS` /
  `DSH_LOGIN_LOCK_SECONDS`），返回 `429` + `Retry-After`。
- **会话支持服务端过期**：签名内含时间戳（`id.ts.sig`），30 天到期后服务端即拒绝，
  不再是「只要 Cookie 被窃取就永久有效」。（升级后旧格式 Cookie 失效，需重新登录一次。）
- **新增安全响应头**：登录页 `CSP`、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、
  `Referrer-Policy: no-referrer`。
- **日志脱敏**：转发日志中的 `?token=` 遮蔽为 `token=***`。
- **移除无效参数**：`dsh web --trusted-host` 在该版本并不解除 token 围栏，删除该空转参数，
  并修正 Dockerfile / compose / env 示例 / README 中「靠 --trusted-host 免 token」的错误描述。
- **修复自动发布断链**：`GITHUB_TOKEN` 推送 tag 不会触发其他工作流，`publish.yml` 实际从未被
  `track-update.yml` 自动唤起。改为在跟踪工作流末尾显式 `gh workflow run publish.yml`，
  并补 `actions: write` 权限；`force` 重跑时对已存在标签做跳过判断，避免失败。
- **修复无效的 GHCR 公开性步骤**：`PUT/PATCH /user/packages/.../visibility` 实测均为 `404`
  （该端点不存在），原步骤被 `|| true` 静默掩盖。改为真实校验可见性并显式告警。

### 打包版本号：引入修订号（`-rN`）

此前同一个上游版本多次重新打包（改网关、修安全漏洞）时，镜像的 `0.2.2-alpha.3` 标签会被
最新构建覆盖，而 git 标签 `upstream/0.2.2-alpha.3` 仍指向首次打包提交，两者无法一一对应。

- 新增 `PACKAGING_REVISION` 文件与 `scripts/prepare-packaging-version.py`，打包版本改为
  `<上游版本>-r<修订号>`（本次即 `0.2.2-alpha.3-r1`）。
- 上游发新版本 → 修订号重置为 1；`force` 重新打包 → 修订号 +1，并各自打唯一 git 标签
  `upstream/<打包版本>`。
- 镜像新增不可变标签 `<打包版本>` 与 `sha-<打包commit7>`，并补 OCI 标签
  `io.deepseek.packaging.version` / `io.deepseek.packaging.revision`；
  `<上游版本>` 保留为浮动别名（指向该上游版本的最新打包）。
- `publish.yml` 增加版本一致性校验：`VERSION` 必须等于 `<上游版本>-r<修订号>`，否则直接失败，
  避免版本文件漂移；同时修正 `DSH_VERSION` 构建参数改用 npm 上游版本（不能用带 `-rN` 的打包版本）。
- 修复 `CHANGELOG.md` 追加逻辑会截断历史条目的缺陷（原写法 `body + entry` 丢了尾部）。
