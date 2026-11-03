#!/usr/bin/env node
'use strict';

// 零依赖 Node 鉴权网关：
//   - 对外监听 DSH_PORT（默认 3080），提供登录页 /login 与会话校验。
//   - dsh web 在内部回环 127.0.0.1:DSH_DSH_PORT 运行（其 token 围栏仍在）。
//   - 网关从 dsh 启动日志抓取 session token，透明注入到每个转发请求，
//     使终端用户完全无需接触那个 ?token=…（详见 injectToken）。
//   - 校验通过后用 HMAC 自校验 Cookie 维持会话，用户只需登录一次。
//
// 仅使用 Node 内置模块，不引入任何第三方依赖，保持镜像轻量。

const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const querystring = require('querystring');

// ---------------- 配置 ----------------
const PORT = parseInt(process.env.DSH_PORT || '3080', 10);        // 对外暴露端口
const DSH_PORT = parseInt(process.env.DSH_DSH_PORT || '3081', 10);// dsh 内部端口（仅回环）
const DSH_HOST = '127.0.0.1';                                    // dsh 只监听回环
const PROFILE = process.env.DSH_PROFILE || 'web';
const EXTRA_ARGS = process.env.DSH_EXTRA_ARGS || '';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;                       // 会话 30 天
const COOKIE_NAME = 'dsh_sess';
const SECRET = process.env.DSH_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SECURE_COOKIE = process.env.DSH_SECURE_COOKIE === '1';

// 登录暴力破解防护：同一来源 IP 连续失败 N 次后锁定一段时间
const LOGIN_MAX_FAILS = parseInt(process.env.DSH_LOGIN_MAX_FAILS || '8', 10);
const LOGIN_LOCK_SECONDS = parseInt(process.env.DSH_LOGIN_LOCK_SECONDS || '300', 10);
const MAX_LOGIN_BODY = 4096;                                     // 登录表单最多 4KB

// 口令：未设置则随机生成并打印，保证总能登录一次设置。
let PASSWORD = process.env.DSH_LOGIN_PASSWORD || '';
if (!PASSWORD) {
  PASSWORD = crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
}

const LOGIN_HTML = fs.readFileSync(path.join(__dirname, 'login.html'), 'utf8');

// ---------------- 会话工具 ----------------
function hmac(s) {
  return crypto.createHmac('sha256', SECRET).update(s).digest('hex');
}

// 会话形如 id.ts.sig；ts 参与签名，使 Cookie 具备服务端可校验的过期时间，
// 避免「Cookie 被窃取后永久有效」。
function makeSession() {
  const id = crypto.randomBytes(16).toString('hex');
  const ts = Math.floor(Date.now() / 1000);
  const payload = id + '.' + ts;
  return payload + '.' + hmac(payload);
}

function validSession(cookie) {
  if (!cookie || typeof cookie !== 'string') return false;
  const parts = cookie.split('.');
  if (parts.length !== 3) return false;
  const [id, ts, sig] = parts;
  if (!id || !ts || !sig) return false;
  if (!/^\d+$/.test(ts)) return false;
  const expected = hmac(id + '.' + ts);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const age = Math.floor(Date.now() / 1000) - parseInt(ts, 10);
  return age >= 0 && age <= SESSION_MAX_AGE;
}

function sha256(s) { return crypto.createHash('sha256').update(s || '').digest(); }

function passwordOk(pw) {
  const a = sha256(pw);
  const b = sha256(PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 安全解码：畸形百分号编码（如 "%"）会让 decodeURIComponent 抛 URIError，
// 未捕获会直接终止进程 —— 任何人都能借此打崩网关，故必须兜住。
function safeDecode(v) {
  try {
    return decodeURIComponent(v);
  } catch (e) {
    return null;
  }
}

function getCookie(req, name) {
  const c = req.headers.cookie;
  if (!c || typeof c !== 'string') return undefined;
  for (const part of c.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (k !== name) continue;
    return safeDecode(part.slice(idx + 1).trim());
  }
  return undefined;
}

function cookieFlags() {
  let f = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`;
  if (SECURE_COOKIE) f += '; Secure';
  return f;
}

// 登录页/跳转响应统一带上基础安全响应头
function baseHeaders(extra) {
  return Object.assign(
    {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    },
    extra || {}
  );
}

// ---------------- 登录失败限速 ----------------
const failState = new Map(); // ip -> { n, until }

function clientIP(req) {
  const a = (req.socket && req.socket.remoteAddress) || 'unknown';
  return a.replace(/^::ffff:/, '');
}

function lockInfo(ip) {
  const st = failState.get(ip);
  if (!st) return 0;
  if (st.until && st.until > Date.now()) return Math.ceil((st.until - Date.now()) / 1000);
  return 0;
}

function noteFail(ip) {
  const now = Date.now();
  let st = failState.get(ip);
  if (!st || (st.until && st.until <= now && st.n >= LOGIN_MAX_FAILS)) st = { n: 0, until: 0 };
  st.n += 1;
  if (st.n >= LOGIN_MAX_FAILS) {
    st.until = now + LOGIN_LOCK_SECONDS * 1000;
    st.n = 0;
    console.log(`dsh-gateway: [${ip}] 登录失败达上限，锁定 ${LOGIN_LOCK_SECONDS}s`);
  }
  failState.set(ip, st);
  // 防止 Map 无限增长
  if (failState.size > 2000) {
    for (const [k, v] of failState) {
      if (!v.until || v.until <= now) failState.delete(k);
    }
  }
}

function clearFail(ip) { failState.delete(ip); }

// ---------------- 反向代理到 dsh ----------------
// dsh 仍在内部端口运行并自带 token 围栏；网关在启动时从 dsh 日志里抓取它打印的
// session token，透明地注入到每个转发请求上，使终端用户完全无需接触 token。
let dshToken = '';

function injectToken(targetPath, cookieHeader) {
  if (!dshToken) return targetPath;
  // 已持有 dsh 下发的会话 Cookie：直接透传，不再注入 token。
  // 否则 dsh 对 “/” 会一直 303 -> “/” 形成重定向死循环，且 /api 也靠此 Cookie 鉴权。
  if (cookieHeader && /(^|;\s*)dsh-auth-/.test(cookieHeader)) return targetPath;
  if (/([?&]token=)/.test(targetPath)) return targetPath; // 已有 token 则不重复
  return targetPath + (targetPath.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(dshToken);
}

function buildProxyHeaders(req) {
  // 保留浏览器侧原始 Host：让 dsh 生成的重定向 Location 指向对外地址，而非内部回环
  const headers = { ...req.headers };
  // 去掉网关自己的会话 Cookie，dsh 不需要
  if (headers.cookie) {
    const cleaned = headers.cookie
      .split(';')
      .filter((c) => !c.trim().startsWith(COOKIE_NAME + '='))
      .join(';')
      .trim();
    if (cleaned) headers.cookie = cleaned; else delete headers.cookie;
  }
  delete headers.connection;
  return headers;
}

// 改写 dsh 返回的重定向 Location：去除 token 保持地址栏干净，并把内部地址替换为对外地址
function cleanLocation(loc, externalHost) {
  if (!loc) return loc;
  let s = loc.replace(/([?&])token=[^&]+(&|$)/g, (m, p, end) => (end === '&' ? p : ''));
  s = s.replace(/^[?&]/, '').replace(/[?&]$/, '');
  s = s.replace(new RegExp('127\\.0\\.0\\.1:' + DSH_PORT, 'g'), externalHost);
  s = s.replace(new RegExp(DSH_HOST + ':' + DSH_PORT, 'g'), externalHost);
  return s;
}

function proxyRequest(req, res) {
  const externalHost = req.headers.host || '127.0.0.1:' + PORT;
  const targetPath = injectToken(req.url, req.headers.cookie);
  const proxyReq = http.request(
    { host: DSH_HOST, port: DSH_PORT, path: targetPath, method: req.method, headers: buildProxyHeaders(req) },
    (proxyRes) => {
      const headers = { ...proxyRes.headers };
      delete headers.connection;
      delete headers['transfer-encoding'];
      delete headers['content-length']; // 交由 Node 重新计算
      if (headers.location) headers.location = cleanLocation(headers.location, externalHost);
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on('error', (e) => {
    // 内部错误只记日志，不回显给客户端（避免泄漏内部地址/端口）
    console.error('dsh-gateway: proxy error:', e.message);
    if (!res.headersSent) {
      res.writeHead(502, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
      res.end('Bad gateway');
    } else {
      res.destroy();
    }
  });
  // 客户端提前断开时释放上游连接
  res.on('close', () => { if (!res.writableEnded) proxyReq.destroy(); });
  req.pipe(proxyReq);
}

function proxyUpgrade(req, socket) {
  const targetPath = injectToken(req.url, req.headers.cookie);
  const proxyReq = http.request({
    host: DSH_HOST,
    port: DSH_PORT,
    path: targetPath,
    method: req.method,
    headers: buildProxyHeaders(req),
  });
  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    socket.write(`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`);
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (Array.isArray(v)) v.forEach((x) => socket.write(`${k}: ${x}\r\n`));
      else socket.write(`${k}: ${v}\r\n`);
    }
    socket.write('\r\n');
    if (proxyHead && proxyHead.length) proxySocket.write(proxyHead);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
    proxySocket.on('error', () => socket.destroy());
    socket.on('error', () => proxySocket.destroy());
  });
  proxyReq.on('error', () => socket.destroy());
  req.pipe(proxyReq); // 转发初始 upgrade 请求体（如有）
}

// ---------------- HTTP 服务 ----------------
const server = http.createServer((req, res) => {
  try {
    handleRequest(req, res);
  } catch (e) {
    // 兜底：任何意外异常都不应打崩整个网关
    console.error('dsh-gateway: unhandled request error:', e && e.message);
    if (!res.headersSent) {
      res.writeHead(500, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
      res.end('Internal error');
    } else {
      res.destroy();
    }
  }
});

function handleRequest(req, res) {
  const url = req.url.split('?')[0];
  const ip = clientIP(req);

  if (url === '/login') {
    if (req.method === 'GET') {
      // 已登录直接进应用
      if (validSession(getCookie(req, COOKIE_NAME))) {
        res.writeHead(302, baseHeaders({ Location: '/' }));
        return res.end();
      }
      const csp = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'";
      res.writeHead(200, baseHeaders({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp }));
      return res.end(LOGIN_HTML);
    }
    if (req.method === 'POST') {
      const wait = lockInfo(ip);
      if (wait > 0) {
        res.writeHead(429, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': String(wait) }));
        return res.end(`尝试过于频繁，请 ${wait} 秒后重试`);
      }

      let body = '';
      let aborted = false;
      req.on('data', (c) => {
        if (aborted) return;
        body += c;
        if (body.length > MAX_LOGIN_BODY) {
          aborted = true;
          noteFail(ip);
          res.writeHead(413, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
          res.end('Payload too large');
          req.destroy();
        }
      });
      req.on('end', () => {
        if (aborted) return;
        const pw = querystring.parse(body).password || '';
        if (typeof pw === 'string' && passwordOk(pw)) {
          clearFail(ip);
          const cookie = makeSession();
          res.writeHead(302, baseHeaders({
            Location: '/',
            'Set-Cookie': `${COOKIE_NAME}=${cookie}; ${cookieFlags()}`,
          }));
          return res.end();
        }
        noteFail(ip);
        res.writeHead(200, baseHeaders({ 'Content-Type': 'text/html; charset=utf-8' }));
        return res.end(LOGIN_HTML.replace('<!--ERR-->', '<p class="err">口令错误，请重试</p>'));
      });
      return;
    }
    res.writeHead(405, baseHeaders());
    return res.end('Method Not Allowed');
  }

  if (url === '/logout') {
    res.writeHead(302, baseHeaders({
      Location: '/login',
      'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`,
    }));
    return res.end();
  }

  // 其余路径：校验会话后代理到 dsh
  if (!validSession(getCookie(req, COOKIE_NAME))) {
    res.writeHead(302, baseHeaders({ Location: '/login' }));
    return res.end();
  }
  proxyRequest(req, res);
}

server.on('upgrade', (req, socket) => {
  if (!validSession(getCookie(req, COOKIE_NAME))) {
    socket.destroy();
    return;
  }
  proxyUpgrade(req, socket);
});

server.on('clientError', (err, socket) => {
  // 畸形 HTTP 请求不应导致进程崩溃
  try {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  } catch (e) { /* ignore */ }
});

// ---------------- 启动 dsh 子进程（内部回环） ----------------
let dshProc = null;
let stopping = false;

function startDsh() {
  const args = [
    PROFILE,
    '--no-open',
    '--host', DSH_HOST,
    '--port', String(DSH_PORT),
  ];
  if (EXTRA_ARGS) args.push(...EXTRA_ARGS.split(/\s+/).filter(Boolean));

  dshProc = spawn('dsh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  dshProc.stdout.on('data', (d) => {
    const s = d.toString();
    // 抓取 dsh 打印的 session token：http://.../?token=XXXX，用于透明注入
    const m = s.match(/token=([A-Za-z0-9_-]+)/);
    if (m) dshToken = m[1];
    // 日志里对 token 做遮蔽后再输出，避免凭据长期留在 docker logs 中
    process.stdout.write(`[dsh] ${s.replace(/token=[A-Za-z0-9_-]+/g, 'token=***')}`);
  });
  dshProc.stderr.on('data', (d) => process.stderr.write(`[dsh] ${d}`));
  dshProc.on('exit', (code, sig) => {
    dshProc = null;
    if (stopping) return;
    process.stderr.write(`[dsh] exited (${code}/${sig}); restarting in 1s\n`);
    setTimeout(startDsh, 1000);
  });
}

function containerIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name]) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = containerIP();
  console.log(`dsh-gateway: listening on 0.0.0.0:${PORT} (login page at /login)`);
  console.log(`dsh-gateway: login URL       ->  http://${ip}:${PORT}/login`);
  if (!process.env.DSH_LOGIN_PASSWORD) {
    console.log(`dsh-gateway: login password   ->  ${PASSWORD}   (未设置 DSH_LOGIN_PASSWORD，自动生成)`);
  } else {
    console.log('dsh-gateway: login password   ->  (由 DSH_LOGIN_PASSWORD 提供)');
  }
  console.log(`dsh-gateway: dsh web runs internally on ${DSH_HOST}:${DSH_PORT} (its token is auto-captured and injected per request)`);
  startDsh();
});

function shutdown() {
  stopping = true;
  if (dshProc) dshProc.kill('SIGTERM');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
