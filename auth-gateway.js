#!/usr/bin/env node
'use strict';

// 零依赖 Node 鉴权网关：
//   - 对外监听 DSH_PORT（默认 3080），提供登录页 /login 与会话校验。
//   - 在容器内部以 --trusted-host 放行方式运行 dsh web（127.0.0.1:DSH_DSH_PORT），
//     网关以受信 Host 转发，从而彻底绕过 dsh 每次都要的 token。
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

// 口令：未设置则随机生成并打印，保证总能登录一次设置。
let PASSWORD = process.env.DSH_LOGIN_PASSWORD || '';
if (!PASSWORD) {
  PASSWORD = crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
}

const LOGIN_HTML = fs.readFileSync(path.join(__dirname, 'login.html'), 'utf8');

// ---------------- 会话工具 ----------------
function makeSession() {
  const id = crypto.randomBytes(16).toString('hex');
  const sig = crypto.createHmac('sha256', SECRET).update(id).digest('hex');
  return id + '.' + sig;
}
function validSession(cookie) {
  if (!cookie) return false;
  const [id, sig] = cookie.split('.');
  if (!id || !sig) return false;
  const expected = crypto.createHmac('sha256', SECRET).update(id).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function sha256(s) { return crypto.createHash('sha256').update(s || '').digest(); }
function passwordOk(pw) {
  const a = sha256(pw);
  const b = sha256(PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function getCookie(req, name) {
  const c = req.headers.cookie;
  if (!c) return undefined;
  for (const part of c.split(';')) {
    const idx = part.indexOf('=');
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === name) return decodeURIComponent(v);
  }
  return undefined;
}
function cookieFlags() {
  let f = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`;
  if (SECURE_COOKIE) f += '; Secure';
  return f;
}

// ---------------- 反向代理到 dsh ----------------
// dsh 仍在内部端口运行并自带 token 围栏；网关在启动时从 dsh 日志里抓取它打印的
// session token，透明地注入到每个转发请求上，使终端用户完全无需接触 token。
let dshToken = '';

function injectToken(path, cookieHeader) {
  if (!dshToken) return path;
  // 已持有 dsh 下发的会话 Cookie：直接透传，不再注入 token。
  // 否则 dsh 对 “/” 会一直 303 -> “/” 形成重定向死循环，且 /api 也靠此 Cookie 鉴权。
  if (cookieHeader && /(^|;\s*)dsh-auth-/.test(cookieHeader)) return path;
  if (/([?&]token=)/.test(path)) return path; // 已有 token（如 dsh 重定向带回的）则不重复
  return path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(dshToken);
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
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad gateway: ' + e.message);
    } else {
      res.destroy();
    }
  });
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
  const url = req.url.split('?')[0];

  if (url === '/login') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(LOGIN_HTML);
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 1e6) req.destroy();
      });
      req.on('end', () => {
        const pw = querystring.parse(body).password || '';
        if (passwordOk(pw)) {
          const cookie = makeSession();
          res.writeHead(302, {
            Location: '/',
            'Set-Cookie': `${COOKIE_NAME}=${cookie}; ${cookieFlags()}`,
          });
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(LOGIN_HTML.replace('<!--ERR-->', '<p class="err">口令错误，请重试</p>'));
      });
      return;
    }
    res.writeHead(405);
    return res.end('Method Not Allowed');
  }

  if (url === '/logout') {
    res.writeHead(302, {
      Location: '/login',
      'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`,
    });
    return res.end();
  }

  // 其余路径：校验会话后代理到 dsh
  const sess = getCookie(req, COOKIE_NAME);
  if (!validSession(sess)) {
    res.writeHead(302, { Location: '/login' });
    return res.end();
  }
  proxyRequest(req, res);
});

server.on('upgrade', (req, socket) => {
  const sess = getCookie(req, COOKIE_NAME);
  if (!validSession(sess)) {
    socket.destroy();
    return;
  }
  proxyUpgrade(req, socket);
});

// ---------------- 启动 dsh 子进程（内部，受信放行） ----------------
let dshProc = null;
let stopping = false;

function startDsh() {
  const args = [
    PROFILE,
    '--no-open',
    '--host', DSH_HOST,
    '--port', String(DSH_PORT),
    '--trusted-host', DSH_HOST,
  ];
  if (EXTRA_ARGS) args.push(...EXTRA_ARGS.split(/\s+/).filter(Boolean));

  dshProc = spawn('dsh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  dshProc.stdout.on('data', (d) => {
    const s = d.toString();
    // 抓取 dsh 打印的 session token：http://.../?token=XXXX，用于透明注入
    const m = s.match(/token=([A-Za-z0-9_-]+)/);
    if (m) dshToken = m[1];
    process.stdout.write(`[dsh] ${s}`);
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
  console.log(`dsh-gateway: login password   ->  ${PASSWORD}`);
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
