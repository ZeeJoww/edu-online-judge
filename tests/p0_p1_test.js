'use strict';
// e2e 测试：P0/P1 修复与增强（XSS/allowViewOthers/期次管理/提交详情鉴权/hideVerdict 绕过/IP 隐藏/隐藏题提交/比赛赛制 OI·IOI·ACM/excase 本人下载）
// 用法：node tests/p0_p1_test.js [baseUrl] [adminPassword]；幂等（runId 后缀）
const BASE = (process.argv[2] || 'http://localhost:8090').replace(/\/$/, '');
const ADMIN_PW = process.argv[3] || process.env.TGBOJ_ADMIN_PASSWORD || '';
const RID = String(Date.now() % 1000000).padStart(6, '0');
const S1 = 's1' + RID, S2 = 's2' + RID;
let fail = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra && !cond ? ' | ' + JSON.stringify(extra).slice(0, 300) : '')); if (!cond) fail++; };
const jar = { token: '' };  // 管理员
const jar2 = { token: '' }; // 学生甲
const jarB = { token: '' }; // 学生乙
function cookieHeader(j) { return j.token ? { Cookie: 'tgboj_token=' + j.token } : {}; }
async function api(method, p, body, useCookie, rawHeaders, jarUse) {
  const headers = Object.assign({}, useCookie ? cookieHeader(jarUse || jar) : {}, body && !rawHeaders ? { 'Content-Type': 'application/json' } : {}, rawHeaders || {});
  const r = await fetch(BASE + p, { method, headers, body: (body === undefined || body === null) ? undefined : (rawHeaders ? body : JSON.stringify(body)) });
  if (method === 'POST' && p === '/api/auth/login') { const sc = r.headers.get('set-cookie') || ''; const m = /tgboj_token=([^;]+)/.exec(sc); if (m) (jarUse || jar).token = m[1]; }
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: r.status, data };
}
function mpBody(fields, files) {
  const boundary = '----tgboj' + Date.now() + Math.random().toString(16).slice(2);
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) chunks.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + value + '\r\n'));
  for (const f of files) {
    chunks.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="data"; filename="' + f.name + '"\r\nContent-Type: application/octet-stream\r\n\r\n'));
    chunks.push(Buffer.from(f.content)); chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from('--' + boundary + '--\r\n'));
  return { ctype: 'multipart/form-data; boundary=' + boundary, body: Buffer.concat(chunks) };
}
async function waitSub(id, tries) {
  for (let i = 0; i < (tries || 80); i++) {
    const d = await api('GET', '/api/submission/' + id, null, true);
    if (d.data && d.data.status === 'done') return d.data;
    await new Promise((res) => setTimeout(res, 500));
  }
  return null;
}
const AC1 = '#include <cstdio>\nint main(){int a,b; scanf("%d%d",&a,&b); printf("%d\\n",a+b); return 0;}';
const WA1 = '#include <cstdio>\nint main(){printf("1\\n"); return 0;}';
(async () => {
  let r = await api('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PW });
  check('管理员登录', r.status === 200, r.data);
  // 建用户
  await api('POST', '/api/admin/user/save', { username: S1, fullname: '学生甲', password: 'pass1234' }, true);
  await api('POST', '/api/admin/user/save', { username: S2, fullname: '学生乙', password: 'pass1234' }, true);
  r = await api('POST', '/api/auth/login', { username: S1, password: 'pass1234' }, false, null, jar2);
  check('学生甲登录', r.status === 200, r.data);
  r = await api('POST', '/api/auth/login', { username: S2, password: 'pass1234' }, false, null, jarB);
  check('学生乙登录', r.status === 200, r.data);
  // 建题 P1（2 点，公开）、P2（1 点，隐藏）、P3（1 点 + ex1 点）
  const upload = async (fields, files, p) => { const mp = mpBody(fields, files); return fetch(BASE + p, { method: 'POST', headers: Object.assign({ Cookie: 'tgboj_token=' + jar.token }, { 'Content-Type': mp.ctype }), body: mp.body }).then(async (res) => ({ status: res.status, data: await res.json().catch(() => null) })); };
  r = await upload({ title: 'P01甲' + RID, description: 'a+b', hidden: '0' }, [{ name: '1.in', content: '2 3' }, { name: '1.out', content: '5\n' }, { name: '2.in', content: '10 20' }, { name: '2.out', content: '30\n' }], '/api/admin/problem');
  check('建公开题 P1(2点)', r.status === 200 && r.data.id, r.data);
  const P1 = r.data.id;
  r = await upload({ title: 'P02隐' + RID, description: 'x' }, [{ name: '1.in', content: '1' }, { name: '1.out', content: '1\n' }], '/api/admin/problem');
  check('建隐藏题 P2', r.status === 200 && r.data.id, r.data);
  const P2 = r.data.id;
  r = await upload({ title: 'P03ex' + RID, description: 'ex', hidden: '0' }, [{ name: '1.in', content: '1 2' }, { name: '1.out', content: '3\n' }, { name: 'ex1.in', content: '4 5' }, { name: 'ex1.out', content: '9\n' }], '/api/admin/problem');
  check('建题 P3(含 ex1 附加点)', r.status === 200 && r.data.id, r.data);
  const P3 = r.data.id;
  // —— S-1 XSS：作业答案中的属性注入被转义 ——
  r = await api('POST', '/api/admin/homework', { title: 'HW1-' + RID, questions: ['Q1?'], hidden: false, allowViewOthers: false }, true);
  check('建作业 HW1(allowViewOthers=false)', r.status === 200 && r.data.id, r.data);
  const HW1 = r.data.id;
  r = await api('POST', '/api/homework/answer', { homeworkId: HW1, answers: ['![x" onerror="alert(1)"](https://example.com/a)'] }, true, null, jar2);
  check('学生甲提交 XSS 答案', r.status === 200, r.data);
  r = await api('POST', '/api/homework/answer', { homeworkId: HW1, answers: ['乙的答案 ![y" onerror="alert(2)"](https://example.com/b)'] }, true, null, jarB);
  check('学生乙提交 XSS 答案', r.status === 200, r.data);
  r = await api('GET', '/api/homework/answers?homeworkId=' + HW1, null, true);
  const html1 = (r.data.answers[0] && r.data.answers[0].answerHtml[0]) || '';
  check('XSS: answerHtml 不含 onerror=" 属性', html1.indexOf('onerror="') === -1 && html1.indexOf('onerror=&quot;') !== -1, html1);
  // —— S-8 allowViewOthers ——
  r = await api('GET', '/api/homework/others?id=' + HW1, null, true, null, jar2);
  check('allowViewOthers=false 学生看他人 → 403', r.status === 403, r.data);
  r = await api('GET', '/api/homework/others?id=' + HW1, null, true);
  check('管理员可看他人答案', r.status === 200 && r.data.answers.length === 2, r.data);
  await api('POST', '/api/admin/homework/settings', { id: HW1, allowViewOthers: true }, true);
  r = await api('GET', '/api/homework/others?id=' + HW1, null, true, null, jar2);
  check('allowViewOthers=true 学生可看且已转义', r.status === 200 && r.data.answers[0].answerHtml[0].indexOf('onerror="') === -1, r.data);
  // —— M-17 未开始作业不泄露题目 ——
  r = await api('POST', '/api/admin/homework', { title: 'HW2-' + RID, questions: ['秘密题目'], startAt: Date.now() + 3600000 }, true);
  const HW2 = r.data.id;
  r = await api('GET', '/api/homework?id=' + HW2, null, true, null, jar2);
  check('M-17: 未开始作业学生看不到题目', r.status === 200 && r.data.questions.length === 0, r.data);
  r = await api('GET', '/api/homework?id=' + HW2, null, true);
  check('M-17: 管理员可见题目', r.status === 200 && r.data.questions.length === 1, r.data);
  // —— 期次管理（P0 新接口）——
  await api('POST', '/api/admin/homework/programming-order', { order: [P1, P3] }, true);
  r = await api('POST', '/api/admin/session/create', { name: '期次甲' + RID }, true);
  check('新建期次：返回列表首位为新期', r.status === 200 && r.data.sessions[0].name === '期次甲' + RID, r.data);
  r = await api('GET', '/api/homeworks?session=1', null, true);
  check('历史期(1)含归档编程题', r.status === 200 && (r.data.programmingJobs || []).some((j) => j.id === P1), r.data);
  r = await api('POST', '/api/admin/session/delete', { session: 1 }, true);
  check('删除非空历史期 → 400', r.status === 400, r.data);
  r = await api('POST', '/api/admin/session/rename', { session: 1, name: '期次乙' + RID }, true);
  check('历史期改名', r.status === 200 && r.data.name === '期次乙' + RID, r.data);
  r = await api('POST', '/api/admin/session/create', { name: '空期丙' + RID }, true);
  const sessionIdx = r.data.sessions.findIndex((s) => s.name === '空期丙' + RID);
  check('再建空期', r.status === 200 && sessionIdx === 0, r.data);
  r = await api('POST', '/api/admin/session/create', { name: '空期丁' + RID }, true);
  check('再建空期丁（空期丙归档为历史首位）', r.status === 200, r.data);
  r = await api('POST', '/api/admin/session/delete', { session: 1 }, true);
  check('删除空历史期(空期丙)', r.status === 200 && !r.data.sessions.some((s) => s.name === '空期丙' + RID), r.data);
  // —— S-4 提交详情鉴权 + M-10 IP 隐藏 + M-2 隐藏题提交 ——
  r = await api('POST', '/api/submit', { problemId: P1, std: 'c++17', code: AC1 }, true, null, jar2);
  check('学生甲提交 P1', r.status === 200 && r.data.id, r.data);
  const subA = r.data.id;
  const doneA = await waitSub(subA);
  check('学生甲 AC', !!doneA && doneA.summary && doneA.summary.verdict === 'AC', doneA && doneA.summary);
  r = await api('GET', '/api/submission/' + subA, null, false);
  check('S-4: 匿名取提交详情 → 401', r.status === 401, r.data);
  r = await api('GET', '/api/submission/' + subA, null, true, null, jar2);
  check('本人取详情且无 ip 字段', r.status === 200 && r.data.ip === undefined, r.data);
  r = await api('GET', '/api/submission/' + subA, null, true);
  check('管理员取详情含 ip', r.status === 200 && typeof r.data.ip === 'string', r.data);
  r = await api('GET', '/api/status', null, true, null, jar2);
  check('status 学生视角无 ip 字段', r.status === 200 && r.data.list.every((x) => x.ip === undefined), r.data.list && r.data.list.length);
  // 隐藏题提交不可见
  r = await api('POST', '/api/submit', { problemId: P2, std: 'c++17', code: AC1 }, true);
  const subH = r.data.id;
  await waitSub(subH);
  r = await api('GET', '/api/status?problem=' + P2, null, true, null, jar2);
  check('M-2: 学生 status 看不到隐藏题提交', r.status === 200 && r.data.list.length === 0, r.data.list);
  r = await api('GET', '/api/status?problem=' + P2, null, true);
  check('M-2: 管理员可见', r.status === 200 && r.data.list.length >= 1, r.data.list);
  r = await api('GET', '/api/submission/' + subH, null, true, null, jar2);
  check('M-2: 学生取隐藏题提交详情 → 404', r.status === 404, r.data);
  // —— L-3 excase 本人下载 actual ——
  r = await api('POST', '/api/submit', { problemId: P3, std: 'c++17', code: AC1 }, true, null, jar2);
  const subE = r.data.id;
  await waitSub(subE);
  r = await api('GET', '/api/excase/' + subE + '?exid=ex1&type=actual', null, true, null, jar2);
  check('L-3: 本人可下载自己的 Ex 输出', r.status === 200 && String(r.data).indexOf('9') !== -1, String(r.data).slice(0, 60));
  // —— 比赛赛制 OI/IOI/ACM ——
  r = await api('GET', '/api/contest/rank', null, false);
  check('匿名取比赛榜单 → 401', r.status === 401, r.data);
  const t0 = Date.now();
  r = await api('POST', '/api/admin/contest', { startAt: t0, endAt: t0 + 3600000, mode: 'acm', penaltyMinutes: 20 }, true);
  check('设置 ACM 比赛', r.status === 200 && r.data.contest.mode === 'acm', r.data);
  r = await api('POST', '/api/submit', { problemId: P1, std: 'c++17', code: WA1 }, true, null, jar2);
  const waId = r.data.id;
  await waitSub(waId);
  await new Promise((res) => setTimeout(res, 2000));
  r = await api('POST', '/api/submit', { problemId: P1, std: 'c++17', code: AC1 }, true, null, jar2);
  const acId = r.data.id;
  const doneAc = await waitSub(acId);
  check('ACM: 学生甲 1WA+1AC', !!doneAc && doneAc.summary && doneAc.summary.verdict === 'AC', doneAc && doneAc.summary);
  r = await api('POST', '/api/auth/login', { username: S2, password: 'pass1234' }, false, null, jarB);
  r = await api('POST', '/api/submit', { problemId: P1, std: 'c++17', code: AC1 }, true, null, jarB);
  const subB = r.data.id;
  await waitSub(subB);
  r = await api('GET', '/api/contest/rank', null, true, null, jarB);
  const rowsAcm = r.data.rows || [];
  const ra = rowsAcm.find((x) => x.username === S1); const rb = rowsAcm.find((x) => x.username === S2);
  check('ACM: 甲 solved=1 且罚时≥20', !!ra && ra.solved === 1 && ra.penalty >= 20, ra);
  check('ACM: 乙 solved=1 罚时=0', !!rb && rb.solved === 1 && rb.penalty === 0, rb);
  check('ACM: 乙排在甲前（罚时少）', rowsAcm.indexOf(rb) < rowsAcm.indexOf(ra), rowsAcm.map((x) => x.username + ':' + x.penalty));
  // IOI vs OI：甲先交 50 分再交 100 分，最后交 50 分 → IOI=100 / OI=50
  const HALF = '#include <cstdio>\nint main(){int a,b; scanf("%d%d",&a,&b); if(a==2) printf("%d\\n",a+b); else printf("%d\\n",a); return 0;}';
  const FULL = AC1;
  r = await api('POST', '/api/submit', { problemId: P1, std: 'c++17', code: HALF }, true, null, jar2);
  await waitSub(r.data.id);
  r = await api('POST', '/api/submit', { problemId: P1, std: 'c++17', code: FULL }, true, null, jar2);
  await waitSub(r.data.id);
  r = await api('POST', '/api/submit', { problemId: P1, std: 'c++17', code: HALF }, true, null, jar2);
  await waitSub(r.data.id);
  await api('POST', '/api/admin/contest', { startAt: t0, endAt: t0 + 3600000, mode: 'ioi' }, true);
  r = await api('GET', '/api/contest/rank', null, true, null, jarB);
  const ri = (r.data.rows || []).find((x) => x.username === S1);
  check('IOI: 甲取最高分=100', !!ri && ri.cells[P1] && ri.cells[P1].score === 100, ri && ri.cells && ri.cells[P1]);
  await api('POST', '/api/admin/contest', { startAt: t0, endAt: t0 + 3600000, mode: 'oi' }, true);
  r = await api('GET', '/api/contest/rank', null, true, null, jarB);
  const ro = (r.data.rows || []).find((x) => x.username === S1);
  check('OI: 甲取末次=50', !!ro && ro.cells[P1] && ro.cells[P1].score === 50, ro && ro.cells && ro.cells[P1]);
  await api('POST', '/api/admin/contest', { clear: true }, true);
  // —— S-5 hideVerdict 两处绕过 ——
  r = await api('POST', '/api/admin/exam', { name: 'P01考' + RID, problemIds: [P1], startAt: Date.now() - 60000, endAt: Date.now() + 3600000, hideVerdict: true }, true);
  check('创建 hideVerdict 模考', r.status === 200 && r.data.id, r.data);
  const EX = r.data.id;
  r = await api('POST', '/api/submit', { problemId: P1, std: 'c++17', code: AC1 }, true, null, jar2);
  const examSub = r.data.id;
  check('考试窗口内提交自动归入模考', r.data.examId === EX && r.data.phase === 'exam', r.data);
  const doneEx = await waitSub(examSub);
  check('考试提交 AC', !!doneEx && doneEx.summary && doneEx.summary.verdict === 'AC', doneEx && doneEx.summary);
  r = await api('GET', '/api/code/' + examSub, null, true, null, jarB);
  check('S-5: 未公布期间他人(有AC)看考试代码 → 403', r.status === 403, r.data);
  r = await api('GET', '/api/code/' + examSub, null, true, null, jar2);
  check('本人看自己的考试代码 → 200', r.status === 200, r.status);
  r = await api('GET', '/api/exam?id=' + EX, null, true, null, jar2);
  check('S-5: 未公布时 /api/exam 不返回本人分数', r.status === 200 && r.data.myHidden === true && Object.keys(r.data.my).length === 0, r.data);
  r = await api('POST', '/api/admin/exam/publish', { id: EX }, true);
  check('公布成绩', r.status === 200, r.data);
  r = await api('GET', '/api/code/' + examSub, null, true, null, jarB);
  check('公布后他人(有AC)可看代码', r.status === 200, r.status);
  r = await api('GET', '/api/exam?id=' + EX, null, true, null, jar2);
  check('公布后 /api/exam 返回本人分数', r.status === 200 && r.data.myHidden === false, r.data);
  console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED'));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(2); });