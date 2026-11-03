// 轻量健康检查：请求 dsh web 实际监听的地址，能连通即视为健康。
// 用 Node 内置 http + child_process，避免镜像额外安装 wget/curl。
//
// 注意：dsh web 拒绝 0.0.0.0，监听的是本容器具体接口 IP，
// 因此健康检查也要连到该地址（而非 127.0.0.1）。
const http = require('http');
const { execSync } = require('child_process');

function containerIP() {
  try {
    const out = execSync('hostname -i 2>/dev/null')
      .toString()
      .trim()
      .split(/\s+/);
    const cand = out.find((x) => x && x !== '127.0.0.1' && x !== '::1');
    return cand || '127.0.0.1';
  } catch (e) {
    return '127.0.0.1';
  }
}

const host = process.env.DSH_HEALTH_HOST || containerIP();
const port = parseInt(process.env.DSH_PORT || '3080', 10);
const path = process.env.DSH_HEALTH_PATH || '/';

const req = http.get(
  { host, port, path, timeout: 8000 },
  (res) => {
    // 2xx/3xx 视为健康；4xx 也说明服务已起来（鉴权/路由层面）
    const ok = res.statusCode >= 200 && res.statusCode < 500;
    res.resume();
    process.exit(ok ? 0 : 1);
  }
);

req.on('timeout', () => {
  req.destroy();
  process.exit(1);
});

req.on('error', () => {
  process.exit(1);
});
