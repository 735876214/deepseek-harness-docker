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
- 打包增强：内置零依赖 Node 鉴权网关（`auth-gateway.js` + `login.html`），以登录页与会话 Cookie 取代 `dsh web` 每次都要的 `?token=`，dsh 改在内部端口经 `--trusted-host` 免 token 转发。
