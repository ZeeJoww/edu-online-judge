'use strict';
const { parseMultipart } = require('./markdown');

// Ex 附加点命名：ex / ex1 / ex2 …（不计分，仅用于排行榜「未通过 Ex 数据」星标）
function isExPointId(id) { return /^ex\d*$/i.test(String(id)); }
function reqIp(req) {
  let ip = req.socket.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  // F-4：不再信任客户端可伪造的 X-Real-IP（即使来自 loopback 反代）。限速/审计一律用 socket 真实来源，
  // 由可信反代在应用层另设（当前部署无此需求），杜绝通过伪造头绕过登录/注册限速。
  return ip;
}
function sendJson(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
  });
  res.end(b);
}

function readBodyBuffer(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        // BUG-2：先回 413 再断连，避免客户端 ECONNRESET 且无状态码
        const err = new Error('请求体过大');
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 读取并解析 JSON 请求体（非法 JSON 仍抛异常，由外层 500 兜底，保持原行为）
async function readJson(req, limit) {
  const text = (await readBodyBuffer(req, limit || 2 * 1024 * 1024)).toString('utf8') || '{}';
  return JSON.parse(text);
}
// 解析 multipart/form-data（返回 { parts, field }；非 multipart 返回 null）
async function readMultipart(req, limit) {
  const ctype = req.headers['content-type'] || '';
  const bm = /boundary="?([^";]+)"?/.exec(ctype);
  if (!bm) return null;
  const buf = await readBodyBuffer(req, limit);
  const parts = parseMultipart(buf, bm[1]);
  const field = (n) => { const p = parts.find((x) => x.name === n && !x.filename); return p ? p.body.toString('utf8').trim() : ''; };
  return { parts, field };
}

function getPath(req) {
  // BUG-1：非法百分号编码（如 /api/%zz）会让 decodeURIComponent 抛 URIError，且该调用位于 server 顶层 try 之外，
  // 一次恶意请求即可使整个服务进程退出。这里在内部兜底：解码失败时回退原始 pathname。
  try {
    const p = new URL(req.url, 'http://x').pathname;
    try { return decodeURIComponent(p); } catch (e) { return p; }
  } catch (e) { return '/'; }
}
function getQuery(req) {
  try { return Object.fromEntries(new URL(req.url, 'http://x').searchParams); }
  catch (e) { return {}; }
}

module.exports = { isExPointId, reqIp, sendJson, readBodyBuffer, readJson, readMultipart, getPath, getQuery };
