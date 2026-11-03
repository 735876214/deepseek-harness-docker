# Changelog

本仓库封装 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
的 `dsh` 启动器为可分发 Docker 镜像。每条记录对应一次上游发版。

镜像标签（发布到 GHCR `ghcr.io/735876214/deepseek-harness-docker`）：
- `latest`：当前最新已封装版本
- `<upstream-version>`：如 `0.2.2-alpha.3`
- `upstream-<commit7>`：对应上游 commit 短哈希，便于精确溯源

溯源方式：镜像 OCI 标签 `io.deepseek.upstream.*`、本文件 `UPSTREAM_VERSION`、以及 git 标签 `upstream/<version>`。

## 0.2.2-alpha.3
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
