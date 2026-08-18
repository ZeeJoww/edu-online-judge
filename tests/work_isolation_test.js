'use strict';
// e2e 测试：判题 uid 池（C：并发提交互扰隔离）
// 前置：隔离实例 config.json 的 judgeUidPool 填满「本机当前 uid」（无 CAP 环境 setuid 同 uid 合法，可走通全部分配/属主逻辑）。
// 断言：① /api/admin/config 返回池 ② 评测中 work/<id> 属主=池 uid、权限 0770 ③ 池模式下评测链路正常（慢代码 TLE、AC 代码 AC，无 SE/RE）
//       ④ 评测结束 work 目录清理。真实跨 uid 互不可读依赖生产 AmbientCapabilities，由生产手工探针验证（见 AGENT_MEMORY）。
// 用法：node tests/work_isolation_test.js [baseUrl] [adminPassword] [judgeDir]
const fs = require('fs');
const path = require('path');
const BASE = (process.argv[2] || 'http://localhost:8090').replace(/\/$/, '');
const ADMIN_PW = process.argv[3] || process.env.TGBOJ_ADMIN_PASSWORD || '';
const JUDGE_DIR = process.argv[4] || '';
let fail = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra !== undefined && !cond ? ' | ' + JSON.stringify(extra).slice(0, 200) : '')); if (!cond) fail++; };
const jar = { token: '' };
function cookieHeader() { return jar.token ? { Cookie: 'tgboj_token=' + jar.token } : {}; }
async function api(method, p, body, useCookie) {
  const headers = Object.assign({}, useCookie ? cookieHeader() : {}, body ? { 'Content-Type': 'application/json' } : {});
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (method === 'POST' && p === '/api/auth/login') { const sc = r.headers.get('set-cookie') || ''; const m = /tgboj_token=([^;]+)/.exec(sc); if (m) jar.token = m[1]; }
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: r.status, data };
}
const SLOW = '#include <unistd.h>\nint main(){ sleep(4); return 0; }';
const AC = fs.readFileSync(path.join(__dirname, 'std_stdin.cpp'), 'utf8'); // 2026 的标准解法（A+B 代码在本题只会 WA）
(async () => {
  let r = await api('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
  check('管理员登录', r.status === 200, r.data);
  r = await api('GET', '/api/admin/config', null, true);
  const pool = (r.data && r.data.config && r.data.config.judgeUidPool) || [];
  check('配置返回 judgeUidPool', Array.isArray(pool) && pool.length > 0, r.data);
  check('池内 uid 均为本机当前 uid（隔离实例惯例）', pool.every((u) => u === process.getuid()), pool);
  // 提交 A：sleep 4s（墙钟 3s → TLE），评测期间检查 work/<id> 属主/权限
  r = await api('POST', '/api/submit', { std: 'c++17', problemId: 2026, code: SLOW }, true);
  check('提交 A（慢代码）', r.status === 200 && typeof r.data.id === 'number', r.data);
  const idA = r.data.id;
  if (JUDGE_DIR) {
    let st = null;
    for (let i = 0; i < 40 && !st; i++) {
      await new Promise((res) => setTimeout(res, 250));
      try {
        const wd = path.join(JUDGE_DIR, 'work', String(idA));
        const s = fs.statSync(wd);
        if (s.isDirectory()) st = fs.lstatSync(wd);
      } catch (e) { /* 尚未创建 */ }
    }
    check('评测中 work/<id> 属主=池 uid（本机 uid）', !!st && st.uid === process.getuid(), st && st.uid);
    check('评测中 work/<id> 权限 0770', !!st && (st.mode & 0o777) === 0o770, st && ((st.mode & 0o777) || 0).toString(8));
  } else {
    console.log('SKIP | 未提供 judgeDir，跳过磁盘断言（argv[4]）');
  }
  // 提交 B（AC 代码，与 A 并发窗口内），验证池模式下评测链路正常
  r = await api('POST', '/api/submit', { std: 'c++17', problemId: 2026, code: AC }, true);
  check('提交 B（AC 代码）', r.status === 200 && typeof r.data.id === 'number', r.data);
  const idB = r.data.id;
  const wait = async (id) => { for (let i = 0; i < 80; i++) { const d = await api('GET', '/api/submission/' + id, null, true); if (d.data && d.data.status === 'done') return d.data; await new Promise((res) => setTimeout(res, 500)); } return null; };
  const sa = await wait(idA);
  check('A 判定完成（TLE 属预期，无 SE/RE）', !!sa && !!sa.summary && sa.summary.verdict === 'TLE', sa && sa.summary);
  const sb = await wait(idB);
  check('B 判定完成且 AC（池模式链路正常）', !!sb && !!sb.summary && sb.summary.verdict === 'AC', sb && sb.summary);
  if (JUDGE_DIR) {
    let cleaned = true;
    for (const id of [idA, idB]) if (fs.existsSync(path.join(JUDGE_DIR, 'work', String(id)))) cleaned = false;
    check('评测结束 work 目录已清理', cleaned);
  }
  console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED'));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(2); });
