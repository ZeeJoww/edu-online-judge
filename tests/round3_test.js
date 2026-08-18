'use strict';
// e2e 测试：加固轮新功能——封榜（freeze）/ 评测队列监控 / 比赛澄清（clar）/ 个人中心（bio + 导出代码）
// 用法：node tests/round3_test.js [baseUrl] [adminPassword]
const BASE = (process.argv[2] || 'http://localhost:8090').replace(/\/$/, '');
const ADMIN_PW = process.argv[3] || process.env.TGBOJ_ADMIN_PASSWORD || '';
const RID = String(Date.now() % 1000000).padStart(6, '0');
const S1 = 'r3a' + RID, S2 = 'r3b' + RID;
let fail = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra !== undefined && !cond ? ' | ' + JSON.stringify(extra).slice(0, 200) : '')); if (!cond) fail++; };
const jar = { token: '' }; const jarS1 = { token: '' }; const jarS2 = { token: '' };
function cookieHeader(j) { return j.token ? { Cookie: 'tgboj_token=' + j.token } : {}; }
async function api(method, p, body, useCookie, jarUse) {
  const headers = Object.assign({}, useCookie ? cookieHeader(jarUse || jar) : {}, body ? { 'Content-Type': 'application/json' } : {});
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (method === 'POST' && p === '/api/auth/login') { const sc = r.headers.get('set-cookie') || ''; const m = /tgboj_token=([^;]+)/.exec(sc); if (m) (jarUse || jar).token = m[1]; }
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: r.status, data };
}
const waitSub = async (id, tries) => { for (let i = 0; i < (tries || 90); i++) { const d = await api('GET', '/api/submission/' + id, null, true); if (d.data && d.data.status === 'done') return d.data; await new Promise((res) => setTimeout(res, 500)); } return null; };
const SLOW = '#include <unistd.h>\nint main(){ sleep(4); return 0; }';
const AC = require('fs').readFileSync(require('path').join(__dirname, 'std_stdin.cpp'), 'utf8'); // 2026 标准解法（A+B 代码在本题只会 WA）
const setContest = async (startAt, endAt, extra) => {
  const body = Object.assign({ title: 'r3比赛' + RID, startAt, endAt, mode: 'oi', penaltyMinutes: 20, freezeMinutes: 0 }, extra || {});
  return api('POST', '/api/admin/contest', body, true);
};
(async () => {
  let r = await api('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
  check('管理员登录', r.status === 200, r.data);
  // 注册两个学生并审核
  for (const [un, j] of [[S1, jarS1], [S2, jarS2]]) {
    r = await api('POST', '/api/auth/register', { username: un, fullname: '澄清测试', password: 'pass1234' });
    check('注册 ' + un, r.status === 200 && r.data.ok, r.data);
    const users = await api('GET', '/api/admin/users', null, true);
    const t = users.data.users.find((u) => u.username === un);
    r = await api('POST', '/api/admin/user/audit', { id: t.id, action: 'approve' }, true);
    check('审核 ' + un, r.status === 200 && r.data.status === 'active', r.data);
    r = await api('POST', '/api/auth/login', { username: un, password: 'pass1234' }, false, j);
    check(un + ' 登录', r.status === 200, r.data);
  }
  // —— 评测队列监控 ——
  r = await api('POST', '/api/submit', { std: 'c++17', problemId: 2026, code: SLOW }, true, jarS1);
  const slowId = r.data.id;
  let qSeen = null;
  for (let i = 0; i < 12 && !qSeen; i++) {
    await new Promise((res) => setTimeout(res, 250));
    const q = await api('GET', '/api/admin/queue', null, true);
    if (q.status === 200) {
      qSeen = q.data;
      if ((q.data.running || []).some((s) => s.id === slowId)) break;
      qSeen = null;
    }
  }
  check('队列监控返回结构与运行中提交', !!qSeen && qSeen.runningCount >= 0 && Array.isArray(qSeen.judgePool) && qSeen.judgePool.length > 0 && qSeen.maxParallel >= 1, qSeen);
  const qs = await waitSub(slowId);
  check('慢代码评测完成（TLE 属预期）', !!qs && qs.summary && qs.summary.verdict === 'TLE', qs && qs.summary);
  // —— 封榜 ——
  const now0 = Date.now();
  const cStart = now0 - 60 * 1000;
  r = await setContest(cStart, now0 + 600 * 1000, { freezeMinutes: 5 });
  check('设置比赛（未封榜期）', r.status === 200 && r.data.contest.freezeMinutes === 5, r.data);
  r = await api('POST', '/api/submit', { std: 'c++17', problemId: 2026, code: AC }, true, jarS1);
  const acId = r.data.id;
  const ac1 = await waitSub(acId);
  r = await api('GET', '/api/contest/rank', null, true, jarS1);
  const beforeFreeze = r.data.rows.find((x) => x.username === S1);
  const cellA = beforeFreeze && beforeFreeze.cells && beforeFreeze.cells[2026];
  check('未封榜：学生榜单可见本人成绩（AC 100）', r.status === 200 && !!cellA && cellA.score === 100 && cellA.attempts === 2, cellA);
  // 封榜窗口 = (AC#1 提交后 1 秒, 之后 5 分钟)：freezeMinutes=5、endAt=freezeStart+5min → freezeStart 精确落点
  const freezeStart = (ac1.submittedAt || Date.now()) + 1000;
  r = await setContest(cStart, freezeStart + 300 * 1000, { freezeMinutes: 5 });
  check('拨动封榜（起点=AC#1 提交后 1s）', r.status === 200 && r.data.contest.freezeMinutes === 5, r.data);
  r = await api('POST', '/api/submit', { std: 'c++17', problemId: 2026, code: AC }, true, jarS1);
  const acId2 = r.data.id;
  await waitSub(acId2);
  r = await api('GET', '/api/contest/rank', null, true, jarS1);
  const frozenRow = r.data.rows.find((x) => x.username === S1);
  const cellF = frozenRow && frozenRow.cells && frozenRow.cells[2026];
  check('封榜生效：学生榜单不含冻结期提交（attempts 不变、分数为封榜前）', r.status === 200 && r.data.freeze.frozen === true && !!cellF && cellF.attempts === 2 && cellF.score === 100, { frozen: r.data.freeze, cell: cellF });
  r = await api('GET', '/api/contest/rank', null, true, jar);
  const adminRow = r.data.rows.find((x) => x.username === S1);
  const cellAdm = adminRow && adminRow.cells && adminRow.cells[2026];
  check('管理员榜单始终实时（attempts 含冻结期提交）', !!cellAdm && cellAdm.attempts === 3 && cellAdm.score === 100, cellAdm);
  // —— 澄清 ——
  r = await api('POST', '/api/admin/contest', { clear: true }, true);
  check('清除比赛', r.status === 200, r.data);
  r = await api('POST', '/api/clar', { text: '比赛没开时提问' }, true, jarS1);
  check('比赛外提交澄清被拒', r.status === 403 && /比赛未进行/.test(r.data.error), r.data);
  await setContest(Date.now() - 60 * 1000, Date.now() + 600 * 1000);
  r = await api('POST', '/api/clar', { text: '第2题 n 可能为 0 吗？', problemId: 2026 }, true, jarS1);
  check('比赛内提交澄清', r.status === 200 && typeof r.data.id === 'number', r.data);
  const clarId = r.data.id;
  r = await api('POST', '/api/clar', { text: 'S2 的问题' }, true, jarS2);
  const clar2Id = r.data.id;
  check('S2 提交澄清', r.status === 200 && typeof r.data.id === 'number', r.data);
  r = await api('GET', '/api/clar', null, false);
  check('匿名查看澄清 401', r.status === 401);
  r = await api('GET', '/api/clar', null, true, jarS1);
  check('学生可见自己的澄清（未回复前）', r.status === 200 && r.data.list.some((x) => x.id === clarId), r.data);
  r = await api('POST', '/api/admin/clar/reply', { id: clarId, reply: '可以，n≥0', public: true }, true);
  check('管理员回复并公开', r.status === 200 && r.data.ok, r.data);
  r = await api('POST', '/api/admin/clar/reply', { id: clar2Id, reply: '仅你可见', public: false }, true);
  check('管理员回复（私密）', r.status === 200, r.data);
  r = await api('GET', '/api/clar', null, true, jarS1);
  check('学生可见公开回复', r.data.list.some((x) => x.id === clarId && x.reply === '可以，n≥0' && x.public), r.data);
  check('学生不可见他人私密澄清', !r.data.list.some((x) => x.id === clar2Id), r.data);
  r = await api('GET', '/api/clar', null, true, jar);
  check('管理员可见全部澄清', r.data.list.some((x) => x.id === clarId) && r.data.list.some((x) => x.id === clar2Id), r.data);
  // —— 个人中心：bio + 导出 ——
  r = await api('POST', '/api/me/save', { bio: '我爱 OI，目标 CSP-S 一等奖' }, true, jarS1);
  check('保存个人简介', r.status === 200 && r.data.bio === '我爱 OI，目标 CSP-S 一等奖', r.data);
  r = await api('GET', '/api/auth/me', null, true, jarS1);
  check('me 返回 bio/studentId 字段', r.status === 200 && r.data.user.bio === '我爱 OI，目标 CSP-S 一等奖', r.data);
  const fr = await fetch(BASE + '/api/my/code/export', { headers: cookieHeader(jarS1) });
  check('导出代码 zip（有提交）', fr.status === 200 && /application\/zip/.test(fr.headers.get('content-type') || ''), fr.status);
  const zipBuf = Buffer.from(await fr.arrayBuffer());
  check('zip 非空且以 PK 开头', zipBuf.length > 100 && zipBuf[0] === 0x50 && zipBuf[1] === 0x4b, zipBuf.length);
  check('zip 内含 README.md 清单', zipBuf.indexOf(Buffer.from('README.md')) !== -1);
  const fr2 = await fetch(BASE + '/api/my/code/export', { headers: cookieHeader(jarS2) });
  check('无提交用户导出 → 400', fr2.status === 400);
  // 收尾：清比赛，避免影响其他套件
  await api('POST', '/api/admin/contest', { clear: true }, true);
  console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED'));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(2); });
