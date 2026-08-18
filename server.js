'use strict';
// 局域网评测服务（多题）：题目页 / 提交 / 评测队列 / 代码可见性 / 管理员添加题目
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { compile, compileCached, runTestPoint, scoreSubmission, ensureChecker } = require('./judge.js');
const { aiReviewCode, aiReviewEnabled, riskLevel, blockThreshold } = require('./ai.js');
const { esc, renderMath, renderMarkdown, renderMarkdownBody, renderProblem, parseMultipart } = require('./markdown');
const { isExPointId, reqIp, sendJson, readBodyBuffer, readJson, readMultipart, getPath, getQuery } = require('./util');
const store = require('./store');
const { findPairs } = require('./plagiarism');
const { extractArchive, checkArchiveEntries, assertNoSymlinks, scanStudents, matchUser, userCandidates, matchProblem, problemCandidates, sanitizeUsername } = require('./offline');

// 从请求 cookie 解析当前登录用户（active 且会话未过期）
function authUser(req) {
  const cookie = req.headers.cookie || '';
  const m = /tgboj_token=([^;]+)/.exec(cookie);
  if (!m) return null;
  const s = store.sessions[store.hashToken(m[1])];
  if (!s || s.expireAt < Date.now()) return null;
  const u = store.users.find((x) => x.id === s.uid);
  if (!u || u.status !== 'active') return null;
  if (u.mustChangePassword) return null; // 旧口令强制改密窗口：除改密/登出/me 外一律视为未登录
  return u;
}
// 强制改密窗口内也允许的身份识别（仅 /api/auth/change-password、logout、me 使用）
function authUserForced(req) {
  const cookie = req.headers.cookie || '';
  const m = /tgboj_token=([^;]+)/.exec(cookie);
  if (!m) return null;
  const s = store.sessions[store.hashToken(m[1])];
  if (!s || s.expireAt < Date.now()) return null;
  const u = store.users.find((x) => x.id === s.uid);
  return u && u.status === 'active' ? u : null;
}
function isAdminUser(u) { return !!u && (u.role === 'admin' || u.role === 'superadmin'); }
// 教师编号：超管 = 教师0；其他管理员按 id 顺序 = 教师1/2/3...
function adminLabel(u) {
  if (!u || (u.role !== 'admin' && u.role !== 'superadmin')) return '';
  if (u.role === 'superadmin') return '教师0';
  const admins = store.users.filter((x) => x.role === 'admin').sort((a, b) => a.id - b.id);
  const idx = admins.findIndex((x) => x.id === u.id) + 1;
  return '教师' + (idx > 0 ? idx : '');
}
function sendUnauthorized(res) { sendJson(res, 401, { error: '请先登录' }); }
function sendForbidden(res, msg) { sendJson(res, 403, { error: msg || '无权限' }); }
// 公网入口识别：cloudflared 隧道等反代从 127.0.0.1 转发且带 X-Forwarded-For → 视为公网流量
function isTunnelReq(req) {
  const ra = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return (ra === '127.0.0.1' || ra === '::1') && !!req.headers['x-forwarded-for'];
}
// H1：封榜统一口径。比赛 running 且进入 [endAt-freezeMinutes, endAt] 后，非管理员榜单冻结。
// /api/status、/api/submission/<id>、/api/rank 共用此函数，防止经侧信道重建实时榜单。
function contestFreezeState(me) {
  const c = store.contest || {};
  if (!c.startAt || !c.endAt) return { frozen: false, status: 'none', startAt: 0, endAt: 0, freezeStart: 0, freezeMinutes: 0 };
  const now = Date.now();
  const status = now < c.startAt ? 'upcoming' : (now > c.endAt ? 'ended' : 'running');
  const freezeMinutes = Math.min(Math.max(parseInt(c.freezeMinutes, 10) || 0, 0), 600);
  const freezeStart = c.endAt - freezeMinutes * 60000;
  const frozen = status === 'running' && freezeMinutes > 0 && now >= freezeStart && !isAdminUser(me);
  return { frozen, status, startAt: c.startAt, endAt: c.endAt, freezeStart, freezeMinutes };
}
// 某条提交在封榜期内是否应隐藏判定/分数（仅限比赛窗口内、封榜线之后的提交；管理员已由 frozen=false 豁免）
function freezeHidesSub(s, st) {
  return !!(st.frozen && s.submittedAt > st.freezeStart && s.submittedAt >= st.startAt && s.submittedAt <= st.endAt);
}

// ---- CSRF 防护：写入类请求校验 Origin/Referer 同源（配合 cookie 的 SameSite=Lax）----
// 浏览器跨站 POST 会带 Origin；无 Origin/Referer 的非浏览器客户端（curl 等）放行
function sameOrigin(req) {
  const raw = req.headers.origin || req.headers.referer;
  if (!raw) return true;
  try { return new URL(raw).host === req.headers.host; } catch (e) { return false; }
}

// ---- 登录失败限速（防暴力破解）----
const loginFails = new Map(); // key(username|ip) -> {count, lockUntil}
function recordLoginFail(key) {
  const now = Date.now();
  const rec = loginFails.get(key) || { count: 0, lockUntil: 0 };
  rec.count += 1;
  if (rec.count >= 5) { rec.lockUntil = now + 60 * 1000; rec.count = 0; } // 5 次失败锁 60 秒
  rec.at = now;
  loginFails.set(key, rec);
}
setInterval(() => { // L-6：清理 30 分钟无活动的失败记录，防 Map 无限增长
  const now = Date.now();
  for (const [k, v] of loginFails) if (v.at && now - v.at > 30 * 60 * 1000) loginFails.delete(k);
}, 10 * 60 * 1000).unref();
// 注册频率限制：每 IP 每 10 分钟最多 10 次（L-6）
const regTrack = new Map();
function regThrottle(ip) {
  const now = Date.now();
  const rec = regTrack.get(ip);
  if (!rec || now - rec.windowStart > 10 * 60 * 1000) { regTrack.set(ip, { count: 1, windowStart: now }); return true; }
  if (rec.count >= 10) return false;
  rec.count++;
  return true;
}

// ---- 评测队列（多线程：全局最多 maxParallel 个并发，单用户最多 maxPerUser 个，多用户公平让位）----
let queue = [];
const MAX_PARALLEL = (Number.isInteger(store.CONFIG.maxParallel) && store.CONFIG.maxParallel > 0) ? store.CONFIG.maxParallel : 3;
const MAX_PER_USER = (Number.isInteger(store.CONFIG.maxPerUser) && store.CONFIG.maxPerUser > 0) ? store.CONFIG.maxPerUser : 3;
const runningSubs = new Map();   // sub.id -> sub（正在评测）
const runningUsers = new Map();  // uid -> 占用线程数（用于单用户并发上限 + 公平让位）
// AI 高风险提交封禁：uid -> 解封时间戳（内存态，重启即清；由 AI 自动检测高风险触发，1 分钟）
const submitBan = new Map();

// ---- 判题 uid 池（C：并发提交互扰隔离）----
// 不同提交分配不同判题 uid，work/<id> 属主随之为「该提交独占的池 uid」+ 组=服务器组(0770)：
// 其他池 uid 既非属主也不在服务器组 → 不可读/写/杀他人评测文件与进程。
// 启动时用 getent 校验池内 uid 真实存在（防新池用户未建导致 spawn EPERM）；全部失效回退单 judgeUid，两者皆无则 uid=0（隔离实例）。
// 允许的语言标准（提交/导入统一校验）：C、C++ 三档、GNU 扩展三档、Python3
const STD_LIST = ['c11', 'c++14', 'c++17', 'c++20', 'gnu++14', 'gnu++17', 'gnu++20', 'python3'];

const JUDGE_UID_POOL = (() => {
  const raw = Array.isArray(store.CONFIG.judgeUidPool) ? store.CONFIG.judgeUidPool.map(Number) : [];
  const pool = raw.filter((n) => Number.isInteger(n) && n > 0);
  const exists = pool.filter((u) => {
    try { execFileSync('getent', ['passwd', String(u)], { stdio: 'ignore' }); return true; } catch (e) { return false; }
  });
  if (pool.length && exists.length !== pool.length) {
    console.warn('[TGBOJ] judgeUidPool 中 ' + (pool.length - exists.length) + ' 个 uid 不存在已剔除: ' + pool.filter((u) => exists.indexOf(u) === -1).join(','));
  }
  if (exists.length) return exists;
  if (Number(store.CONFIG.judgeUid) > 0) return [Number(store.CONFIG.judgeUid)];
  return [];
})();
const judgeUidBusy = new Map(); // 池 uid -> 占用数
function allocJudgeUid() {
  if (!JUDGE_UID_POOL.length) return 0;
  let best = JUDGE_UID_POOL[0], bestCnt = Infinity;
  for (const u of JUDGE_UID_POOL) {
    const c = judgeUidBusy.get(u) || 0;
    if (c < bestCnt) { bestCnt = c; best = u; }
  }
  judgeUidBusy.set(best, (judgeUidBusy.get(best) || 0) + 1);
  return best;
}
function freeJudgeUid(u) {
  if (!u) return;
  const c = judgeUidBusy.get(u) || 0;
  if (c <= 1) judgeUidBusy.delete(u); else judgeUidBusy.set(u, c - 1);
}

async function judgeOne(sub) {
  const problem = store.getProblem(sub.problemId);
  const tests = problem ? problem.tests : [];
  const exTests = problem ? (problem.exTests || []) : [];
  const tl = problem ? problem.timeLimitSec : store.CONFIG.timeLimitSec;
  const ml = problem ? problem.memLimitKb : store.CONFIG.memLimitKb;
  // OLE 输出限额：题目 problem.json 可配 outputLimitKb 覆盖全局 config（钳制 1MB~512MB）
  const olRaw = (problem && typeof problem.outputLimitKb === 'number' && problem.outputLimitKb > 0) ? problem.outputLimitKb : (Number(store.CONFIG.outputLimitKb) || 64 * 1024);
  const ol = Math.max(1024, Math.min(512 * 1024, Math.round(olRaw)));
  const fio = problem ? problem.fileIO : null; // 传统文件读写（NOIP 风格）
  const workDir = path.join(store.WORK_DIR, String(sub.id));
  // S1：拒绝符号链接（TOCTOU 防护）。评测完会删除目录，此处防御性清理残留/预置链接，避免 mkdir/chown/copyFile 跟随链接越权写。
  try {
    const pre = fs.lstatSync(workDir);
    if (pre.isSymbolicLink()) { try { fs.unlinkSync(workDir); } catch (e) { /* ignore */ } }
    else if (!pre.isDirectory()) { try { fs.rmSync(workDir, { force: true }); } catch (e) { /* ignore */ } }
  } catch (e) { /* 不存在则忽略 */ }
  fs.mkdirSync(workDir, { recursive: true, mode: 0o770 });
  // 二次 lstat 校验：mkdir 后若仍是符号链接（极端竞态），中止该提交，绝不 chown/chmod/copyFile 跟随链接
  let wl = null;
  try { wl = fs.lstatSync(workDir); } catch (e) { /* ignore */ }
  if (wl && wl.isSymbolicLink()) {
    sub.status = 'done';
    sub.summary = { verdict: 'SE', display: 'SE', score: 0, maxScore: 100, firstError: '评测目录异常（符号链接）', subtaskResults: [] };
    sub.finishedAt = Date.now();
    store.saveIndex();
    return;
  }
  // 判题降权 + 并发隔离：工作目录归属「本提交独占的池 uid」，组=服务器组（0770：joww 经组权限读写，
  // 其他池 uid 非属主且不在组内 → 无法互读/互改/互杀）。无池/无权限时忽略（隔离实例 uid=0）
  const judgeUid = allocJudgeUid();
  sub._judgeUid = judgeUid;
  try {
    if (judgeUid > 0) {
      fs.chmodSync(workDir, 0o770); // 显式补足（mkdir mode 会被 umask 削减）
      fs.chownSync(workDir, judgeUid, process.getgid());
    }
  } catch (e) { /* 无 CAP_CHOWN（非 systemd 托管）时忽略 */ }
  // 判题降权配置：uid/gid 直接 setuid（systemd AmbientCapabilities 方案），wrapper = setuid 包装器路径（无 systemd 方案）
  const runOpts = { uid: judgeUid, gid: Number(store.CONFIG.judgeGid) || 0, wrapper: store.CONFIG.judgeRunWrapper || '' };
  const isPy = sub.std === 'python3';
  sub._judgedAt = Date.now(); // 队列监控：进入评测的时间
  const src = path.join(workDir, isPy ? 'main.py' : (sub.std === 'c11' ? 'sol.c' : 'sol.cpp'));
  const bin = path.join(workDir, isPy ? 'main.py' : 'sol');
  fs.copyFileSync(path.join(store.SUB_DIR, sub.codeFile), src);
  sub.status = 'judging';
  // M5：不再把中间态「judging」落盘（提交已以 queued 落盘，重启恢复会把 judging/queued 一并重新入队），减少一次全量写

  const comp = await compileCached(src, bin, sub.std, workDir, store.CONFIG.compileTimeoutMs, store.CONFIG.compilerPath || 'g++', runOpts);
  if (!comp.ok) {
    sub.status = 'done';
    // CE 小结：取编译输出的第一条非空错误行（比整段日志更易读；完整信息仍保留在 compileError）
    const ceHint = String(comp.error || '').split('\n').map((l) => l.trim()).filter((l) => /error|错误|fatal/i.test(l))[0]
      || String(comp.error || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
    sub.summary = { verdict: 'CE', display: 'CE', score: 0, maxScore: 100, firstError: '编译错误', compileError: comp.error, hint: ceHint.slice(0, 300), subtaskResults: [] };
    sub.score = 0;
    sub.points = tests.map((t) => ({ id: t.id, verdict: 'CE' }));
    sub.exPoints = exTests.map((t) => ({ id: t.id, verdict: 'CE' }));
    sub.finishedAt = Date.now();
    store.saveIndex();
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* ignore */ } // CE 路径同样清理 workDir（与 SE/成功路径一致）
    return;
  }
  // python3 为解释执行：运行命令 = [python3, 脚本路径]（argv 数组，judge.js 内部做 shell 安全转义；时空限制与其他语言一致）
  const runBin = isPy ? ['python3', bin] : [bin];
  sub.points = [];
  // 先测样例（若题目提供，支持多组）：样例不过不阻断，仍继续正式评测，结果附加标记
  const sampleList = (problem && problem.samples && problem.samples.length)
    ? problem.samples
    : (problem && problem.hasSample ? [{ id: '1', input: problem.sampleIn, output: problem.sampleOut }] : []);
  let sampleFail = null;
  const sampleResults = [];
  if (sampleList.length) {
    for (const sp of sampleList) {
      const sr = await runTestPoint(workDir, runBin, sp.input, sp.output, tl, ml, store.CONFIG.runtimeLibPath || '', problem && problem.checkerBin, fio, runOpts, ol);
      let out = '';
      try {
        const st = fs.statSync(path.join(workDir, 'out.txt'));
        out = st.size <= 512 * 1024 ? fs.readFileSync(path.join(workDir, 'out.txt'), 'utf8') : '（输出过大，未保存全文）'; // 样例输出上限 512KB，防 submissions.json 膨胀
      } catch (e) { /* 无输出（TLE/RE 等） */ }
      sampleResults.push({ id: sp.id, verdict: sr.verdict, timeMs: sr.timeMs, memKb: sr.memKb, out, hint: sr.hint });
      if (sr.verdict !== 'AC' && !sampleFail) {
        sampleFail = { id: sp.id, verdict: sr.verdict, timeMs: sr.timeMs, memKb: sr.memKb, hint: sr.hint };
      }
    }
  }
  sub.sampleResults = sampleResults;
  for (const t of tests) {
    const r = await runTestPoint(workDir, runBin, t.input, t.expected, tl, ml, store.CONFIG.runtimeLibPath || '', problem && problem.checkerBin, fio, runOpts, ol);
    r.id = t.id;
    sub.points.push(r);
    sub.status = 'judging'; // 前端轮询时展示进行中的点数
  }
  // Ex 附加点：参与评测但不计分（用于排行榜「未通过 Ex 数据」星标）
  sub.exPoints = [];
  for (const t of exTests) {
    const r = await runTestPoint(workDir, runBin, t.input, t.expected, tl, ml, store.CONFIG.runtimeLibPath || '', problem && problem.checkerBin, fio, runOpts, ol);
    r.id = t.id;
    // 保存实际输出（超限则不存全文，避免撑爆提交记录）
    let exOut = '';
    try {
      const st = fs.statSync(path.join(workDir, 'out.txt'));
      exOut = st.size <= 512 * 1024 ? fs.readFileSync(path.join(workDir, 'out.txt'), 'utf8') : '（输出过大，未保存全文）';
    } catch (e) { /* 无输出（TLE/RE 等） */ }
    r.out = exOut;
    sub.exPoints.push(r);
  }
  sub.summary = scoreSubmission(sub.points, tests.length, problem && problem.scoring);
  // 小结：取首个未通过测试点的 hint（与 firstError 同一点位；AC 无 hint）
  const firstBad = sub.points.find((p) => p.verdict !== 'AC' && p.hint);
  if (firstBad) sub.summary.hint = firstBad.hint;
  sub.score = sub.summary.score;           // 0~100（排行榜/模考成绩直接用）
  sub.subtaskResults = sub.summary.subtaskResults;
  if (sampleFail) {
    // 状态只显示第一个失败位置：样例优先（如 "WA on sample#2"）
    sub.summary.sampleFailed = true;
    sub.summary.firstError = sampleFail.verdict + ' on sample#' + sampleFail.id;
    sub.summary.sampleInfo = '样例' + sampleFail.id + '未通过（' + sampleFail.verdict + '），仍完成正式评测';
    if (sampleFail.hint) sub.summary.hint = sampleFail.hint;
  }
  sub.status = 'done';
  sub.finishedAt = Date.now();
  store.saveIndex();
  // 清理评测工作目录（评测完即删；rejudge 会重新 copyFileSync 源码再编译）
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  // AI 自动检测（autoCheck 开且 autoBlock 关 = 评测后异步检测，不阻塞提交；autoBlock 开时已在提交时评测前检测）；
  // 管理员提交 / 离线导入的历史代码 / 已有检测结果的跳过
  const aiCfg = store.CONFIG.aiReview || {};
  if (aiReviewEnabled(store.CONFIG) && aiCfg.autoCheck && !aiCfg.autoBlock && !sub.aiReview && !sub.imported) {
    const submitter = store.users.find((u) => u.id === sub.uid);
    if (!submitter || !isAdminUser(submitter)) {
      (async () => {
        let code = '';
        try { code = fs.readFileSync(path.join(store.SUB_DIR, sub.codeFile), 'utf8'); } catch (e) { return; }
        const r = await aiReviewCode(code, sub.std, aiCfg);
        if (!r.ok) { store.appendLog(null, 'interact', '/api/ai-auto', '提交 #' + sub.id + ' AI 检测失败：' + r.error); return; }
        sub.aiReview = { risk: r.risk, categories: r.categories, summary: r.summary, model: r.model, at: Date.now() };
        store.saveIndex();
        if (riskLevel(r.risk) >= 2) store.appendLog(null, 'interact', '/api/ai-auto', '提交 #' + sub.id + '（' + sub.username + '）AI 检测为 ' + r.risk + '：' + (r.categories || []).join('/'));
        // 高风险即使未开拦截也强制执行：隐藏结果 + 禁止提交 1 分钟（用户要求）
        if (r.risk === 'high') {
          sub.aiBlocked = true;
          sub.hidden = true;
          if (sub.uid != null) submitBan.set(sub.uid, Date.now() + 60 * 1000);
          store.saveIndex();
          store.appendLog(null, 'interact', '/api/ai-auto', '提交 #' + sub.id + '（' + sub.username + '）高风险，已拦截并暂停其提交 1 分钟');
        }
      })();
    }
  }
}

function pump() {
  while (runningSubs.size < MAX_PARALLEL && queue.length > 0) {
    // 公平调度：选「所属用户当前占用最少」的提交（占用相同则按 FIFO 队头）
    // 单用户上限 MAX_PER_USER；多用户同时评测时，占用多的用户让位给占用少的用户
    let bestIdx = -1, bestCnt = Infinity;
    for (let i = 0; i < queue.length; i++) {
      const s = queue[i];
      const cnt = (s.uid != null ? (runningUsers.get(s.uid) || 0) : 0);
      if (cnt >= MAX_PER_USER) continue; // 该用户已占满，跳过
      if (cnt < bestCnt) { bestCnt = cnt; bestIdx = i; }
    }
    if (bestIdx === -1) break; // 无任何可调度的提交（所有等待用户都占满）
    const sub = queue.splice(bestIdx, 1)[0];
    runningSubs.set(sub.id, sub);
    if (sub.uid != null) runningUsers.set(sub.uid, (runningUsers.get(sub.uid) || 0) + 1);
    judgeOne(sub).catch((e) => {
      sub.status = 'done';
      sub.summary = { verdict: 'SE', display: 'SE', firstError: '系统错误: ' + e.message };
      store.saveIndex();
      try { fs.rmSync(path.join(store.WORK_DIR, String(sub.id)), { recursive: true, force: true }); } catch (e2) { /* ignore */ } // M-15：SE 路径也清理 workDir
    }).finally(() => {
      runningSubs.delete(sub.id);
      freeJudgeUid(sub._judgeUid); // 释放池 uid（所有路径：成功/CE/SE/异常）
      if (sub.uid != null) {
        const c = (runningUsers.get(sub.uid) || 1) - 1;
        if (c <= 0) runningUsers.delete(sub.uid); else runningUsers.set(sub.uid, c);
      }
      pump();
    });
  }
}

function enqueue(sub) {
  queue.push(sub);
  pump();
}

// ---- 线下机房模考代码包导入：临时解压目录注册表（预览→确认导入两步，token 引用）----
const offlineTmp = new Map(); // token -> { dir, at }
try { // 启动时清理过期（>2h）的旧解压目录
  for (const f of fs.readdirSync(os.tmpdir())) {
    if (!f.startsWith('tgboj-offline-')) continue;
    const p = path.join(os.tmpdir(), f);
    try { if (Date.now() - fs.statSync(p).mtimeMs > 2 * 3600 * 1000) fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
} catch (e) { /* ignore */ }
setInterval(() => {
  const cutoff = Date.now() - 2 * 3600 * 1000;
  for (const [tok, v] of offlineTmp) {
    if (v.at < cutoff) { offlineTmp.delete(tok); try { fs.rmSync(v.dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  }
}, 30 * 60 * 1000).unref();

// ---- 可见性：管理员 | 提交者本人(IP) | 提交已 AC 且该 IP 也有 AC | 导入的 OI 代码（离线模考/作业期次导入）所有登录用户无限制查看 ----
function canViewCode(sub, me) {
  if (isAdminUser(me)) return true;
  if (!me) return false;
  // S-5：模考 hideVerdict 未公布期间，除本人外一律不可看该考试提交的代码/样例/错误数据（防考试中互看）
  if (sub.examId) {
    const ex = store.exams.find((e) => e.id === sub.examId);
    if (ex && ex.hideVerdict && Date.now() < ex.publishAt) {
      return (sub.uid && sub.uid === me.id) || (sub.username && sub.username === me.username);
    }
  }
  if (sub.imported) return true; // 导入代码对全体登录用户开放（含样例/Ex 数据详情）
  if (sub.uid && sub.uid === me.id) return true;
  // 旧提交（无 uid）：按用户名兼容
  if (!sub.uid && sub.username && sub.username === me.username) return true;
  if (sub.summary && sub.summary.verdict === 'AC') {
    return store.submissions.some((s) => s.uid === me.id && s.summary && s.summary.verdict === 'AC');
  }
  return false;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };

// 题面内嵌图片（附件为图片类型时 raw 匿名可读：题面公开，图片需随题面可见）
function isImageAttachmentRaw(pathname) {
  const m = /^\/files\/(\d+)\/raw$/.exec(pathname);
  if (!m) return false;
  const f = store.filesData.find((x) => x.id === parseInt(m[1], 10));
  // M-9：SVG 可内嵌脚本，不参与匿名放行（其余位图类型仍匿名可读供题面 <img> 内嵌）
  return !!(f && store.IMG_MIME[f.ext] && f.ext !== '.svg');
}

const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }
const publicRoutes = [];
function publicRoute(method, pattern, handler) { publicRoutes.push({ method, pattern, handler }); }
route('GET', '/api/warnings', async (req, res, pathname) => {
      const q = getQuery(req);
      const pid = parseInt(q.problem, 10) || 0;
      if (!store.getProblem(pid)) return sendJson(res, 404, { error: '题目不存在' });
      const me = authUser(req);
      const w = store.loadWarnings(pid);
      const mineId = me ? me.id : null;
      const isAdm = me && isAdminUser(me);
      // 历史版本仅管理员和发布人可见
      const decorate = (x) => {
        const canSeeHist = isAdm || x.uid === mineId;
        return Object.assign({}, x, { history: canSeeHist ? (x.history || []) : [] });
      };
      const visible = w.list.filter((x) => x.visible).map(decorate);
      const mine = mineId ? w.list.filter((x) => x.uid === mineId).map(decorate) : [];
      return sendJson(res, 200, { list: visible, mine });
    });
route('POST', '/api/warning', async (req, res, pathname) => {
      const me = authUser(req);
      if (!me) return sendUnauthorized(res);
      const body = await readJson(req);
      const pid = parseInt(body.problemId, 10) || 0;
      if (!store.getProblem(pid)) return sendJson(res, 404, { error: '题目不存在' });
      const w = store.loadWarnings(pid);
      const mine = w.list.filter((x) => x.uid === me.id);
      const text = String(body.text || '').trim();
      if (!text) return sendJson(res, 400, { error: '请填写警示说明' });
      const now = Date.now();
      if (mine.length) {
        mine[0].history = mine[0].history || [];
        mine[0].history.push({ text: mine[0].text, sampleIn: mine[0].sampleIn, sampleOut: mine[0].sampleOut, updatedAt: mine[0].updatedAt });
        if (mine[0].history.length > 50) mine[0].history = mine[0].history.slice(-50); // 最多保留 50 个历史版本
        mine[0].text = text;
        mine[0].sampleIn = String(body.sampleIn || '').trim();
        mine[0].sampleOut = String(body.sampleOut || '').trim();
        mine[0].updatedAt = now;
      } else {
        w.list.push({
          id: w.list.length ? Math.max.apply(null, w.list.map((x) => x.id)) + 1 : 1,
          uid: me.id, username: me.username, fullname: me.fullname || me.username,
          text, sampleIn: String(body.sampleIn || '').trim(), sampleOut: String(body.sampleOut || '').trim(),
          visible: true, createdAt: now, updatedAt: now,
        });
      }
      store.saveWarnings(pid, w);
      return sendJson(res, 200, { ok: true, mine: w.list.filter((x) => x.uid === me.id), visible: w.list.filter((x) => x.visible) });
    });
route('POST', '/api/warning/toggle', async (req, res, pathname) => {
      const me = authUser(req);
      if (!me) return sendUnauthorized(res);
      const body = await readJson(req);
      const pid = parseInt(body.problemId, 10) || 0;
      if (!store.getProblem(pid)) return sendJson(res, 404, { error: '题目不存在' });
      const w = store.loadWarnings(pid);
      const mine = w.list.filter((x) => x.uid === me.id);
      if (!mine.length) return sendJson(res, 404, { error: '你还没有写过警示' });
      mine[0].visible = !mine[0].visible;
      mine[0].updatedAt = Date.now();
      store.saveWarnings(pid, w);
      return sendJson(res, 200, { ok: true, mine: w.list.filter((x) => x.uid === me.id), visible: w.list.filter((x) => x.visible) });
    });
route('POST', '/api/admin/user/audit', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const u = store.users.find((x) => x.id === parseInt(body.id, 10));
      if (!u) return sendJson(res, 404, { error: '用户不存在' });
      if (u.role !== 'user' && me.role !== 'superadmin') return sendForbidden(res, '仅超级管理员可审核管理员账号'); // M-3
      if (body.action === 'approve') { u.status = 'active'; u.approvedAt = Date.now(); }
      else if (body.action === 'reject') { u.status = 'rejected'; }
      else return sendJson(res, 400, { error: '未知操作' });
      store.saveUsers();
      return sendJson(res, 200, { ok: true, status: u.status });
    });
route('POST', '/api/admin/user/role', async (req, res, pathname) => {
      const me = authUser(req);
      if (!me || me.role !== 'superadmin') return sendForbidden(res, '仅超级管理员可任命管理员');
      const body = await readJson(req);
      const u = store.users.find((x) => x.id === parseInt(body.id, 10));
      if (!u) return sendJson(res, 404, { error: '用户不存在' });
      if (u.role === 'superadmin') return sendJson(res, 400, { error: '不能修改超级管理员' });
      u.role = body.role === 'admin' ? 'admin' : 'user';
      store.saveUsers();
      return sendJson(res, 200, { ok: true, role: u.role });
    });
route('GET', '/api/admin/users', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      return sendJson(res, 200, { users: store.users.map((u) => ({ id: u.id, username: u.username, fullname: u.fullname, studentId: u.studentId || '', role: u.role, status: u.status, createdAt: u.createdAt })) });
    });
// 用户管理：新增 / 更新单个账号（管理员）
route('POST', '/api/admin/user/save', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const id = parseInt(body.id, 10) || 0;
      const username = String(body.username || '').trim().toLowerCase().slice(0, 30);
      const fullname = String(body.fullname || '').trim().slice(0, 30);
      const studentId = String(body.studentId == null ? '' : body.studentId).trim().slice(0, 30);
      const password = String(body.password || '');
      if (!/^[a-z][a-z0-9_]{1,15}$/.test(username)) return sendJson(res, 400, { error: '用户名须以字母开头，2-16 位字母/数字/下划线' });
      const clash = store.users.find((u) => u.username === username && u.id !== id);
      if (clash) return sendJson(res, 400, { error: '用户名已被占用' });
      let u = id ? store.users.find((x) => x.id === id) : null;
      if (id && !u) return sendJson(res, 404, { error: '用户不存在' });
      if (u && u.role === 'superadmin' && me.role !== 'superadmin') return sendForbidden(res, '仅超级管理员可修改超管');
      if (u && u.role === 'admin' && me.role !== 'superadmin' && u.id !== me.id) return sendForbidden(res, '仅超级管理员可修改管理员账号'); // 平级保护（对齐 /api/admin/user/password 的 M-3）
      if (!u) {
        if (!fullname) return sendJson(res, 400, { error: '姓名不能为空' });
        if (password.length < 7) return sendJson(res, 400, { error: '密码至少 7 位' });
        const salt = crypto.randomBytes(8).toString('hex');
        u = { id: store.users.length ? Math.max(...store.users.map((x) => x.id)) + 1 : 1, username, fullname, studentId: studentId || undefined, role: 'user', status: 'active', salt, passwordHash: store.hashPw(password, salt), createdAt: Date.now(), approvedAt: Date.now() };
        store.users.push(u);
      } else {
        u.username = username;
        if (fullname) u.fullname = fullname;
        u.studentId = studentId || undefined;
        if (password) {
          if (password.length < 7) return sendJson(res, 400, { error: '密码至少 7 位' });
          u.salt = crypto.randomBytes(8).toString('hex');
          u.passwordHash = store.hashPw(password, u.salt);
          u.mustChangePassword = false; // 管理员代设新密码即视为已完成改密
        }
        if (u.role !== 'superadmin' && me.role === 'superadmin') {
          if (body.role === 'admin' || body.role === 'user') u.role = body.role;
          if (body.status === 'active' || body.status === 'rejected') u.status = body.status;
        }
      }
      store.saveUsers();
      return sendJson(res, 200, { ok: true, user: { id: u.id, username: u.username, fullname: u.fullname, studentId: u.studentId || '', role: u.role, status: u.status } });
    });
// 用户管理：管理员重置密码（重置后踢出该用户全部会话）
route('POST', '/api/admin/user/password', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const u = store.users.find((x) => x.id === parseInt(body.id, 10));
      if (!u) return sendJson(res, 404, { error: '用户不存在' });
      if ((u.role === 'admin' || u.role === 'superadmin') && me.role !== 'superadmin') return sendForbidden(res, '仅超级管理员可修改管理员密码'); // M-3
      const password = String(body.password || '');
      if (password.length < 7) return sendJson(res, 400, { error: '密码至少 7 位' });
      u.salt = crypto.randomBytes(8).toString('hex');
      u.passwordHash = store.hashPw(password, u.salt);
      u.mustChangePassword = false;
      store.saveUsers();
      for (const k of Object.keys(store.sessions)) if (store.sessions[k].uid === u.id) delete store.sessions[k];
      store.saveSessions();
      return sendJson(res, 200, { ok: true, message: '密码已重置，该用户所有会话已失效' });
    });
// 删除用户（P2：此前只能手改 users.json）——仅超管；保留其提交/答案历史（以 username/name 字段展示）
route('POST', '/api/admin/user/delete', async (req, res, pathname) => {
      const me = authUser(req);
      if (!me || me.role !== 'superadmin') return sendForbidden(res, '仅超级管理员可删除用户');
      const body = await readJson(req);
      const u = store.users.find((x) => x.id === parseInt(body.id, 10));
      if (!u) return sendJson(res, 404, { error: '用户不存在' });
      if (u.role === 'superadmin') return sendJson(res, 400, { error: '不能删除超级管理员' });
      if (u.id === me.id) return sendJson(res, 400, { error: '不能删除当前登录账号' });
      store.users = store.users.filter((x) => x.id !== u.id);
      store.saveUsers();
      for (const k of Object.keys(store.sessions)) if (store.sessions[k].uid === u.id) delete store.sessions[k];
      store.saveSessions();
      return sendJson(res, 200, { ok: true, id: u.id, username: u.username });
    });
// 用户管理：批量建号 [{username, fullname, studentId, password}]，缺省密码 defaultPassword
route('POST', '/api/admin/users/batch', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const items = Array.isArray(body.users) ? body.users : [];
      if (!items.length) return sendJson(res, 400, { error: '没有要导入的用户' });
      const defaultPassword = String(body.defaultPassword || '');
      const results = [];
      let created = 0;
      for (const it of items) {
        const sid = String(it.studentId == null ? '' : it.studentId).trim().slice(0, 30);
        const fullname = String(it.fullname || '').trim().slice(0, 30);
        const username = String(it.username || '').trim().toLowerCase().slice(0, 30);
        if (username && !/^[a-z][a-z0-9_]{1,15}$/.test(username)) {
          results.push({ username, fullname, studentId: sid, status: 'skipped', reason: '用户名格式不合法' });
          continue;
        }
        const bySid = sid && store.users.find((u) => u.studentId != null && String(u.studentId) === sid);
        if (bySid && (!username || bySid.username !== username)) {
          results.push({ username: username || bySid.username, fullname, studentId: sid, status: 'skipped', reason: '编号已绑定账号 ' + bySid.username + '，跳过' });
          continue;
        }
        if (!username) {
          results.push({ username: '', fullname, studentId: sid, status: 'skipped', reason: '缺少用户名且编号未匹配到已有账号' });
          continue;
        }
        const byName = store.users.find((u) => u.username === username);
        if (byName) {
          const same = byName.studentId != null && String(byName.studentId) === sid;
          results.push({ username, fullname, studentId: sid, status: 'skipped', reason: same ? '已存在（编号一致），跳过' : '用户名已被占用，跳过' });
          continue;
        }
        const password = String(it.password || defaultPassword || '');
        if (password.length < 7) {
          results.push({ username, fullname, studentId: sid, status: 'skipped', reason: '密码少于 7 位，跳过' });
          continue;
        }
        const salt = crypto.randomBytes(8).toString('hex');
        const u = { id: store.users.length ? Math.max(...store.users.map((x) => x.id)) + 1 : 1, username, fullname, studentId: sid || undefined, role: 'user', status: 'active', salt, passwordHash: store.hashPw(password, salt), createdAt: Date.now(), approvedAt: Date.now() };
        store.users.push(u);
        created++;
        results.push({ username, fullname, studentId: sid, status: 'created', reason: '已创建' });
      }
      if (created) store.saveUsers();
      return sendJson(res, 200, { ok: true, created, skipped: results.length - created, results });
    });
route('POST', '/api/log', async (req, res, pathname) => {
      const me = authUser(req);
      if (!me) return sendUnauthorized(res);
      const body = await readJson(req);
      store.appendLog(me, String(body.action || 'interact').slice(0, 40), String(body.page || '').slice(0, 120), String(body.detail || '').slice(0, 300));
      return sendJson(res, 200, { ok: true });
    });
route('POST', '/api/problem/view', async (req, res, pathname) => {
      const me = authUser(req);
      if (!me) return sendUnauthorized(res);
      const body = await readJson(req);
      const pid = parseInt(body.problemId, 10);
      if (!store.getProblem(pid)) return sendJson(res, 404, { error: '题目不存在' });
      const key = String(pid);
      if (!store.problemViews[key]) store.problemViews[key] = [];
      if (store.problemViews[key].indexOf(me.id) === -1) {
        store.problemViews[key].push(me.id);
        store.saveProblemViews();
      }
      return sendJson(res, 200, { ok: true });
    });
route('GET', '/api/admin/logs', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const q = getQuery(req);
      const n = Math.min(parseInt(q.limit, 10) || 200, 2000);
      const user = String(q.user || '').trim().toLowerCase();
      const page = String(q.page || '').trim().toLowerCase();
      const action = String(q.action || '').trim().toLowerCase();
      let out = store.logs;
      if (user) out = out.filter((l) => String(l.username || '').toLowerCase().indexOf(user) !== -1 || String(l.fullname || '').toLowerCase().indexOf(user) !== -1);
      if (page) out = out.filter((l) => String(l.page || '').toLowerCase().indexOf(page) !== -1);
      if (action) out = out.filter((l) => String(l.action || '').toLowerCase().indexOf(action) !== -1);
      return sendJson(res, 200, { logs: out.slice(-n).reverse() });
    });
route('GET', '/api/admin/plagiarism', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const q = getQuery(req);
      const pid = parseInt(q.problemId, 10);
      if (!pid) return sendJson(res, 400, { error: '缺少 problemId' });
      // 只查已评测完成的提交（跳过队列中/编译错误）
      const subs = store.submissions.filter((s) => s.problemId === pid && s.status === 'done');
      const items = [];
      for (const s of subs) {
        let code = '';
        try { code = fs.readFileSync(path.join(store.SUB_DIR, s.codeFile), 'utf8'); } catch (e) { /* 代码文件缺失 */ }
        if (!code) continue;
        items.push({
          id: s.id, username: s.username || '', name: s.name || '', std: s.std,
          verdict: s.summary ? s.summary.verdict : '',
          submittedAt: s.submittedAt, codeLen: code.length, code,
        });
      }
      const pairs = findPairs(items);
      return sendJson(res, 200, {
        submissions: items.map((x) => { const { code, ...rest } = x; return rest; }),
        pairs,
      });
    });
route('GET', '/api/contest', async (req, res, pathname) => {
      const c = store.contest || { startAt: 0, endAt: 0, title: '', mode: 'oi', penaltyMinutes: 20 };
      const now = Date.now();
      const status = !c.startAt ? 'none' : (now < c.startAt ? 'upcoming' : (now > c.endAt ? 'ended' : 'running'));
      return sendJson(res, 200, {
        contest: { startAt: c.startAt, endAt: c.endAt, title: c.title || '', mode: c.mode || 'oi', penaltyMinutes: c.penaltyMinutes || 20 },
        status, now,
      });
    });
route('POST', '/api/admin/contest', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const c = store.contest;
      if (body.clear) {
        c.startAt = 0; c.endAt = 0; c.title = ''; c.freezeMinutes = 0;
      } else {
        const startAt = parseInt(body.startAt, 10);
        const endAt = parseInt(body.endAt, 10);
        if (!startAt || !endAt) return sendJson(res, 400, { error: '请填写开始/结束时间' });
        if (endAt <= startAt) return sendJson(res, 400, { error: '结束时间需晚于开始时间' });
        const mode = String(body.mode || c.mode || 'oi').toLowerCase(); // 赛制：oi（末次）/ ioi（最高）/ acm（罚时）
        if (['oi', 'ioi', 'acm'].indexOf(mode) === -1) return sendJson(res, 400, { error: '赛制只能是 oi / ioi / acm' });
        c.startAt = startAt;
        c.endAt = endAt;
        c.title = String(body.title || '').trim();
        c.mode = mode;
        c.penaltyMinutes = Math.min(Math.max(parseInt(body.penaltyMinutes, 10) || 20, 0), 600);
        // 封榜：比赛结束前 freezeMinutes 分钟起榜单冻结（0=关闭）；封榜期内的提交不进入学生视角榜单
        c.freezeMinutes = Math.min(Math.max(parseInt(body.freezeMinutes, 10) || 0, 0), 600);
      }
      store.saveContest();
      return sendJson(res, 200, { ok: true, contest: c });
    });
// 比赛榜单：按赛制实时计算（oi=每题取末次，ioi=每题取最高，acm=解题数+罚时）。需登录（学生/管理员）
route('GET', '/api/contest/rank', async (req, res, pathname) => {
      const me = authUser(req);
      if (!me) return sendUnauthorized(res);
      const c = store.contest || {};
      const now = Date.now();
      if (!c.startAt || !c.endAt) {
        return sendJson(res, 200, { contest: { startAt: 0, endAt: 0, title: '', mode: c.mode || 'oi', penaltyMinutes: c.penaltyMinutes || 20, freezeMinutes: c.freezeMinutes || 0 }, status: 'none', now, freeze: { minutes: 0, startAt: 0, frozen: false }, problems: [], rows: [] });
      }
      const status = now < c.startAt ? 'upcoming' : (now > c.endAt ? 'ended' : 'running');
      const mode = c.mode || 'oi';
      const penMin = c.penaltyMinutes || 20;
      // 赛前预览（仅管理员）：比赛未开始时普通用户看不到任何题目列（窗口内无提交）；
      // 管理员返回当前期次编程题作为预览题目集（含隐藏题并标注，便于赛前检查题单/赛制/封榜设置）
      if (status === 'upcoming') {
        if (!isAdminUser(me)) {
          return sendJson(res, 200, { contest: { startAt: c.startAt, endAt: c.endAt, title: c.title || '', mode, penaltyMinutes: penMin, freezeMinutes: c.freezeMinutes || 0 }, status, now, freeze: { minutes: 0, startAt: 0, frozen: false }, problems: [], rows: [] });
        }
        const order0 = store.hwData.programmingOrder || [];
        const orderMap0 = {}; order0.forEach((id, i) => { orderMap0[id] = i; });
        const previewProbs = store.PROBLEMS
          .filter((p) => p.judgeable && orderMap0[p.id] !== undefined)
          .sort((a, b) => (orderMap0[a.id] - orderMap0[b.id]) || (a.id - b.id))
          .map((p) => ({ id: p.id, title: p.title, hidden: !!p.hidden }));
        return sendJson(res, 200, { contest: { startAt: c.startAt, endAt: c.endAt, title: c.title || '', mode, penaltyMinutes: penMin, freezeMinutes: c.freezeMinutes || 0 }, status, now, freeze: { minutes: 0, startAt: 0, frozen: false }, preview: true, problems: previewProbs, rows: [] });
      }
      // 封榜：running 期间进入 [endAt - freezeMinutes, endAt] 后，非管理员榜单冻结（只统计封榜前的提交）；
      // 比赛结束后自动解封。freezeMinutes=0 即关闭。统一使用 contestFreezeState（与 /api/status、/api/rank 一致）。
      const freeze = contestFreezeState(me);
      const freezeMinutes = freeze.freezeMinutes;
      const freezeStart = freeze.freezeStart;
      const frozenNow = freeze.frozen;
      const adminIds = {}, adminNames = {};
      for (const u of store.users) if (u.role === 'admin' || u.role === 'superadmin') { adminIds[u.id] = true; adminNames[u.username] = true; }
      const isAdminSub = (s) => (s.uid && adminIds[s.uid]) || (!s.uid && s.username && adminNames[s.username]);
      const windowSubs = store.submissions.filter((s) => !s.hidden && !isAdminSub(s) && !s.examId && s.submittedAt >= c.startAt && s.submittedAt <= c.endAt);
      const visibleSubs = frozenNow ? windowSubs.filter((s) => s.submittedAt <= freezeStart) : windowSubs;
      // 题目列：窗口内有提交的非隐藏可评测题，按当前期编程顺序再题号
      const pidSet = {}; for (const s of visibleSubs) pidSet[s.problemId] = true;
      const order = store.hwData.programmingOrder || [];
      const orderMap = {}; order.forEach((id, i) => { orderMap[id] = i; });
      const probs = store.PROBLEMS
        .filter((p) => p.judgeable && !p.hidden && pidSet[p.id])
        .sort((a, b) => ((orderMap[a.id] !== undefined ? orderMap[a.id] : 1e9) - (orderMap[b.id] !== undefined ? orderMap[b.id] : 1e9)) || (a.id - b.id));
      const probIds = {}; for (const p of probs) probIds[p.id] = true;
      const rows = {};
      for (const s of visibleSubs) {
        if (!probIds[s.problemId]) continue;
        const key = s.uid ? 'u' + s.uid : (s.username ? 'n' + s.username : (s.ip ? 'i' + s.ip : '?'));
        const r = rows[key] = rows[key] || { username: s.username || '?', fullname: s.name || '', probs: {} };
        const pr = r.probs[s.problemId] = r.probs[s.problemId] || { subs: [], score: null, ac: false, acAt: 0, best: 0, last: null };
        const sc = (s.score != null && s.score >= 0) ? s.score : (s.summary && s.summary.score != null ? s.summary.score : null);
        if (sc != null) {
          if (sc > pr.best) pr.best = sc;
          pr.last = sc; // 窗口内按时间序推进，循环结束后 last = 末次提交成绩
          if (sc >= 100 && !pr.ac) { pr.ac = true; pr.acAt = s.submittedAt; }
        }
        pr.subs.push(s);
      }
      const list = Object.keys(rows).map((k) => {
        const r = rows[k];
        const cells = {};
        let solved = 0, penalty = 0, total = 0;
        for (const p of probs) {
          const pr = r.probs[p.id];
          if (!pr) { cells[p.id] = { attempts: 0, solved: false, score: null, penalty: 0 }; continue; }
          const attempts = pr.subs.length;
          if (mode === 'acm') {
            let pen = 0;
            if (pr.ac) {
              const before = pr.subs.filter((x) => x.submittedAt <= pr.acAt).length - 1;
              pen = Math.max(0, Math.floor((pr.acAt - c.startAt) / 60000)) + penMin * before;
              solved++; penalty += pen;
            }
            cells[p.id] = { attempts, solved: pr.ac, score: null, penalty: pen };
          } else {
            const sc = mode === 'ioi' ? pr.best : (pr.last != null ? pr.last : pr.best); // oi=末次（无末次回退最高），ioi=最高
            const eff = sc != null ? sc : 0;
            if (eff > 0) total += eff;
            cells[p.id] = { attempts, solved: pr.ac, score: eff, penalty: 0 };
          }
        }
        return { username: r.username, fullname: r.fullname, solved, penalty, total, cells };
      });
      if (mode === 'acm') {
        list.sort((a, b) => (b.solved - a.solved) || (a.penalty - b.penalty) || (a.username < b.username ? -1 : 1));
      } else {
        list.sort((a, b) => (b.total - a.total) || (a.username < b.username ? -1 : 1));
      }
      for (let i = 0; i < list.length; i++) list[i].rank = i + 1;
      return sendJson(res, 200, {
        contest: { startAt: c.startAt, endAt: c.endAt, title: c.title || '', mode, penaltyMinutes: penMin, freezeMinutes },
        status, now,
        freeze: { minutes: freezeMinutes, startAt: freezeStart, frozen: frozenNow },
        problems: probs.map((p) => ({ id: p.id, title: p.title, testCount: p.tests.length })),
        rows: list,
      });
    });
// ---- 评测队列监控（管理页「🏆 比赛」旁的面板用）----
route('GET', '/api/admin/queue', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const uname = (s) => {
        const u = s && store.users.find((x) => x.id === s.uid);
        return u ? u.username : ((s && s.username) || '?');
      };
      const ptitle = (pid) => { const p = store.getProblem(pid); return p ? p.title : ''; };
      return sendJson(res, 200, {
        maxParallel: MAX_PARALLEL, maxPerUser: MAX_PER_USER,
        running: Array.from(runningSubs.values()).map((s) => ({ id: s.id, username: uname(s), problemId: s.problemId, problemTitle: ptitle(s.problemId), submittedAt: s.submittedAt || 0, judgedAt: s._judgedAt || 0 })),
        queued: queue.map((s) => ({ id: s.id, username: uname(s), problemId: s.problemId, submittedAt: s.submittedAt || 0 })),
        runningCount: runningSubs.size, queuedCount: queue.length,
        perUser: Object.fromEntries(runningUsers),
        judgePool: JUDGE_UID_POOL.map((u) => ({ uid: u, busy: judgeUidBusy.get(u) || 0 })),
      });
    });

// ---- 比赛澄清（clarification）：比赛窗口内学生提问，管理员回复（公开/私密）----
const clarTrack = new Map(); // uid -> {count, at}（限速：10 分钟内最多 3 条）
route('GET', '/api/clar', async (req, res, pathname) => {
      const me = authUser(req);
      if (!me) return sendUnauthorized(res);
      const c = store.contest || {};
      const now = Date.now();
      const active = !!(c.startAt && c.endAt && now >= c.startAt && now <= c.endAt);
      const adm = isAdminUser(me);
      const list = store.loadClars()
        .filter((x) => adm || x.uid === me.id || (x.public && x.reply))
        .sort((a, b) => a.createdAt - b.createdAt);
      return sendJson(res, 200, { list, contestActive: active });
    });
route('POST', '/api/clar', async (req, res, pathname) => {
      const me = authUser(req);
      if (!me) return sendUnauthorized(res);
      const c = store.contest || {};
      const now = Date.now();
      if (!c.startAt || !c.endAt || now < c.startAt || now > c.endAt) return sendJson(res, 403, { error: '比赛未进行，无法提交澄清' });
      const rec = clarTrack.get(me.id) || { count: 0, at: 0 };
      if (now - rec.at > 10 * 60 * 1000) { rec.count = 0; rec.at = now; }
      if (rec.count >= 3) return sendJson(res, 429, { error: '澄清提交过于频繁，请稍后再试' });
      const body = await readJson(req);
      const text = String(body.text || '').trim().slice(0, 500);
      if (!text) return sendJson(res, 400, { error: '请填写澄清内容' });
      let problemId = parseInt(body.problemId, 10) || 0;
      if (problemId && !store.getProblem(problemId)) problemId = 0;
      const clars = store.loadClars();
      const id = clars.length ? Math.max(...clars.map((x) => x.id)) + 1 : 1;
      clars.push({ id, uid: me.id, username: me.username, fullname: me.fullname, problemId, text, createdAt: now, reply: '', repliedAt: 0, public: false, replyBy: '' });
      rec.count++; clarTrack.set(me.id, rec);
      store.saveClars();
      return sendJson(res, 200, { ok: true, id });
    });
route('POST', '/api/admin/clar/reply', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const id = parseInt(body.id, 10) || 0;
      const reply = String(body.reply || '').trim().slice(0, 1000);
      if (!id || !reply) return sendJson(res, 400, { error: '请填写回复内容' });
      const clars = store.loadClars();
      const x = clars.find((y) => y.id === id);
      if (!x) return sendJson(res, 404, { error: '澄清不存在' });
      x.reply = reply;
      x.repliedAt = Date.now();
      x.public = !!body.public;
      x.replyBy = me.username;
      store.saveClars();
      return sendJson(res, 200, { ok: true });
    });

// ---- 个人中心：个人简介 + 导出我的全部代码 ----
route('POST', '/api/me/save', async (req, res, pathname) => {
      const me = authUser(req);
      if (!me) return sendUnauthorized(res);
      const body = await readJson(req);
      if (body.bio !== undefined) {
        const bio = String(body.bio || '').trim().slice(0, 200);
        me.bio = bio;
        store.saveUsers();
      }
      return sendJson(res, 200, { ok: true, bio: me.bio || '' });
    });
route('GET', '/api/my/code/export', async (req, res, pathname) => {
      const me = authUser(req);
      if (!me) return sendUnauthorized(res);
      const mine = store.submissions.filter((s) => (s.uid != null && s.uid === me.id) || (s.uid == null && s.username === me.username));
      if (!mine.length) return sendJson(res, 400, { error: '你还没有提交记录' });
      const tmpd = fs.mkdtempSync(path.join(os.tmpdir(), 'tgboj-export-'));
      const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'problem';
      const lines = ['# 我的代码导出（TGBOJ）', '', '账号：' + me.username + '（' + (me.fullname || '') + '）', '导出时间：' + new Date().toLocaleString('zh-CN', { hour12: false }), '共 ' + mine.length + ' 份提交', ''];
      let n = 0;
      for (const s of mine.slice().sort((a, b) => (a.submittedAt || 0) - (b.submittedAt || 0))) {
        const src = path.join(store.SUB_DIR, s.codeFile || '');
        if (!s.codeFile || !fs.existsSync(src)) continue;
        const p = store.getProblem(s.problemId);
        const ext = s.std === 'python3' ? '.py' : (s.std === 'c11' ? '.c' : '.cpp');
        const fn = s.id + '_' + s.problemId + '_' + safeName(p ? p.title : '') + ext;
        try { fs.copyFileSync(src, path.join(tmpd, fn)); n++; } catch (e) { continue; }
        const v = (s.summary && s.summary.verdict) || '?';
        const sc = s.score != null ? s.score : (s.summary && s.summary.score != null ? s.summary.score : null);
        lines.push('- #' + s.id + '  ' + (p ? p.id + ' ' + p.title : s.problemId) + '  ' + v + (sc != null ? ' ' + sc + '分' : '') + '  ' + new Date(s.submittedAt || 0).toLocaleString('zh-CN', { hour12: false }) + '  →  ' + fn);
      }
      if (!n) { try { fs.rmSync(tmpd, { recursive: true, force: true }); } catch (e) { /* ignore */ } return sendJson(res, 400, { error: '没有可导出的代码文件' }); }
      fs.writeFileSync(path.join(tmpd, 'README.md'), lines.join('\n') + '\n');
      const zipPath = path.join(tmpd, 'codes.zip');
      try {
        execFileSync('zip', ['-q', '-r', zipPath, '.'], { cwd: tmpd, stdio: 'pipe' });
      } catch (e) {
        try { fs.rmSync(tmpd, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
        return sendJson(res, 500, { error: '打包失败（zip 不可用？）' });
      }
      // F-11：流式返回 zip，避免把整包读入内存（提交量极大时不再造成内存峰值）
      const st = fs.statSync(zipPath);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': st.size,
        'Content-Disposition': 'attachment; filename="tgboj-codes-' + me.username + '.zip"',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
      });
      const rs = fs.createReadStream(zipPath);
      const cleanup = () => { try { fs.rmSync(tmpd, { recursive: true, force: true }); } catch (e) { /* ignore */ } };
      rs.on('error', cleanup);
      rs.on('close', cleanup);
      rs.pipe(res);
      return;
    });

// ---- 模考（考试）辅助 ----
function examStatus(ex, now) {
  const published = now >= ex.publishAt;
  if (now < ex.startAt) return { status: 'upcoming', published };
  if (now <= ex.endAt) return { status: 'running', published };
  return { status: 'ended', published };
}
// 提交的有效阶段：phase 字段优先；老数据按提交时间推断（endAt 前=考试期，之后=订正期）
function subPhase(sb, exam) { return sb.phase || (sb.submittedAt <= exam.endAt ? 'exam' : 'correction'); }
// 题目在模考场景下对学生的可见性（进行中或成绩已公布）；examsEnabled=false 时恒 false
function examAccessForProblem(pid, now) {
  if (store.CONFIG.examsEnabled === false) return false;
  return store.exams.some((e) => (e.problemIds || []).indexOf(pid) !== -1 && ((e.startAt <= now && now <= e.endAt) || (e.endAt < now && now >= e.publishAt)));
}
// 模考列表（学生/管理员）：状态 + 是否已公布
route('GET', '/api/exams', async (req, res, pathname) => {
      const me = authUser(req);
      if (!me) return sendUnauthorized(res);
      const now = Date.now();
      const list = store.exams.slice().sort((a, b) => b.startAt - a.startAt).map((e) => ({
        id: e.id, name: e.name, startAt: e.startAt, endAt: e.endAt, publishAt: e.publishAt,
        hideVerdict: !!e.hideVerdict, problemCount: (e.problemIds || []).length,
        ...examStatus(e, now),
      }));
      return sendJson(res, 200, { exams: list, now });
    });
// 模考详情 + 我的成绩（考试得分 / 订正得分）
route('GET', '/api/exam', async (req, res, pathname) => {
      const q = getQuery(req);
      const me = authUser(req);
      if (!me) return sendUnauthorized(res);
      const exam = store.exams.find((e) => e.id === parseInt(q.id, 10));
      if (!exam) return sendJson(res, 404, { error: '模考不存在' });
      const isAdm = isAdminUser(me);
      const now = Date.now();
      const st = examStatus(exam, now);
      const myHidden = !!exam.hideVerdict && !st.published && !isAdm; // S-5：成绩公布前不返回本人分数
      const problems = (exam.problemIds || []).map((pid) => {
        const p = store.getProblem(pid);
        if (!p) return null;
        // 隐藏题：进行中或已公布时对学生可见；否则仅管理员可见
        if (p.hidden && !isAdm && st.status !== 'running' && !st.published) return null;
        return {
          id: p.id, title: p.title, testCount: p.tests.length, hidden: !!p.hidden,
          scoring: (p.scoring && p.scoring.mode === 'subtask')
            ? { mode: 'subtask', subtasks: p.scoring.subtasks.map((s) => ({ id: s.id, score: s.score, tests: s.tests })) }
            : { mode: 'point', subtasks: [] },
        };
      }).filter(Boolean);
      // 我的成绩：考试期（phase=exam）取最高分；订正期（phase=correction）取最高分
      const my = {};
      for (const sb of store.submissions) {
        if (sb.examId !== exam.id || sb.uid !== me.id) continue;
        const sc = (sb.score != null && sb.score >= 0) ? sb.score : (sb.summary && sb.summary.score != null ? sb.summary.score : null);
        if (sc == null) continue; // 未评测完成
        const pid = sb.problemId;
        const slot = my[pid] = my[pid] || { examScore: null, examSubId: null, corrScore: null, corrSubId: null };
        if (subPhase(sb, exam) === 'exam') {
          if (slot.examScore == null || sc > slot.examScore) { slot.examScore = sc; slot.examSubId = sb.id; }
        } else {
          if (slot.corrScore == null || sc > slot.corrScore) { slot.corrScore = sc; slot.corrSubId = sb.id; }
        }
      }
      return sendJson(res, 200, {
        exam: { id: exam.id, name: exam.name, startAt: exam.startAt, endAt: exam.endAt, publishAt: exam.publishAt, hideVerdict: !!exam.hideVerdict },
        status: st.status, published: st.published, now, problems, my: myHidden ? {} : my, myHidden,
      });
    });
route('POST', '/api/admin/exam', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const name = String(body.name || '').trim().slice(0, 60);
      const problemIds = (Array.isArray(body.problemIds) ? body.problemIds : []).map((x) => parseInt(x, 10)).filter((x) => !isNaN(x) && store.getProblem(x));
      const startAt = parseInt(body.startAt, 10);
      const endAt = parseInt(body.endAt, 10);
      let publishAt = parseInt(body.publishAt, 10) || endAt;
      if (!name) return sendJson(res, 400, { error: '请填写模考名称' });
      if (!problemIds.length) return sendJson(res, 400, { error: '请至少选择一道题目' });
      if (!startAt || !endAt) return sendJson(res, 400, { error: '请填写开始/结束时间' });
      if (endAt <= startAt) return sendJson(res, 400, { error: '结束时间需晚于开始时间' });
      if (publishAt < endAt) publishAt = endAt; // 成绩公布不早于考试结束（可随时提前公布）
      const id = (store.exams.length ? Math.max(...store.exams.map((e) => e.id)) : 0) + 1;
      store.exams.push({ id, name, problemIds, startAt, endAt, publishAt, hideVerdict: body.hideVerdict !== false, owner: me.username || '', createdAt: Date.now() });
      store.saveExams();
      return sendJson(res, 200, { ok: true, id });
    });
route('POST', '/api/admin/exam/edit', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const exam = store.exams.find((e) => e.id === parseInt(body.id, 10));
      if (!exam) return sendJson(res, 404, { error: '模考不存在' });
      if (typeof body.name === 'string' && body.name.trim()) exam.name = body.name.trim().slice(0, 60);
      if (Array.isArray(body.problemIds)) {
        exam.problemIds = body.problemIds.map((x) => parseInt(x, 10)).filter((x) => !isNaN(x) && store.getProblem(x));
      }
      const startAt = parseInt(body.startAt, 10), endAt = parseInt(body.endAt, 10);
      if (startAt && endAt) {
        if (endAt <= startAt) return sendJson(res, 400, { error: '结束时间需晚于开始时间' });
        exam.startAt = startAt; exam.endAt = endAt;
      } else if (startAt) exam.startAt = startAt;
      else if (endAt) {
        if (endAt <= exam.startAt) return sendJson(res, 400, { error: '结束时间需晚于开始时间' });
        exam.endAt = endAt;
      }
      const publishAt = parseInt(body.publishAt, 10);
      if (publishAt) exam.publishAt = Math.max(publishAt, exam.endAt);
      if (typeof body.hideVerdict === 'boolean') exam.hideVerdict = body.hideVerdict;
      store.saveExams();
      return sendJson(res, 200, { ok: true, exam });
    });
route('POST', '/api/admin/exam/delete', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const id = parseInt(body.id, 10);
      const exam = store.exams.find((e) => e.id === id);
      if (!exam) return sendJson(res, 404, { error: '模考不存在' });
      store.exams = store.exams.filter((e) => e.id !== id);
      store.saveExams();
      // 保留历史提交（examId 指向已删除的考试时按普通提交处理）
      return sendJson(res, 200, { ok: true });
    });
route('POST', '/api/admin/exam/publish', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const exam = store.exams.find((e) => e.id === parseInt(body.id, 10));
      if (!exam) return sendJson(res, 404, { error: '模考不存在' });
      exam.publishAt = Date.now(); // 立即公布成绩
      store.saveExams();
      return sendJson(res, 200, { ok: true, publishAt: exam.publishAt });
    });
// 模考成绩表（管理员）：学生 × 题目 = 考试期最高分；含订正最高分与提交数
route('GET', '/api/admin/exam/results', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const q = getQuery(req);
      const exam = store.exams.find((e) => e.id === parseInt(q.examId, 10));
      if (!exam) return sendJson(res, 404, { error: '模考不存在' });
      const adminIds = {};
      for (const u of store.users) if (u.role === 'admin' || u.role === 'superadmin') adminIds[u.id] = true;
      const rows = {};
      for (const sb of store.submissions) {
        if (sb.examId !== exam.id || !sb.uid) continue;
        if (adminIds[sb.uid]) continue;
        const sc = (sb.score != null && sb.score >= 0) ? sb.score : (sb.summary && sb.summary.score != null ? sb.summary.score : null);
        if (sc == null) continue;
        const u = store.users.find((x) => x.id === sb.uid);
        const key = sb.uid;
        const row = rows[key] = rows[key] || { uid: sb.uid, username: sb.username || (u && u.username) || '?', fullname: sb.name || (u && u.fullname) || '', problems: {} };
        const cell = row.problems[sb.problemId] = row.problems[sb.problemId] || { score: null, subId: null, attempts: 0, corrScore: null, corrSubId: null, corrAttempts: 0 };
        if (subPhase(sb, exam) === 'exam') {
          cell.attempts++;
          if (cell.score == null || sc > cell.score) { cell.score = sc; cell.subId = sb.id; }
        } else {
          cell.corrAttempts++;
          if (cell.corrScore == null || sc > cell.corrScore) { cell.corrScore = sc; cell.corrSubId = sb.id; }
        }
      }
      const problems = (exam.problemIds || []).map((pid) => {
        const p = store.getProblem(pid);
        return p ? { id: p.id, title: p.title, testCount: p.tests.length } : null;
      }).filter(Boolean);
      const list = Object.values(rows).map((r) => {
        let total = 0, tried = 0;
        for (const pid in r.problems) { if (r.problems[pid].score != null) { total += r.problems[pid].score; tried++; } }
        return Object.assign(r, { total, tried });
      }).sort((a, b) => (b.total - a.total) || (a.fullname < b.fullname ? -1 : a.fullname > b.fullname ? 1 : 0));
      return sendJson(res, 200, { exam: { id: exam.id, name: exam.name, startAt: exam.startAt, endAt: exam.endAt, publishAt: exam.publishAt, published: Date.now() >= exam.publishAt }, problems, rows: list });
    });
// 模考成绩/代码同步导入：外部模考结束后的学生代码导入并本地评测（成绩表随评测自动生成）
route('POST', '/api/admin/exam/import', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req, 64 * 1024 * 1024);
      const exam = store.exams.find((e) => e.id === parseInt(body.examId, 10));
      if (!exam) return sendJson(res, 404, { error: '模考不存在' });
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return sendJson(res, 400, { error: '没有可导入的提交（items 为空）' });
      const errors = [];
      let created = 0;
      const t0 = exam.endAt || Date.now();
      for (const it of items) {
        const username = String((it && it.username) || '').trim().toLowerCase();
        const problemId = parseInt(it && it.problemId, 10);
        const code = String((it && it.code) || '');
        let std = String((it && it.std) || 'c++17').toLowerCase();
        if (std === 'py3' || std === 'python') std = 'python3';
        if (STD_LIST.indexOf(std) === -1) std = 'c++17';
        const u = store.users.find((x) => x.username === username);
        if (!u) { errors.push('用户 ' + username + ' 不存在'); continue; }
        if ((exam.problemIds || []).indexOf(problemId) === -1) { errors.push(username + ' 的题目 ' + problemId + ' 不在该模考中'); continue; }
        if (!code || code.length > 100000) { errors.push(username + ' 的代码为空或超过 100000 字符'); continue; }
        const id = (store.submissions.length ? Math.max(...store.submissions.map((s) => s.id)) : 0) + 1;
        const codeFile = id + (std === 'python3' ? '.py' : (std === 'c11' ? '.c' : '.cpp'));
        fs.writeFileSync(path.join(store.SUB_DIR, codeFile), code);
        store.submissions.push({
          id, uid: u.id, problemId, name: u.fullname || u.username, username: u.username, std, ip: reqIp(req),
          codeFile, submittedAt: parseInt(it.submittedAt, 10) || t0, status: 'queued', summary: null, points: [],
          examId: exam.id, phase: 'exam', imported: true,
        });
        enqueue(store.submissions[store.submissions.length - 1]);
        created++;
      }
      store.saveIndex();
      return sendJson(res, 200, { ok: true, created, errors: errors.slice(0, 50), errorsMore: errors.length > 50 ? errors.length - 50 : 0 });
    });
// ---- 线下机房模考代码包导入（zip/tar.gz：编号/题目名/题目名.cpp）----
// 第一步：上传解析 → 返回 token + 预览（编号→账号、题目名→题目 自动匹配结果）
route('POST', '/api/admin/exam/import-zip', async (req, res, pathname) => {
      const me = authUser(req); // M-1：鉴权前置
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const mp = await readMultipart(req, 512 * 1024 * 1024);
      if (!mp) return sendJson(res, 400, { error: '需要 multipart/form-data 上传' });
      const exam = store.exams.find((e) => e.id === parseInt(mp.field('examId'), 10));
      if (!exam) return sendJson(res, 404, { error: '模考不存在' });
      const file = mp.parts.find((p) => p.filename && p.filename !== '');
      if (!file) return sendJson(res, 400, { error: '请选择压缩包' });
      const fname = String(file.filename).toLowerCase();
      const kind = fname.endsWith('.zip') ? 'zip' : ((fname.endsWith('.tar.gz') || fname.endsWith('.tgz')) ? 'tar' : null);
      if (!kind) return sendJson(res, 400, { error: '仅支持 .zip 或 .tar.gz 压缩包' });
      const tmpd = fs.mkdtempSync(path.join(os.tmpdir(), 'tgboj-offline-'));
      try {
        const root = extractArchive(file.body, kind, tmpd);
        const scanned = scanStudents(root);
        if (!scanned.students.length) return sendJson(res, 400, { error: '未识别到「编号/题目名/*.cpp」结构，请检查压缩包（需先有编号目录，内含题目名目录与代码文件）' });
        const examProblems = (exam.problemIds || []).map((pid) => { const p = store.getProblem(pid); return p ? { id: p.id, title: p.title } : null; }).filter(Boolean);
        const allStudents = store.users.filter((u) => u.status === 'active' && u.role === 'user')
          .map((u) => ({ uid: u.id, username: u.username, fullname: u.fullname || '', studentId: u.studentId || '' }))
          .sort((a, b) => String(a.studentId || a.username).localeCompare(String(b.studentId || b.username), 'zh-CN'));
        const students = scanned.students.map((st) => {
          const matched = matchUser(st.folder, store.users);
          return {
            folder: st.folder,
            matched: matched ? { uid: matched.id, username: matched.username, fullname: matched.fullname || '' } : null,
            candidates: userCandidates(st.folder, store.users).map((u) => ({ uid: u.id, username: u.username, fullname: u.fullname || '' })),
            problems: st.problems.map((pr) => {
              const mp2 = matchProblem(pr.folder, examProblems);
              return {
                folder: pr.folder, file: pr.file, std: pr.std, size: pr.size, head: pr.head,
                matchedPid: mp2 ? mp2.id : null,
                candidates: problemCandidates(pr.folder, examProblems).map((p) => ({ id: p.id, title: p.title })),
              };
            }),
          };
        });
        const token = crypto.randomBytes(16).toString('hex');
        offlineTmp.set(token, { dir: tmpd, at: Date.now() });
        return sendJson(res, 200, {
          token, exam: { id: exam.id, name: exam.name },
          examProblems, allStudents, students, warnings: scanned.warnings,
          unmatchedStudents: students.filter((s) => !s.matched).length,
          unmatchedProblems: students.reduce((a, s) => a + s.problems.filter((p) => !p.matchedPid).length, 0),
        });
      } catch (e) {
        try { fs.rmSync(tmpd, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
        return sendJson(res, 400, { error: '压缩包解析失败: ' + e.message });
      }
    });
// 第二步：确认匹配后导入评测（学生按考试期计分；相同代码重复导入自动跳过）
route('POST', '/api/admin/exam/import-zip/apply', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req, 8 * 1024 * 1024);
      const exam = store.exams.find((e) => e.id === parseInt(body.examId, 10));
      if (!exam) return sendJson(res, 404, { error: '模考不存在' });
      const tmp = offlineTmp.get(String(body.token || ''));
      if (!tmp) return sendJson(res, 400, { error: '导入会话已过期，请重新上传压缩包' });
      const rootBuf = Buffer.from(tmp.dir);
      const items = Array.isArray(body.students) ? body.students : [];
      if (!items.length) return sendJson(res, 400, { error: '没有可导入的条目' });
      const createUsers = !!body.createUsers;
      const defaultPassword = String(body.defaultPassword || '');
      const createdUsers = [];
      const errors = [];
      let created = 0, skipped = 0;
      const t0 = exam.endAt || Date.now();
      for (const st of items) {
        let uid = parseInt(st.uid, 10) || 0;
        const folder = String(st.folder || '').trim();
        if (!uid && createUsers) {
          // 自动为未匹配编号创建学生账号（默认密码，激活状态）；同名账号且姓名/学号一致时直接复用（重复导入幂等）
          const uname = sanitizeUsername(folder);
          if (!uname) { errors.push('编号「' + folder + '」无法生成合法用户名，请手动选择账号'); continue; }
          const existing = store.users.find((u) => u.username === uname);
          if (existing) {
            if (String(existing.fullname || '').trim() === folder.trim() || String(existing.studentId || '').trim() === folder.trim()) {
              uid = existing.id; // 复用此前自动创建的账号
            } else { errors.push('账号 ' + uname + ' 已存在，请为编号「' + folder + '」手动选择'); continue; }
          } else {
            if (defaultPassword.length < 7) { errors.push('创建账号「' + folder + '」需要默认密码（至少 7 位）'); continue; }
            const salt = crypto.randomBytes(8).toString('hex');
            const nu = { id: store.users.length ? Math.max(...store.users.map((x) => x.id)) + 1 : 1, username: uname, fullname: folder, role: 'user', status: 'active', salt, passwordHash: store.hashPw(defaultPassword, salt), createdAt: Date.now(), approvedAt: Date.now() };
            store.users.push(nu);
            uid = nu.id;
            createdUsers.push(uname + '（' + folder + '）');
          }
        }
        if (!uid) { errors.push('编号「' + folder + '」未匹配账号（可勾选自动创建或手动选择）'); continue; }
        const u = store.users.find((x) => x.id === uid);
        if (!u) { errors.push('账号 ' + uid + ' 不存在'); continue; }
        for (const pr of (Array.isArray(st.problems) ? st.problems : [])) {
          const pid = parseInt(pr.pid, 10) || 0;
          if (!pid) { errors.push(folder + ' 有题目未选择匹配'); continue; }
          if ((exam.problemIds || []).indexOf(pid) === -1) { errors.push(folder + ' 的题目 ' + pid + ' 不在该模考中'); continue; }
          const rel = String(pr.file || '');
          // 路径校验：仅允许相对路径、不含 .. 组件
          const comps = rel.split('/');
          if (!rel || rel.startsWith('/') || comps.some((c) => !c || c === '.' || c === '..')) { errors.push(folder + ' 的代码文件路径非法'); continue; }
          const full = Buffer.concat([rootBuf, Buffer.from('/'), Buffer.from(rel, 'latin1')]);
          let code;
          try { code = fs.readFileSync(full, 'utf8'); } catch (e) { errors.push(folder + ' 的代码读取失败'); continue; }
          if (!code || code.length > 100000) { errors.push(folder + ' 的代码为空或超过 100000 字符'); continue; }
          // 去重：同一学生同一题的考试期提交中已有完全相同代码 → 跳过（重复导入幂等）
          let dup = false;
          for (const s of store.submissions) {
            if (s.examId !== exam.id || s.uid !== uid || s.problemId !== pid || s.phase !== 'exam' || !s.codeFile) continue;
            try { if (fs.readFileSync(path.join(store.SUB_DIR, s.codeFile), 'utf8') === code) { dup = true; break; } } catch (e) { /* ignore */ }
          }
          if (dup) { skipped++; continue; }
          const std = STD_LIST.indexOf(String(pr.std || '')) !== -1 ? String(pr.std) : 'c++17';
          const id = (store.submissions.length ? Math.max(...store.submissions.map((s) => s.id)) : 0) + 1;
          const codeFile = id + (std === 'python3' ? '.py' : (std === 'c11' ? '.c' : '.cpp'));
          fs.writeFileSync(path.join(store.SUB_DIR, codeFile), code);
          store.submissions.push({
            id, uid, problemId: pid, name: u.fullname || u.username, username: u.username, std, ip: 'offline',
            codeFile, submittedAt: parseInt(st.submittedAt, 10) || t0, status: 'queued', summary: null, points: [],
            examId: exam.id, phase: 'exam', imported: true, offline: true,
          });
          enqueue(store.submissions[store.submissions.length - 1]);
          created++;
        }
      }
      if (createdUsers.length) store.saveUsers();
      store.saveIndex();
      return sendJson(res, 200, { ok: true, created, skipped, errors: errors.slice(0, 80), errorsMore: errors.length > 80 ? errors.length - 80 : 0, createdUsers });
    });
// 作业期次上下文：0=当前期，≥1=历史期（与 /api/rank 的 ?session= 语义一致）
function hwSessionContext(sel) {
  if (sel > 0) {
    const s = (store.hwData.sessions || [])[sel - 1];
    if (!s) return null;
    return { name: s.name || ('第 ' + sel + ' 期'), order: s.order || [] };
  }
  return { name: store.hwData.currentSessionName || '当前期', order: store.hwData.programmingOrder || [] };
}
// ---- 代码求助（help request）----
function helpRequestView(r, withCode) {
  const sub = store.submissions.find((s) => s.id === r.submissionId);
  const p = sub ? store.getProblem(sub.problemId) : (r.problemId != null ? store.getProblem(r.problemId) : null);
  const out = {
    id: r.id, submissionId: r.submissionId,
    uid: r.uid || null, username: r.username || '', fullname: r.fullname || '',
    problemId: sub ? sub.problemId : (r.problemId || null),
    problemTitle: (p && p.title) || r.problemTitle || '',
    std: sub ? sub.std : (r.std || ''),
    note: r.note || '', status: r.status || 'open',
    createdAt: r.createdAt || 0, resolvedAt: r.resolvedAt || null, resolvedBy: r.resolvedBy || null,
    submittedAt: sub ? sub.submittedAt : 0,
  };
  if (withCode && sub && sub.codeFile) {
    try { out.code = fs.readFileSync(path.join(store.SUB_DIR, sub.codeFile), 'utf8'); }
    catch (e) { out.code = ''; }
  }
  return out;
}
// 当前期次内提交（在线提交的题目属于当前 programmingOrder，且非模考/非隐藏题）
function isCurrentPeriodSubmission(sub) {
  if (!sub || sub.hidden || sub.examId) return false;
  const p = store.getProblem(sub.problemId);
  if (!p || p.hidden) return false;
  return (store.hwData.programmingOrder || []).indexOf(sub.problemId) !== -1;
}
// ---- 作业期次离线代码包导入（zip/tar.gz：编号/题目名/题目名.cpp）----
// 第一步：上传解析 → 返回 token + 预览（编号→账号、题目名→该期次编程题 自动匹配）
route('POST', '/api/admin/homework/import-zip', async (req, res, pathname) => {
      const me = authUser(req); // M-1：鉴权前置
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const mp = await readMultipart(req, 512 * 1024 * 1024);
      if (!mp) return sendJson(res, 400, { error: '需要 multipart/form-data 上传' });
      const sel = parseInt(mp.field('session'), 10) || 0;
      const ctx = hwSessionContext(sel);
      if (!ctx) return sendJson(res, 404, { error: '期次不存在' });
      if (!ctx.order.length) return sendJson(res, 400, { error: '该期次没有编程题：先在「作业」页配置编程作业顺序（题目列表里按星标加入作业）' });
      const file = mp.parts.find((p) => p.filename && p.filename !== '');
      if (!file) return sendJson(res, 400, { error: '请选择压缩包' });
      const fname = String(file.filename).toLowerCase();
      const kind = fname.endsWith('.zip') ? 'zip' : ((fname.endsWith('.tar.gz') || fname.endsWith('.tgz')) ? 'tar' : null);
      if (!kind) return sendJson(res, 400, { error: '仅支持 .zip 或 .tar.gz 压缩包' });
      const tmpd = fs.mkdtempSync(path.join(os.tmpdir(), 'tgboj-offline-'));
      try {
        const root = extractArchive(file.body, kind, tmpd);
        const scanned = scanStudents(root);
        if (!scanned.students.length) return sendJson(res, 400, { error: '未识别到「编号/题目名/*.cpp」结构，请检查压缩包（需先有编号目录，内含题目名目录与代码文件）' });
        const sesProblems = ctx.order.map((pid) => { const p = store.getProblem(pid); return p ? { id: p.id, title: p.title } : null; }).filter(Boolean);
        if (!sesProblems.length) return sendJson(res, 400, { error: '该期次的编程题均已不存在，请先配置期次编程题' });
        const allStudents = store.users.filter((u) => u.status === 'active' && u.role === 'user')
          .map((u) => ({ uid: u.id, username: u.username, fullname: u.fullname || '', studentId: u.studentId || '' }))
          .sort((a, b) => String(a.studentId || a.username).localeCompare(String(b.studentId || b.username), 'zh-CN'));
        const students = scanned.students.map((st) => {
          const matched = matchUser(st.folder, store.users);
          return {
            folder: st.folder,
            matched: matched ? { uid: matched.id, username: matched.username, fullname: matched.fullname || '' } : null,
            candidates: userCandidates(st.folder, store.users).map((u) => ({ uid: u.id, username: u.username, fullname: u.fullname || '' })),
            problems: st.problems.map((pr) => {
              const mp2 = matchProblem(pr.folder, sesProblems);
              return {
                folder: pr.folder, file: pr.file, std: pr.std, size: pr.size, head: pr.head,
                matchedPid: mp2 ? mp2.id : null,
                candidates: problemCandidates(pr.folder, sesProblems).map((p) => ({ id: p.id, title: p.title })),
              };
            }),
          };
        });
        const token = crypto.randomBytes(16).toString('hex');
        offlineTmp.set(token, { dir: tmpd, at: Date.now() });
        return sendJson(res, 200, {
          token, session: sel, sessionName: ctx.name,
          sesProblems, allStudents, students, warnings: scanned.warnings,
          unmatchedStudents: students.filter((s) => !s.matched).length,
          unmatchedProblems: students.reduce((a, s) => a + s.problems.filter((p) => !p.matchedPid).length, 0),
        });
      } catch (e) {
        try { fs.rmSync(tmpd, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
        return sendJson(res, 400, { error: '压缩包解析失败: ' + e.message });
      }
    });
// 第二步：确认匹配后导入评测（成绩计入该期次排行榜；同一期次相同代码重复导入自动跳过）
route('POST', '/api/admin/homework/import-zip/apply', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req, 8 * 1024 * 1024);
      const sel = parseInt(body.session, 10) || 0;
      const ctx = hwSessionContext(sel);
      if (!ctx) return sendJson(res, 404, { error: '期次不存在' });
      const tmp = offlineTmp.get(String(body.token || ''));
      if (!tmp) return sendJson(res, 400, { error: '导入会话已过期，请重新上传压缩包' });
      const rootBuf = Buffer.from(tmp.dir);
      const items = Array.isArray(body.students) ? body.students : [];
      if (!items.length) return sendJson(res, 400, { error: '没有可导入的条目' });
      const createUsers = !!body.createUsers;
      const defaultPassword = String(body.defaultPassword || '');
      const createdUsers = [];
      const errors = [];
      let created = 0, skipped = 0;
      for (const st of items) {
        let uid = parseInt(st.uid, 10) || 0;
        const folder = String(st.folder || '').trim();
        if (!uid && createUsers) {
          // 自动为未匹配编号创建学生账号（默认密码，激活状态；编号写入 studentId 便于下次直接匹配）
          const uname = sanitizeUsername(folder);
          if (!uname) { errors.push('编号「' + folder + '」无法生成合法用户名，请手动选择账号'); continue; }
          const existing = store.users.find((u) => u.username === uname);
          if (existing) {
            if (String(existing.fullname || '').trim() === folder.trim() || String(existing.studentId || '').trim() === folder.trim()) {
              uid = existing.id; // 复用此前自动创建的账号（重复导入幂等）
            } else { errors.push('账号 ' + uname + ' 已存在，请为编号「' + folder + '」手动选择'); continue; }
          } else {
            if (defaultPassword.length < 7) { errors.push('创建账号「' + folder + '」需要默认密码（至少 7 位）'); continue; }
            const salt = crypto.randomBytes(8).toString('hex');
            const nu = { id: store.users.length ? Math.max(...store.users.map((x) => x.id)) + 1 : 1, username: uname, fullname: folder, studentId: folder, role: 'user', status: 'active', salt, passwordHash: store.hashPw(defaultPassword, salt), createdAt: Date.now(), approvedAt: Date.now() };
            store.users.push(nu);
            uid = nu.id;
            createdUsers.push(uname + '（' + folder + '）');
          }
        }
        if (!uid) { errors.push('编号「' + folder + '」未匹配账号（可勾选自动创建或手动选择）'); continue; }
        const u = store.users.find((x) => x.id === uid);
        if (!u) { errors.push('账号 ' + uid + ' 不存在'); continue; }
        for (const pr of (Array.isArray(st.problems) ? st.problems : [])) {
          const pid = parseInt(pr.pid, 10) || 0;
          if (!pid) { errors.push(folder + ' 有题目未选择匹配'); continue; }
          if (ctx.order.indexOf(pid) === -1) { errors.push(folder + ' 的题目 ' + pid + ' 不在该期次中'); continue; }
          const rel = String(pr.file || '');
          // 路径校验：仅允许相对路径、不含 .. 组件
          const comps = rel.split('/');
          if (!rel || rel.startsWith('/') || comps.some((c) => !c || c === '.' || c === '..')) { errors.push(folder + ' 的代码文件路径非法'); continue; }
          const full = Buffer.concat([rootBuf, Buffer.from('/'), Buffer.from(rel, 'latin1')]);
          let code;
          try { code = fs.readFileSync(full, 'utf8'); } catch (e) { errors.push(folder + ' 的代码读取失败'); continue; }
          if (!code || code.length > 100000) { errors.push(folder + ' 的代码为空或超过 100000 字符'); continue; }
          // 去重：同一学生同一题在同一期次已导入完全相同代码 → 跳过（重复导入幂等）
          let dup = false;
          for (const s of store.submissions) {
            if (s.hwSession !== sel || s.uid !== uid || s.problemId !== pid || !s.codeFile) continue;
            try { if (fs.readFileSync(path.join(store.SUB_DIR, s.codeFile), 'utf8') === code) { dup = true; break; } } catch (e) { /* ignore */ }
          }
          if (dup) { skipped++; continue; }
          const std = STD_LIST.indexOf(String(pr.std || '')) !== -1 ? String(pr.std) : 'c++17';
          const id = (store.submissions.length ? Math.max(...store.submissions.map((s) => s.id)) : 0) + 1;
          const codeFile = id + (std === 'python3' ? '.py' : (std === 'c11' ? '.c' : '.cpp'));
          fs.writeFileSync(path.join(store.SUB_DIR, codeFile), code);
          store.submissions.push({
            id, uid, problemId: pid, name: u.fullname || u.username, username: u.username, std, ip: 'offline',
            codeFile, submittedAt: Date.now(), status: 'queued', summary: null, points: [],
            imported: true, offline: true, hwSession: sel,
          });
          enqueue(store.submissions[store.submissions.length - 1]);
          created++;
        }
      }
      if (createdUsers.length) store.saveUsers();
      store.saveIndex();
      return sendJson(res, 200, { ok: true, created, skipped, errors: errors.slice(0, 80), errorsMore: errors.length > 80 ? errors.length - 80 : 0, createdUsers });
    });
route('POST', '/api/submit', async (req, res, pathname) => {
      const body = await readJson(req);
      const me = authUser(req);
      if (!me) return sendUnauthorized(res);
      const std = String(body.std || '');
      const code = String(body.code || '');
      const problemId = parseInt(body.problemId, 10);
      if (!problemId) return sendJson(res, 400, { error: '题目参数无效，请刷新页面后重试' }); // 拒绝静默回退，防止误提交
      const stdLc = std.toLowerCase();
      if (STD_LIST.indexOf(stdLc) === -1) return sendJson(res, 400, { error: '请选择语言 (c11 / c++14 / c++17 / c++20 / gnu++14 / gnu++17 / gnu++20 / python3)' });
      if (!code || code.length > 100000) return sendJson(res, 400, { error: '代码不能为空或超过 100000 字符' });
      if (queue.length >= 300) return sendJson(res, 429, { error: '评测队列繁忙，请稍后再试' }); // L-9：队列上限防内存/磁盘打爆
      const now = Date.now();
      // AI 高风险封禁：被自动检测判 high 的用户 1 分钟内禁止提交
      const bannedUntil = submitBan.get(me.id) || 0;
      if (bannedUntil > now) {
        return sendJson(res, 429, { error: '请 ' + Math.ceil((bannedUntil - now) / 1000) + ' 秒后再试' });
      } else if (bannedUntil) submitBan.delete(me.id);
      const prob = store.getProblem(problemId);
      // 隐藏的模考题：所属模考进行中或已公布成绩后对学生可见（考试/订正需要打开题目页并提交）
      if (!prob || (prob.hidden && !isAdminUser(me) && !examAccessForProblem(problemId, now))) return sendJson(res, 400, { error: '题目不存在' });
      if (!prob.judgeable) return sendJson(res, 400, { error: '该题仅提供题面，未开放提交' });
      // 模考归属：提交自动归入考试（进行中的考试 → 考试提交计分；已结束的最近一场 → 订正提交，不影响考试成绩）
      // （examsEnabled=false 时整体跳过：不归入任何模考，也不受模考时间窗限制）
      let exam = null, phase = null;
      const examsOn = store.CONFIG.examsEnabled !== false;
      if (examsOn) {
        const wantExamId = parseInt(body.examId, 10) || 0;
        if (wantExamId) {
          exam = store.exams.find((e) => e.id === wantExamId);
          if (!exam) return sendJson(res, 400, { error: '模考不存在' });
          if ((exam.problemIds || []).indexOf(problemId) === -1) return sendJson(res, 400, { error: '该题不属于所选模考' });
        } else if (!isAdminUser(me)) {
          const cands = store.exams.filter((e) => (e.problemIds || []).indexOf(problemId) !== -1);
          exam = cands.find((e) => e.startAt <= now && now <= e.endAt)  // 进行中的考试优先
            || cands.filter((e) => e.endAt <= now).sort((a, b) => b.endAt - a.endAt)[0]; // 否则最近一场已结束的考试（订正）
        }
        if (exam) {
          if (!isAdminUser(me) && now < exam.startAt) return sendJson(res, 403, { error: '模考「' + exam.name + '」尚未开始（' + new Date(exam.startAt).toLocaleString('zh-CN', { hour12: false }) + '）' });
          phase = now <= exam.endAt ? 'exam' : 'correction';
        }
      }
      // 比赛时间锁：赛前仍锁定；赛后仅当前作业编程题开放补题。
      // 补题提交时间晚于 endAt，因此不会进入 /api/contest/rank 的固定比赛窗口，比赛榜保持结束时成绩不动。
      const c = store.contest;
      let contestCorrection = false;
      if (c && c.startAt && !isAdminUser(me) && !exam) {
        if (now < c.startAt) return sendJson(res, 403, { error: '比赛尚未开始' });
        if (c.endAt && now > c.endAt) {
          const correctionOpen = (store.hwData.programmingOrder || []).indexOf(problemId) !== -1;
          if (!correctionOpen) return sendJson(res, 403, { error: '比赛已结束；该题未加入当前作业，暂不开放补题' });
          contestCorrection = true;
        }
      }
      const id = (store.submissions.length ? Math.max(...store.submissions.map((s) => s.id)) : 0) + 1;
      const codeFile = id + (stdLc === 'python3' ? '.py' : (stdLc === 'c11' ? '.c' : '.cpp'));
      fs.writeFileSync(path.join(store.SUB_DIR, codeFile), code);
      const sub = { id, uid: me.id, problemId, name: me.fullname, username: me.username, std: stdLc, ip: reqIp(req), codeFile, submittedAt: now, status: 'queued', summary: null, points: [], examId: exam ? exam.id : null, phase: phase || (contestCorrection ? 'correction' : null) };
      if (contestCorrection) { sub.contestCorrection = true; sub.hwSession = 0; }
      store.submissions.push(sub);
      store.saveIndex();
      // AI 自动检测 + 自动拦截（仅学生提交；管理员提交与离线导入不自动检测）：
      // autoBlock 开 = 评测前检测，危险代码根本不会被执行；autoBlock 关 = 评测后异步检测（judgeOne 内），零延迟
      const aiCfg = store.CONFIG.aiReview || {};
      if (aiReviewEnabled(store.CONFIG) && aiCfg.autoCheck && aiCfg.autoBlock && !isAdminUser(me)) {
        sub.aiPending = true; // 瞬态标记（不落盘）：列表显示「等待中/安全检测中」
        // 硬性兜底定时器：AI 网关挂死/超时未生效时（曾致 #2249 卡在检测中）也必走 finalize 放行
        const hardMs = (Math.max(5, Math.min(120, Number(aiCfg.timeoutSec) || 45)) + 15) * 1000;
        let aiSettled = false;
        let hardTimer = null;
        const finalize = (r) => {
          if (aiSettled) return;
          aiSettled = true;
          if (hardTimer) clearTimeout(hardTimer);
          if (!r || !r.ok) {
            // fail-open：AI 服务异常不影响评测（判题降权沙箱是真实防线，AI 是增强层）
            store.appendLog(null, 'interact', '/api/ai-auto', '提交 #' + id + ' AI 检测失败（' + ((r && r.error) || '硬性超时') + '），放行评测');
          } else {
            sub.aiReview = { risk: r.risk, categories: r.categories, summary: r.summary, model: r.model, at: Date.now() };
            if (riskLevel(r.risk) >= blockThreshold(store.CONFIG)) {
              delete sub.aiPending;
              sub.aiBlocked = true;
              sub.hidden = true; // 复用隐藏机制：他人不可见；本人列表中显示「已拦截」
              sub.status = 'done';
              sub.finishedAt = Date.now();
              // 高风险：额外禁止该用户提交 1 分钟
              if (r.risk === 'high') {
                submitBan.set(me.id, Date.now() + 60 * 1000);
                store.appendLog(null, 'interact', '/api/ai-auto', '用户 ' + sub.username + ' 提交高风险代码，暂停提交 1 分钟');
              }
              store.saveIndex();
              store.appendLog(null, 'interact', '/api/ai-auto', '提交 #' + id + '（' + sub.username + '）被 AI 拦截：' + r.risk + ' ' + (r.categories || []).join('/'));
              return;
            }
          }
          delete sub.aiPending;
          enqueue(sub);
        };
        hardTimer = setTimeout(() => finalize(null), hardMs);
        aiReviewCode(code, stdLc, aiCfg).then(finalize).catch((e) => finalize({ ok: false, error: String(e && e.message || e) }));
        return sendJson(res, 200, { id, examId: sub.examId, phase: sub.phase });
      }
      enqueue(sub);
      return sendJson(res, 200, { id, examId: sub.examId, phase: sub.phase });
    });
route('POST', '/api/admin/problem', async (req, res, pathname) => {
      const me = authUser(req); // M-1：鉴权前置，避免未授权大请求体先读入内存
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const mp = await readMultipart(req, 300 * 1024 * 1024);
      if (!mp) return sendJson(res, 400, { error: '需要 multipart/form-data 上传' });
      const parts = mp.parts;
      const field = mp.field;
      const title = field('title');
      const desc = field('description');
      const targetId = parseInt(field('problemId'), 10);
      if (!title && !targetId) return sendJson(res, 400, { error: '请填写题目名称' });
      if (!desc && !targetId) return sendJson(res, 400, { error: '请填写题目描述' });
      const files = parts.filter((p) => p.filename && p.filename !== '');
      const ins = {}, outs = {};
      let sampleIn = null, sampleOut = null;
      for (const f of files) {
        const m = /^(.*)\.(in|out)$/i.exec(f.filename);
        if (!m) continue;
        if (/^sample$/i.test(m[1])) {
          if (m[2].toLowerCase() === 'in') sampleIn = f.body;
          else sampleOut = f.body;
          continue;
        }
        if (m[2].toLowerCase() === 'in') ins[m[1]] = f.body;
        else outs[m[1]] = f.body;
      }
      const bases = Object.keys(ins).filter((b) => outs[b]).sort(store.cmpName);
      if (targetId) {
        // 为现有题目更新数据（替换测试数据；可同时更新描述/题解）
        const prob = store.getProblem(targetId);
        if (!prob) return sendJson(res, 404, { error: '题目不存在' });
        const pdir = path.join(store.PROBLEMS_DIR, String(targetId));
        // M-16：仅在确实上传了新数据文件时才替换 data 目录（未上传时保留原数据，防误清空）
        if (bases.length) {
          fs.rmSync(path.join(pdir, 'data'), { recursive: true, force: true });
          fs.mkdirSync(path.join(pdir, 'data'), { recursive: true });
        }
        for (const b of bases) {
          fs.writeFileSync(path.join(pdir, 'data', b + '.in'), ins[b]);
          fs.writeFileSync(path.join(pdir, 'data', b + '.out'), outs[b]);
        }
        if (sampleIn) fs.writeFileSync(path.join(pdir, 'sample.in'), sampleIn);
        if (sampleOut) fs.writeFileSync(path.join(pdir, 'sample.out'), sampleOut);
        if (desc) fs.writeFileSync(path.join(pdir, 'description.md'), desc);
        if (field('solution')) fs.writeFileSync(path.join(pdir, 'solution.md'), field('solution'));
        store.loadProblems();
        const reloaded = store.getProblem(targetId);
        return sendJson(res, 200, { id: targetId, title: prob.title, testCount: reloaded ? reloaded.tests.length : 0, updated: true });
      }
      // 允许无测试数据：仅题面题目（评测不可用）
      const ids = store.PROBLEMS.map((p) => p.id);
      const nextId = Math.max(store.FIRST_PROBLEM_ID - 1, ...ids) + 1; // 从 2026 起递增
      const pdir = path.join(store.PROBLEMS_DIR, String(nextId));
      fs.mkdirSync(path.join(pdir, 'data'), { recursive: true });
      fs.writeFileSync(path.join(pdir, 'problem.json'), JSON.stringify({
        id: nextId, title, timeLimitSec: store.CONFIG.timeLimitSec, memLimitKb: store.CONFIG.memLimitKb,
        // 新题默认隐藏（上线后才对学生可见）；显式传 hidden=0/false 可立即开放
        hidden: field('hidden') !== '0' && field('hidden') !== 'false',
        owner: me.username || '',
      }, null, 2));
      fs.writeFileSync(path.join(pdir, 'description.md'), desc);
      if (field('solution')) fs.writeFileSync(path.join(pdir, 'solution.md'), field('solution'));
      for (const b of bases) {
        fs.writeFileSync(path.join(pdir, 'data', b + '.in'), ins[b]);
        fs.writeFileSync(path.join(pdir, 'data', b + '.out'), outs[b]);
      }
      if (sampleIn) fs.writeFileSync(path.join(pdir, 'sample.in'), sampleIn);
      if (sampleOut) fs.writeFileSync(path.join(pdir, 'sample.out'), sampleOut);
      store.loadProblems();
      return sendJson(res, 200, { id: nextId, title, testCount: bases.length });
    });
route('POST', '/api/admin/rejudge', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const ids = Array.isArray(body.ids) ? body.ids.map((x) => parseInt(x, 10)).filter((x) => !isNaN(x)) : [];
      if (!ids.length) return sendJson(res, 400, { error: '请提供要重评的提交 id' });
      let enqueued = 0, skipped = 0;
      for (const id of ids) {
        const sub = store.submissions.find((x) => x.id === id);
        if (!sub) continue;
        if (!store.getProblem(sub.problemId)) continue;
        if (runningSubs.has(sub.id) || queue.indexOf(sub) !== -1) { skipped++; continue; } // M-6：评测中/已排队跳过，防同一提交并发评测
        sub.status = 'queued';
        sub.summary = null;
        sub.score = null;
        sub.subtaskResults = [];
        sub.points = [];
        sub.exPoints = [];
        sub.sampleResults = [];
        sub.finishedAt = null;
        enqueue(sub);
        enqueued++;
      }
      return sendJson(res, 200, { ok: true, enqueued, skipped });
    });
route('POST', '/api/admin/rejudge-code', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req, 4 * 1024 * 1024);
      const origId = parseInt(body.id, 10);
      const code = String(body.code || '');
      const orig = store.submissions.find((x) => x.id === origId);
      if (!orig) return sendJson(res, 404, { error: '提交不存在' });
      const prob = store.getProblem(orig.problemId);
      if (!prob) return sendJson(res, 400, { error: '题目不存在' });
      if (!code || code.length > 100000) return sendJson(res, 400, { error: '代码不能为空或超过 100000 字符' });
      const stdLc = String(orig.std || 'c++17');
      // 新建一条提交（管理员身份），原提交保持不变
      const id = (store.submissions.length ? Math.max(...store.submissions.map((s) => s.id)) : 0) + 1;
      const codeFile = id + (stdLc === 'python3' ? '.py' : (stdLc === 'c11' ? '.c' : '.cpp'));
      fs.writeFileSync(path.join(store.SUB_DIR, codeFile), code);
      // F-8：改码重测的归属 = 实际操作者本人（而非统一记到超管名下），保持提交/审计链可追溯
      const uid = me.id;
      const uname = me.username;
      const unameFull = me.fullname || me.username;
      const sub = { id, uid, problemId: orig.problemId, name: unameFull, username: uname, std: stdLc, ip: reqIp(req), codeFile, submittedAt: Date.now(), status: 'queued', summary: null, points: [] };
      store.submissions.push(sub);
      store.saveIndex();
      enqueue(sub);
      return sendJson(res, 200, { ok: true, id });
    });
route('POST', '/api/admin/hide', async (req, res, pathname) => {
      const body = await readJson(req);
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const id = parseInt(body.id, 10);
      const sub = store.submissions.find((s) => s.id === id);
      if (!sub) return sendJson(res, 404, { error: '提交不存在' });
      sub.hidden = !!body.hidden;
      store.saveIndex();
      return sendJson(res, 200, { id, hidden: sub.hidden });
    });
route('POST', '/api/admin/problem/package', async (req, res, pathname) => {
      const me = authUser(req); // M-1：鉴权前置
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const mp = await readMultipart(req, 300 * 1024 * 1024);
      if (!mp) return sendJson(res, 400, { error: '需要 multipart/form-data 上传' });
      const parts = mp.parts;
      const field = mp.field;
      const file = parts.find((p) => p.filename && p.filename !== '');
      if (!file) return sendJson(res, 400, { error: '请选择题目压缩包' });
      const origName = file.filename;
      const isZip = /\.zip$/i.test(origName);
      const isTar = /\.(tar\.gz|tgz)$/i.test(origName);
      if (!isZip && !isTar) return sendJson(res, 400, { error: '仅支持 .zip 或 .tar.gz 压缩包' });
      const tmpd = fs.mkdtempSync(path.join(os.tmpdir(), 'tgboj-pkg-'));
      try {
        const pkgFile = path.join(tmpd, 'pkg' + (isZip ? '.zip' : '.tar.gz'));
        fs.writeFileSync(pkgFile, file.body);
        checkArchiveEntries(pkgFile, isZip ? 'zip' : 'tar', 2 * 1024 * 1024 * 1024); // M-4：解压前拒绝非法路径与超量（2GB）
        if (isZip) execFileSync('unzip', ['-q', '-o', pkgFile, '-d', tmpd], { stdio: 'pipe' });
        else execFileSync('tar', ['-xzf', pkgFile, '-C', tmpd], { stdio: 'pipe' });
        assertNoSymlinks(tmpd); // D：拒绝符号链接条目（防 symlink 写穿到解压根外）
        // 定位解压根（若仅一个顶层目录则进入）
        const entries = fs.readdirSync(tmpd).filter((f) => !f.startsWith('pkg.'));
        let root = tmpd;
        if (entries.length === 1 && fs.statSync(path.join(tmpd, entries[0])).isDirectory()) root = path.join(tmpd, entries[0]);
        // 校验：不得越出解压根（防 ../ 穿越）
        const clean = (p) => path.normalize(p).startsWith(path.normalize(root));
        const scan = (d) => {
          for (const f of fs.readdirSync(d)) {
            const full = path.join(d, f);
            const st = fs.statSync(full);
            if (st.isDirectory()) scan(full);
            else if (!clean(full)) throw new Error('压缩包内含非法路径');
          }
        };
        scan(root);
        const descFile = path.join(root, 'description.md');
        if (!fs.existsSync(descFile)) return sendJson(res, 400, { error: '压缩包内缺少 description.md（题目描述）' });
        const desc = fs.readFileSync(descFile, 'utf8');
        // 元数据（problem.json 可选）
        let title = origName.replace(/\.(zip|tar\.gz|tgz)$/i, '').replace(/[\\/]/g, '_').slice(0, 60);
        let timeLimitSec = store.CONFIG.timeLimitSec, memLimitKb = store.CONFIG.memLimitKb;
        let tags = [];
        const metaFile = path.join(root, 'problem.json');
        if (fs.existsSync(metaFile)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
            if (meta.title) title = String(meta.title).trim().slice(0, 60);
            timeLimitSec = store.clampSec(meta.timeLimitSec);
            memLimitKb = store.clampMem(meta.memLimitKb);
            if (Array.isArray(meta.tags)) tags = meta.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
          } catch (e) { /* 忽略坏 json */ }
        }
        // 测试数据（data/ 下同名 .in/.out 成对）
        const dataDir = path.join(root, 'data');
        const ins = {}, outs = {};
        if (fs.existsSync(dataDir)) {
          for (const f of fs.readdirSync(dataDir)) {
            const m = /^(.*)\.(in|out)$/i.exec(f);
            if (!m) continue;
            if (m[2].toLowerCase() === 'in') ins[m[1]] = path.join(dataDir, f);
            else outs[m[1]] = path.join(dataDir, f);
          }
        }
        const bases = Object.keys(ins).filter((b) => outs[b]).sort(store.cmpName);
        // 创建题目
        const ids = store.PROBLEMS.map((p) => p.id);
        const nextId = Math.max(store.FIRST_PROBLEM_ID - 1, ...ids) + 1;
        const pdir = path.join(store.PROBLEMS_DIR, String(nextId));
        fs.mkdirSync(path.join(pdir, 'data'), { recursive: true });
        const pjMeta = { id: nextId, title, timeLimitSec, memLimitKb, hidden: true };
        if (tags.length) pjMeta.tags = tags;
        fs.writeFileSync(path.join(pdir, 'problem.json'), JSON.stringify(pjMeta, null, 2));
        fs.writeFileSync(path.join(pdir, 'description.md'), desc);
        for (const [src, dst] of [[path.join(root, 'sample.in'), 'sample.in'], [path.join(root, 'sample.out'), 'sample.out'], [path.join(root, 'solution.md'), 'solution.md']]) {
          if (fs.existsSync(src)) fs.copyFileSync(src, path.join(pdir, dst));
        }
        for (const b of bases) {
          fs.copyFileSync(ins[b], path.join(pdir, 'data', b + '.in'));
          fs.copyFileSync(outs[b], path.join(pdir, 'data', b + '.out'));
        }
        store.loadProblems();
        return sendJson(res, 200, { id: nextId, title, testCount: bases.length, judgeable: bases.length > 0 });
      } catch (e) {
        return sendJson(res, 400, { error: '压缩包处理失败: ' + e.message });
      } finally {
        try { fs.rmSync(tmpd, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      }
    });
route('POST', '/api/admin/problem/rank', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const problem = store.getProblem(parseInt(body.problemId, 10));
      if (!problem) return sendJson(res, 404, { error: '题目不存在' });
      const pj = path.join(path.dirname(problem.descriptionFile), 'problem.json');
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch (e) { /* ignore */ }
      meta.rankEnabled = !!body.rankEnabled;
      fs.writeFileSync(pj, JSON.stringify(meta, null, 2));
      store.reloadProblem(problem.id);
      return sendJson(res, 200, { ok: true, rankEnabled: !!body.rankEnabled });
    });
route('POST', '/api/admin/problem/hide', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const problem = store.getProblem(parseInt(body.problemId, 10));
      if (!problem) return sendJson(res, 404, { error: '题目不存在' });
      const pj = path.join(path.dirname(problem.descriptionFile), 'problem.json');
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch (e) { /* ignore */ }
      meta.hidden = !!body.hidden;
      fs.writeFileSync(pj, JSON.stringify(meta, null, 2));
      store.reloadProblem(problem.id);
      return sendJson(res, 200, { ok: true, hidden: !!body.hidden });
    });
route('POST', '/api/admin/problem/vis', async (req, res, pathname) => {
      // 做法/题解/参考代码 开放/隐藏 开关（新题默认隐藏；老题无字段默认开放）
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const problem = store.getProblem(parseInt(body.problemId, 10));
      if (!problem) return sendJson(res, 404, { error: '题目不存在' });
      const pj = path.join(path.dirname(problem.descriptionFile), 'problem.json');
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch (e) { /* ignore */ }
      const changed = {};
      for (const f of ['approachOpen', 'solutionOpen', 'referenceOpen']) {
        if (typeof body[f] === 'boolean') { meta[f] = body[f]; changed[f] = body[f]; }
      }
      if (!Object.keys(changed).length) return sendJson(res, 400, { error: '缺少开关字段（approachOpen / solutionOpen / referenceOpen）' });
      fs.writeFileSync(pj, JSON.stringify(meta, null, 2));
      store.reloadProblem(problem.id);
      return sendJson(res, 200, { ok: true, problemId: problem.id, ...changed });
    });
route('POST', '/api/admin/problem/edit', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const problem = store.getProblem(parseInt(body.problemId, 10));
      if (!problem) return sendJson(res, 404, { error: '题目不存在' });
      const pdir = path.join(store.PROBLEMS_DIR, String(problem.id));
      const pj = path.join(pdir, 'problem.json');
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch (e) { /* ignore */ }
      if (typeof body.title === 'string' && body.title.trim()) meta.title = body.title.trim().slice(0, 80);
      if (body.tags !== undefined) {
        const tags = Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(/[,，\s]+/);
        const clean = tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
        if (clean.length) meta.tags = clean; else delete meta.tags;
      }
      if (typeof body.description === 'string' && body.description.trim()) {
        fs.writeFileSync(path.join(pdir, 'description.md'), body.description);
      }
      // P2：时限/内存/传统文件读写（fileIO）此前只能手改 problem.json，现提供正式接口
      if (body.timeLimitSec !== undefined) meta.timeLimitSec = store.clampSec(body.timeLimitSec);
      if (body.memLimitKb !== undefined) meta.memLimitKb = store.clampMem(body.memLimitKb);
      if (body.fileIO !== undefined) {
        if (body.fileIO && typeof body.fileIO === 'object' && body.fileIO.in && body.fileIO.out) {
          const fi = String(body.fileIO.in).trim();
          const fo = String(body.fileIO.out).trim();
          if (!/^[\w.-]{1,64}$/.test(fi) || !/^[\w.-]{1,64}$/.test(fo)) return sendJson(res, 400, { error: 'fileIO 仅允许纯文件名（不含路径分隔符）' });
          meta.fileIO = { in: fi, out: fo };
        } else {
          delete meta.fileIO; // 传 null/空 → 恢复标准输入输出
        }
      }
      fs.writeFileSync(pj, JSON.stringify(meta, null, 2));
      store.reloadProblem(problem.id);
      const p2 = store.getProblem(problem.id);
      return sendJson(res, 200, { ok: true, title: meta.title, timeLimitSec: p2 ? p2.timeLimitSec : meta.timeLimitSec, memLimitKb: p2 ? p2.memLimitKb : meta.memLimitKb, fileIO: p2 ? p2.fileIO : null });
    });
// checker.cpp（SPJ）上传/重编译（P2：此前只能放文件+重启）
route('POST', '/api/admin/problem/checker', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const mp = await readMultipart(req, 2 * 1024 * 1024);
      if (!mp) return sendJson(res, 400, { error: '需要 multipart/form-data 上传' });
      const pid = parseInt(mp.field('problemId'), 10);
      const problem = store.getProblem(pid);
      if (!problem) return sendJson(res, 404, { error: '题目不存在' });
      const pdir = path.join(store.PROBLEMS_DIR, String(pid));
      const cppPath = path.join(pdir, 'checker.cpp');
      const file = mp.parts.find((p) => p.filename && p.filename !== '');
      if (file) {
        if (!/\.cpp$/i.test(file.filename)) return sendJson(res, 400, { error: 'checker 须为 .cpp 文件' });
        fs.writeFileSync(cppPath, file.body);
      } else if (mp.field('clear') === '1') {
        try { fs.rmSync(cppPath, { force: true }); } catch (e) { /* ignore */ }
        try { fs.rmSync(path.join(pdir, 'checker'), { force: true }); } catch (e) { /* ignore */ }
      } else {
        return sendJson(res, 400, { error: '请选择 checker.cpp，或传 clear=1 清除' });
      }
      store.reloadProblem(pid);
      const p3 = store.getProblem(pid);
      return sendJson(res, 200, { ok: true, checker: !!(p3 && p3.checkerBin) });
    });
route('POST', '/api/admin/problem/scoring', async (req, res, pathname) => {
      // 评测评分配置：子任务部分分（OI 模式）。scoring 为 null/{mode:'point'} → 恢复按点均分
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const problem = store.getProblem(parseInt(body.problemId, 10));
      if (!problem) return sendJson(res, 404, { error: '题目不存在' });
      const pdir = path.join(store.PROBLEMS_DIR, String(problem.id));
      const pj = path.join(pdir, 'problem.json');
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch (e) { /* ignore */ }
      const scoring = body.scoring;
      if (!scoring || (scoring.mode === 'point' && !Array.isArray(scoring.subtasks))) {
        delete meta.scoring; // 恢复按点均分
      } else {
        if (scoring.mode !== 'subtask') return sendJson(res, 400, { error: 'scoring.mode 只能是 subtask' });
        const subs = (Array.isArray(scoring.subtasks) ? scoring.subtasks : []).map((s, i) => ({
          id: String((s && s.id) != null ? s.id : i + 1),
          score: parseInt(s && s.score, 10) || 0,
          tests: (Array.isArray(s && s.tests) ? s.tests : []).map(String),
          depends: (Array.isArray(s && s.depends) ? s.depends : []).map(String),
        })).filter((s) => s.score > 0 && s.tests.length);
        if (!subs.length) return sendJson(res, 400, { error: '至少需要一个有效的子任务（score>0 且 tests 非空）' });
        meta.scoring = { mode: 'subtask', subtasks: subs };
      }
      fs.writeFileSync(pj, JSON.stringify(meta, null, 2));
      store.reloadProblem(problem.id);
      const p2 = store.getProblem(problem.id);
      return sendJson(res, 200, { ok: true, scoring: p2 ? p2.scoring : { mode: 'point', subtasks: [] } });
    });
route('POST', '/api/admin/problem/notify', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const pid = parseInt(body.problemId, 10);
      if (!store.getProblem(pid)) return sendJson(res, 404, { error: '题目不存在' });
      const text = String(body.text || '').trim().slice(0, 200);
      if (!text) return sendJson(res, 400, { error: '请填写通知内容' });
      // 目标：problem_views 记录 ∪ 历史日志中打开过该题的用户 ∪ 该题提交者
      const targets = new Set(store.problemViews[String(pid)] || []);
      const pagePat = '/problem.html?id=' + pid;
      for (const l of store.logs) if (l.uid && String(l.page || '').indexOf(pagePat) !== -1) targets.add(l.uid);
      for (const sb of store.submissions) {
        if ((sb.problemId || store.FIRST_PROBLEM_ID) !== pid) continue;
        if (sb.uid) targets.add(sb.uid);
        else if (sb.username) {
          const u = store.users.find((x) => x.username === sb.username);
          if (u) targets.add(u.id);
        }
      }
      // 管理员不接收学生通知
      for (const u of store.users) if (u.role === 'admin' || u.role === 'superadmin') targets.delete(u.id);
      const key = String(pid);
      store.noticesData[key] = { text, createdAt: Date.now(), readBy: [] }; // 新通知覆盖旧通知
      store.saveNotices();
      return sendJson(res, 200, { ok: true, targets: targets.size });
    });
route('POST', '/api/admin/problem/delete', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const pid = parseInt(body.problemId, 10);
      const problem = store.getProblem(pid);
      if (!problem) return sendJson(res, 404, { error: '题目不存在' });
      const isSuper = me.role === 'superadmin';
      const isOwner = me.role === 'admin' && problem.owner && problem.owner === me.username;
      if (!isSuper && !isOwner) return sendForbidden(res, '只能删除自己上传的题目（超管可删除任意题目）');
      // 删除题目目录
      try { fs.rmSync(path.join(store.PROBLEMS_DIR, String(pid)), { recursive: true, force: true }); } catch (e) { /* ignore */ }
      // 清理该题的提交记录与代码文件（L-9：此前只删索引，代码文件残留）
      const before = store.submissions.length;
      const removed = store.submissions.filter((x) => (x.problemId || store.FIRST_PROBLEM_ID) === pid);
      for (const s of removed) {
        if (s.codeFile) { try { fs.unlinkSync(path.join(store.SUB_DIR, s.codeFile)); } catch (e) { /* ignore */ } }
      }
      store.submissions = store.submissions.filter((x) => (x.problemId || store.FIRST_PROBLEM_ID) !== pid);
      store.saveIndex();
      // 从编程作业顺序与星标中移除
      store.hwData.programmingOrder = (store.hwData.programmingOrder || []).filter((x) => x !== pid);
      store.hwData.programmingStars = (store.hwData.programmingStars || []).filter((x) => x !== pid);
      store.saveHw();
      store.reloadProblem(pid);
      return sendJson(res, 200, { ok: true, id: pid, removedSubmissions: before - store.submissions.length });
    });
route('POST', '/api/admin/solution', async (req, res, pathname) => {
      const body = await readJson(req);
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const problem = store.getProblem(parseInt(body.problemId, 10));
      if (!problem) return sendJson(res, 404, { error: '题目不存在' });
      // 旧接口（单份）→ 写入 solution.json 列表（name=题解，兼容多份读取）
      const content = String(body.content || '');
      const arr = content.trim() ? [{ name: '题解', content }] : [];
      fs.writeFileSync(path.join(path.dirname(problem.solutionFile), 'solution.json'), JSON.stringify(arr, null, 2));
      store.reloadProblem(problem.id);
      return sendJson(res, 200, { ok: true, problemId: problem.id, hasSolution: !!content.trim() });
    });
route('POST', '/api/admin/reference', async (req, res, pathname) => {
      const body = await readJson(req);
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const problem = store.getProblem(parseInt(body.problemId, 10));
      if (!problem) return sendJson(res, 404, { error: '题目不存在' });
      const lang = String(body.lang || '');
      if (lang !== 'cpp' && lang !== 'py') return sendJson(res, 400, { error: '语言只能是 cpp 或 py' });
      const code = String(body.code || '');
      let list = store.loadReferences(problem).filter((x) => x.lang !== lang);
      if (code.trim()) list.push({ name: lang === 'py' ? 'Python' : 'C++', lang, code });
      fs.writeFileSync(problem.referenceFile, JSON.stringify(list, null, 2));
      return sendJson(res, 200, { ok: true, lang, hasRef: !!code.trim() });
    });
route('POST', '/api/admin/solutions', async (req, res, pathname) => {
      const body = await readJson(req);
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const problem = store.getProblem(parseInt(body.problemId, 10));
      if (!problem) return sendJson(res, 404, { error: '题目不存在' });
      const list = Array.isArray(body.list)
        ? body.list.map((s) => ({ name: String((s && s.name) || '题解').slice(0, 50), content: String((s && s.content) || '') })).filter((s) => s.content.trim())
        : [];
      fs.writeFileSync(path.join(path.dirname(problem.solutionFile), 'solution.json'), JSON.stringify(list, null, 2));
      store.reloadProblem(problem.id);
      return sendJson(res, 200, { ok: true, count: list.length });
    });
route('POST', '/api/admin/references', async (req, res, pathname) => {
      const body = await readJson(req);
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const problem = store.getProblem(parseInt(body.problemId, 10));
      if (!problem) return sendJson(res, 404, { error: '题目不存在' });
      const list = Array.isArray(body.list)
        ? body.list.map((x) => ({ name: String((x && x.name) || '参考代码').slice(0, 50), lang: (x && x.lang === 'py') ? 'py' : 'cpp', code: String((x && x.code) || '') })).filter((x) => x.code.trim())
        : [];
      fs.writeFileSync(problem.referenceFile, JSON.stringify(list, null, 2));
      return sendJson(res, 200, { ok: true, count: list.length });
    });
route('GET', '/api/files', async (req, res, pathname) => {
      const me = authUser(req);
      const list = store.filesData.filter((f) => isAdminUser(me) || !f.hidden);
      return sendJson(res, 200, { files: list.slice().reverse() });
    });
route('POST', '/api/admin/file/hidden', async (req, res, pathname) => {
      const body = await readJson(req);
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const f = store.filesData.find((x) => x.id === parseInt(body.id, 10));
      if (!f) return sendJson(res, 404, { error: '附件不存在' });
      f.hidden = !!body.hidden;
      store.saveFilesIndex();
      return sendJson(res, 200, { ok: true, hidden: f.hidden });
    });
route('POST', '/api/admin/file', async (req, res, pathname) => {
      const me = authUser(req); // M-1：鉴权前置
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const mp = await readMultipart(req, 200 * 1024 * 1024);
      if (!mp) return sendJson(res, 400, { error: '需要 multipart/form-data 上传' });
      const parts = mp.parts;
      const field = mp.field;
      const file = parts.find((p) => p.filename && p.filename !== '');
      if (!file) return sendJson(res, 400, { error: '请选择要上传的文件' });
      const origName = file.filename.replace(/[\\/]/g, '_').slice(0, 120);
      if (!origName || origName === '.') return sendJson(res, 400, { error: '文件名无效' });
      const id = (store.filesData.length ? Math.max(...store.filesData.map((f) => f.id)) : 0) + 1;
      const ext = path.extname(origName).toLowerCase();
      const storeName = id + '_' + origName;
      fs.writeFileSync(path.join(store.FILES_DIR, storeName), file.body);
      store.filesData.push({ id, name: origName, ext, size: file.body.length, uploadedAt: Date.now(), storeName, hidden: false });
      store.saveFilesIndex();
      return sendJson(res, 200, { id, name: origName, size: file.body.length });
    });
route('GET', /^\/files\/\d+\/raw$/, async (req, res, pathname) => {
      const id = parseInt(pathname.split('/')[2], 10);
      const f = store.filesData.find((x) => x.id === id);
      if (!f) return sendJson(res, 404, { error: '附件不存在' });
      // 图片附件 raw 用于题面/md 内嵌展示，不因 hidden 拦截（hidden 仅控制附件列表是否单独显示）
      if (f.hidden && !store.IMG_MIME[f.ext] && !isAdminUser(authUser(req))) return sendForbidden(res, '附件已隐藏');
      const full = path.join(store.FILES_DIR, f.storeName);
      if (!fs.existsSync(full)) return sendJson(res, 404, { error: '附件文件缺失' });
      const ctype2 = store.IMG_MIME[f.ext] || (f.ext === '.pdf' ? 'application/pdf' : (f.ext === '.cpp' || f.ext === '.txt' || f.ext === '.md') ? 'text/plain; charset=utf-8' : 'application/octet-stream');
      const headers = { 'Content-Type': ctype2, 'Content-Disposition': `inline; filename="${encodeURIComponent(f.name)}"`, 'X-Content-Type-Options': 'nosniff' };
      if (f.ext === '.svg') headers['Content-Security-Policy'] = "sandbox; default-src 'none'"; // M-9：SVG 内嵌脚本禁用
      res.writeHead(200, headers);
      return res.end(fs.readFileSync(full));
    });
route('GET', /^\/files\/\d+\/download$/, async (req, res, pathname) => {
      const id = parseInt(pathname.split('/')[2], 10);
      const f = store.filesData.find((x) => x.id === id);
      if (!f) return sendJson(res, 404, { error: '附件不存在' });
      if (f.hidden && !isAdminUser(authUser(req))) return sendForbidden(res, '附件已隐藏');
      const full = path.join(store.FILES_DIR, f.storeName);
      if (!fs.existsSync(full)) return sendJson(res, 404, { error: '附件文件缺失' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${encodeURIComponent(f.name)}"` });
      return res.end(fs.readFileSync(full));
    });
route('GET', '/api/file/view', async (req, res, pathname) => {
      const q = getQuery(req);
      const f = store.filesData.find((x) => x.id === parseInt(q.id, 10));
      if (f && f.hidden && !isAdminUser(authUser(req))) return sendForbidden(res, '附件已隐藏');
      if (!f) return sendJson(res, 404, { error: '附件不存在' });
      const full = path.join(store.FILES_DIR, f.storeName);
      if (!fs.existsSync(full)) return sendJson(res, 404, { error: '附件文件缺失' });
      if (f.ext === '.pdf' || store.IMG_MIME[f.ext]) return sendJson(res, 200, { name: f.name, ext: f.ext, rawUrl: '/files/' + f.id + '/raw' });
      let text = '';
      try { text = fs.readFileSync(full, 'utf8'); } catch (e) { return sendJson(res, 500, { error: '读取失败' }); }
      const html = f.ext === '.md' ? renderMarkdown(text) : '<pre class="code">' + esc(text) + '</pre>';
      return sendJson(res, 200, { name: f.name, ext: f.ext, html });
    });
route('POST', '/api/admin/file/delete', async (req, res, pathname) => {
      const body = await readJson(req);
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const id = parseInt(body.id, 10);
      const f = store.filesData.find((x) => x.id === id);
      if (!f) return sendJson(res, 404, { error: '附件不存在' });
      try { fs.unlinkSync(path.join(store.FILES_DIR, f.storeName)); } catch (e) { /* ignore */ }
      store.filesData = store.filesData.filter((x) => x.id !== id);
      store.saveFilesIndex();
      return sendJson(res, 200, { ok: true });
    });
route('GET', '/api/homeworks', async (req, res, pathname) => {
      const me = authUser(req);
      const isAdm = isAdminUser(me);
      // 期次列表：id 0 = 最新（当前作业），id ≥1 = 历史期次
      const sessList = [{ id: 0, name: store.hwData.currentSessionName || '最新作业' }]
        .concat((store.hwData.sessions || []).map((s, i) => ({ id: i + 1, name: s.name })));
      const q = getQuery(req);
      const sid = parseInt(q.session, 10);
      const sel = Number.isInteger(sid) && sid > 0 ? sid : 0;
      // 已归档（归入历史期）的文本作业：最新期不再展示
      const archivedIds = {};
      for (const s of (store.hwData.sessions || [])) for (const hid of (s.homeworkIds || [])) archivedIds[hid] = true;
      let hwStars, stars, order, hwIn;
      if (sel === 0) {
        hwStars = store.hwData.homeworkStars || [];
        stars = store.hwData.programmingStars || [];
        order = store.hwData.programmingOrder || [];
        hwIn = (hid) => !archivedIds[hid];
      } else {
        const s = (store.hwData.sessions || [])[sel - 1];
        if (!s) return sendJson(res, 404, { error: '作业期次不存在' });
        hwStars = s.homeworkStars || [];
        stars = s.stars || [];
        order = s.order || [];
        const hwIds = {}; for (const hid of (s.homeworkIds || [])) hwIds[hid] = true;
        hwIn = (hid) => !!hwIds[hid];
      }
      const list = store.hwData.homeworks
        .filter((h) => hwIn(h.id) && (isAdm || !h.hidden))
        .map((h) => ({ id: h.id, title: h.title, questionCount: h.questions.length, publishedAt: h.publishedAt, startAt: h.startAt || null, hidden: !!h.hidden, allowViewOthers: !!h.allowViewOthers, star: hwStars.indexOf(h.id) !== -1 }));
      // 学生视角：必做（星标）作业排在选做之前（组内按 id 保持先后）
      if (!isAdm) {
        list.sort((a, b) => (a.star === b.star) ? (a.id - b.id) : (a.star ? -1 : 1));
      }
      const pIds = {}; for (const pid of order) pIds[pid] = true;
      const jobs = store.PROBLEMS.filter((p) => p.judgeable && pIds[p.id] && (isAdm || !p.hidden))
        .map((p) => ({ id: p.id, title: p.title, testCount: p.tests.length, timeLimitSec: p.timeLimitSec, memLimitKb: p.memLimitKb, hidden: !!p.hidden, star: stars.indexOf(p.id) !== -1, approachOpen: p.approachOpen !== false, solutionOpen: p.solutionOpen !== false, referenceOpen: p.referenceOpen !== false }));
      // 按管理员设置的顺序排序（未设置的题追加在末尾）
      const orderMap = {};
      order.forEach((id, i) => { orderMap[id] = i; });
      jobs.sort((a, b) => {
        const ia = orderMap[a.id] !== undefined ? orderMap[a.id] : 1e9;
        const ib = orderMap[b.id] !== undefined ? orderMap[b.id] : 1e9;
        return (ia - ib) || (a.id - b.id);
      });
      // 学生视角：必做题（星标）一律排在选做题前面（各自内部保持教师顺序）
      if (!isAdm) {
        jobs.sort((a, b) => {
          const sa = a.star ? 0 : 1;
          const sb = b.star ? 0 : 1;
          if (sa !== sb) return sa - sb;
          const ia = orderMap[a.id] !== undefined ? orderMap[a.id] : 1e9;
          const ib = orderMap[b.id] !== undefined ? orderMap[b.id] : 1e9;
          return (ia - ib) || (a.id - b.id);
        });
      }
      return sendJson(res, 200, { sessions: sessList, session: sel, homeworks: list, programmingJobs: jobs });
    });
route('GET', '/api/homework', async (req, res, pathname) => {
      const q = getQuery(req);
      const hw = store.hwData.homeworks.find((h) => h.id === parseInt(q.id, 10));
      if (!hw) return sendJson(res, 404, { error: '作业不存在' });
      if (hw.hidden && !isAdminUser(authUser(req))) return sendJson(res, 404, { error: '作业不存在' });
      const now = Date.now();
      const started = !hw.startAt || now >= hw.startAt;
      const me = authUser(req);
      const mine = me ? store.hwData.answers.filter((a) => a.homeworkId === hw.id && a.uid === me.id) : [];
      const canSeeQs = started || isAdminUser(me); // M-17：未开始（startAt 未到）时对学生不返回题目内容
      return sendJson(res, 200, {
        id: hw.id, title: hw.title, questions: canSeeQs ? hw.questions : [], started, startAt: hw.startAt || null,
        questionsHtml: canSeeQs ? hw.questions.map((t) => renderMarkdown(t || '')) : [],
        allowViewOthers: !!hw.allowViewOthers,
        announcement: hw.announcement || '',
        announcementHtml: hw.announcement ? renderMarkdown(hw.announcement) : '',
        myAnswer: started && mine.length ? mine[mine.length - 1].answers : null,
        submittedAt: started && mine.length ? mine[mine.length - 1].submittedAt : null,
        gradeStatus: started && mine.length ? (mine[mine.length - 1].gradeStatus || 'pending') : null,
        score: started && mine.length ? (mine[mine.length - 1].score == null ? null : mine[mine.length - 1].score) : null,
        comment: started && mine.length ? (mine[mine.length - 1].comment || '') : '',
        commentHtml: started && mine.length && mine[mine.length - 1].comment ? renderMarkdown(mine[mine.length - 1].comment) : '',
        commentPublic: started && mine.length ? !!(mine[mine.length - 1].commentPublic) : false,
        commentRead: started && mine.length ? !!(mine[mine.length - 1].commentRead) : true,
      });
    });
route('GET', '/api/homework/others', async (req, res, pathname) => {
      const q = getQuery(req);
      const hw = store.hwData.homeworks.find((h) => h.id === parseInt(q.id, 10));
      const me = authUser(req);
      if (!me) return sendUnauthorized(res);
      if (!hw || hw.hidden) return sendJson(res, 404, { error: '作业不存在' });
      if (hw.startAt && Date.now() < hw.startAt) return sendJson(res, 400, { error: '作业尚未开始' });
      // S-8：教师开关 allowViewOthers 必须生效，未开放时仅管理员可查看他人答案
      if (!hw.allowViewOthers && !isAdminUser(me)) return sendForbidden(res, '该作业未开放「查看他人答案」，仅管理员可查看');
      const list = store.hwData.answers
        .filter((a) => a.homeworkId === hw.id && a.uid !== me.id)
        .map((a) => ({ username: a.username || a.name || '匿名', submittedAt: a.submittedAt, answerHtml: (a.answers || []).map((t) => renderMarkdown(t || '')) }))
        .sort((a, b) => b.submittedAt - a.submittedAt);
      return sendJson(res, 200, { answers: list });
    });
// M-8：评语已读标记改为显式 POST（原 GET /api/homework 附带写副作用）
route('POST', '/api/homework/read', async (req, res, pathname) => {
      const me = authUser(req);
      if (!me) return sendUnauthorized(res);
      const body = await readJson(req);
      const hw = store.hwData.homeworks.find((h) => h.id === parseInt(body.id, 10));
      if (!hw) return sendJson(res, 404, { error: '作业不存在' });
      const mine = store.hwData.answers.filter((a) => a.homeworkId === hw.id && a.uid === me.id);
      if (!mine.length) return sendJson(res, 200, { ok: true });
      let changed = false;
      for (const a of mine) if (a.comment && !a.commentRead) { a.commentRead = true; changed = true; }
      if (changed) store.saveHw();
      return sendJson(res, 200, { ok: true });
    });
route('POST', '/api/homework/answer', async (req, res, pathname) => {
      const body = await readJson(req);
      const hw = store.hwData.homeworks.find((h) => h.id === parseInt(body.homeworkId, 10));
      if (!hw || hw.hidden) return sendJson(res, 404, { error: '作业不存在' });
      if (hw.startAt && Date.now() < hw.startAt) return sendJson(res, 400, { error: '作业尚未开始，暂不能提交' });
      const me = authUser(req);
      const answers = Array.isArray(body.answers) ? body.answers.map((a) => String(a || '').slice(0, 100000)) : [];
      if (answers.length !== hw.questions.length) return sendJson(res, 400, { error: '答案数量与问题数不符' });
      const ip = reqIp(req);
      // 保存每个历史版本（不覆盖）：新提交 append，版本号递增；评分/评语作用于最新版本
      const minePrev = store.hwData.answers.filter((a) => a.homeworkId === hw.id && a.uid === me.id);
      const ver = minePrev.reduce((m, a) => Math.max(m, a.version || 0), 0) + 1;
      store.hwData.answers.push({ homeworkId: hw.id, uid: me.id, name: me.fullname, username: me.username, ip, answers, submittedAt: Date.now(), version: ver, gradeStatus: 'pending', score: null, comment: '', commentRead: true });
      // L-8：每人每作业最多保留 20 个历史版本，防 homework.json 无限膨胀（按对象身份裁剪，避免同毫秒误删）
      const mineAll = store.hwData.answers.filter((a) => a.homeworkId === hw.id && a.uid === me.id);
      if (mineAll.length > 20) {
        const keep = new Set(mineAll.slice(-20));
        store.hwData.answers = store.hwData.answers.filter((a) => !(a.homeworkId === hw.id && a.uid === me.id) || keep.has(a));
      }
      store.saveHw();
      return sendJson(res, 200, { ok: true, version: ver });
    });
route('POST', '/api/admin/homework/programming-order', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      if (!Array.isArray(body.order)) return sendJson(res, 400, { error: 'order 必须是数组' });
      store.hwData.programmingOrder = body.order.map((x) => parseInt(x, 10)).filter((x) => !isNaN(x));
      store.saveHw();
      return sendJson(res, 200, { ok: true, order: store.hwData.programmingOrder });
    });
route('POST', '/api/admin/homework/programming-star', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const pid = parseInt(body.problemId, 10);
      if (!store.getProblem(pid)) return sendJson(res, 404, { error: '题目不存在' });
      store.hwData.programmingStars = store.hwData.programmingStars || [];
      if (body.star) { if (store.hwData.programmingStars.indexOf(pid) === -1) store.hwData.programmingStars.push(pid); }
      else store.hwData.programmingStars = store.hwData.programmingStars.filter((x) => x !== pid);
      store.saveHw();
      return sendJson(res, 200, { ok: true, star: !!body.star, stars: store.hwData.programmingStars });
    });
route('POST', '/api/admin/homework/star', async (req, res, pathname) => {
      const body = await readJson(req);
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const hwId = parseInt(body.id, 10);
      const hw = store.hwData.homeworks.find((h) => h.id === hwId);
      if (!hw) return sendJson(res, 404, { error: '作业不存在' });
      store.hwData.homeworkStars = store.hwData.homeworkStars || [];
      if (body.star) { if (store.hwData.homeworkStars.indexOf(hwId) === -1) store.hwData.homeworkStars.push(hwId); }
      else store.hwData.homeworkStars = store.hwData.homeworkStars.filter((x) => x !== hwId);
      store.saveHw();
      return sendJson(res, 200, { ok: true, star: !!body.star, stars: store.hwData.homeworkStars });
    });
route('GET', '/api/admin/export-session', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const q = getQuery(req);
      const sid = parseInt(q.session, 10);
      const sel = Number.isInteger(sid) && sid > 0 ? sid : 0;
      let order, sname;
      if (sel === 0) { order = store.hwData.programmingOrder || []; sname = store.hwData.currentSessionName || '最新作业'; }
      else {
        const s = (store.hwData.sessions || [])[sel - 1];
        if (!s) return sendJson(res, 404, { error: '作业期次不存在' });
        order = s.order || []; sname = s.name;
      }
      let md = `# ${sname} — 题目导出\n\n（题面 / 样例 / 提示 / 参考代码，共 ${order.length} 题）\n`;
      for (const pid of order) {
        const problem = store.getProblem(pid);
        if (!problem) continue;
        let desc = '';
        try { desc = fs.readFileSync(problem.descriptionFile, 'utf8'); } catch (e) { /* ignore */ }
        md += `\n---\n\n${desc.trim()}\n\n`;
        // 样例
        const samples = (problem.samples || []).slice();
        if (problem.hasSample && !samples.length) samples.push({ id: '1', input: problem.sampleIn, output: problem.sampleOut });
        if (samples.length) {
          md += `## 样例\n\n`;
          for (const sp of samples) {
            let si = '', so = '';
            try { si = fs.readFileSync(sp.input, 'utf8').replace(/\s+$/, ''); so = fs.readFileSync(sp.output, 'utf8').replace(/\s+$/, ''); } catch (e) { /* ignore */ }
            md += `### 样例 ${sp.id}\n\n输入：\n\n\`\`\`\n${si}\n\`\`\`\n\n输出：\n\n\`\`\`\n${so}\n\`\`\`\n\n`;
          }
        }
        // 参考代码（std）
        const refs = store.loadReferences(problem);
        md += `## 参考代码（std）\n\n`;
        if (refs.length) {
          for (const r of refs) {
            md += `### ${r.name}（${r.lang === 'py' ? 'Python' : 'C++'}）\n\n\`\`\`${r.lang === 'py' ? 'python' : 'cpp'}\n${r.code.replace(/\s+$/, '')}\n\`\`\`\n\n`;
          }
        } else {
          md += `（暂无参考代码）\n\n`;
        }
      }
      const filename = encodeURIComponent(sname) + '.md';
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` });
      return res.end(md);
    });
route('POST', '/api/admin/session/current', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const k = parseInt(body.session, 10);
      const sessions = store.hwData.sessions || [];
      if (!Number.isInteger(k) || k < 1 || k > sessions.length) return sendJson(res, 400, { error: '期次不存在' });
      const target = sessions[k - 1];
      // 旧当前期文本作业 = 未出现在任何历史期 homeworkIds 中的文本作业（target 将被提升，不再归档）
      const allIds = {};
      for (const s of sessions) for (const hid of (s.homeworkIds || [])) allIds[hid] = true;
      const curHwIds = store.hwData.homeworks.filter((h) => !allIds[h.id]).map((h) => h.id);
      // 旧当前期 → 归档到被提升期次的原位置
      sessions[k - 1] = {
        name: store.hwData.currentSessionName || '最新作业',
        order: store.hwData.programmingOrder || [],
        stars: store.hwData.programmingStars || [],
        homeworkStars: store.hwData.homeworkStars || [],
        homeworkIds: curHwIds,
      };
      // target → 提升为当前期
      store.hwData.currentSessionName = target.name;
      store.hwData.programmingOrder = target.order || [];
      store.hwData.programmingStars = target.stars || [];
      store.hwData.homeworkStars = target.homeworkStars || [];
      store.saveHw();
      return sendJson(res, 200, { ok: true, session: k, name: target.name });
    });
// 新建作业期次：当前期归档为历史首位，新空期成为当前期（此前只能停服手改 homework.json，现提供正式接口）
route('POST', '/api/admin/session/create', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const name = String(body.name || '').trim().slice(0, 40);
      if (!name) return sendJson(res, 400, { error: '请填写新期次名称' });
      const sessions = store.hwData.sessions || [];
      const allIds = {};
      for (const s of sessions) for (const hid of (s.homeworkIds || [])) allIds[hid] = true;
      const curHwIds = store.hwData.homeworks.filter((h) => !allIds[h.id]).map((h) => h.id);
      sessions.unshift({
        name: store.hwData.currentSessionName || '最新作业',
        order: store.hwData.programmingOrder || [],
        stars: store.hwData.programmingStars || [],
        homeworkStars: store.hwData.homeworkStars || [],
        homeworkIds: curHwIds,
      });
      store.hwData.sessions = sessions;
      store.hwData.currentSessionName = name;
      store.hwData.programmingOrder = [];
      store.hwData.programmingStars = [];
      store.hwData.homeworkStars = [];
      store.saveHw();
      return sendJson(res, 200, {
        ok: true, name,
        sessions: [{ id: 0, name }].concat(sessions.map((s, i) => ({ id: i + 1, name: s.name }))),
      });
    });
// 期次重命名：session=0 当前期；≥1 历史期
route('POST', '/api/admin/session/rename', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const k = parseInt(body.session, 10);
      const name = String(body.name || '').trim().slice(0, 40);
      if (!name) return sendJson(res, 400, { error: '请填写期次名称' });
      if (k > 0) {
        const s = (store.hwData.sessions || [])[k - 1];
        if (!s) return sendJson(res, 404, { error: '期次不存在' });
        s.name = name;
      } else {
        store.hwData.currentSessionName = name;
      }
      store.saveHw();
      return sendJson(res, 200, { ok: true, session: k, name });
    });
// 删除历史期次：仅允许删除空期次（无编程题/无文本作业），防误删成绩数据；当前期不可删除
route('POST', '/api/admin/session/delete', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const k = parseInt(body.session, 10);
      const sessions = store.hwData.sessions || [];
      if (!Number.isInteger(k) || k < 1 || k > sessions.length) return sendJson(res, 400, { error: '请选择要删除的历史期次（当前期不可删除）' });
      const s = sessions[k - 1];
      if ((s.order || []).length || (s.homeworkIds || []).length) {
        return sendJson(res, 400, { error: '该期次含有编程题或文本作业，暂不支持删除（可先清空其内容）' });
      }
      sessions.splice(k - 1, 1);
      store.hwData.sessions = sessions;
      store.saveHw();
      return sendJson(res, 200, { ok: true, sessions: [{ id: 0, name: store.hwData.currentSessionName || '最新作业' }].concat(sessions.map((x, i) => ({ id: i + 1, name: x.name }))) });
    });
route('POST', '/api/admin/homework/grade', async (req, res, pathname) => {
      const body = await readJson(req);
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const hwId = parseInt(body.homeworkId, 10);
      const uid = parseInt(body.uid, 10);
      const score = parseInt(body.score, 10);
      if (!hwId || !uid || isNaN(score) || score < 0 || score > 100) return sendJson(res, 400, { error: '分数需为 0~100 的整数' });
      let hit = false;
      store.hwData.answers = store.hwData.answers.map((a) => {
        if (a.homeworkId === hwId && a.uid === uid) { a.score = score; a.gradeStatus = 'graded'; a.gradedAt = Date.now(); hit = true; }
        return a;
      });
      if (!hit) return sendJson(res, 404, { error: '未找到该作业答案' });
      store.saveHw();
      return sendJson(res, 200, { ok: true, score, status: score >= 100 ? '满分' : '需订正' });
    });
route('POST', '/api/admin/homework/announcement', async (req, res, pathname) => {
      const body = await readJson(req);
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const hw = store.hwData.homeworks.find((h) => h.id === parseInt(body.id, 10));
      if (!hw) return sendJson(res, 404, { error: '作业不存在' });
      hw.announcement = String(body.text || '').slice(0, 10000);
      store.saveHw();
      return sendJson(res, 200, { ok: true, announcement: hw.announcement });
    });
route('POST', '/api/admin/homework/comment', async (req, res, pathname) => {
      const body = await readJson(req);
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const hwId = parseInt(body.homeworkId, 10);
      const uid = parseInt(body.uid, 10);
      if (!hwId || !uid) return sendJson(res, 400, { error: '参数不完整' });
      const comment = String(body.comment || '').slice(0, 10000);
      let hit = false;
      store.hwData.answers = store.hwData.answers.map((a) => {
        if (a.homeworkId === hwId && a.uid === uid) { a.comment = comment; a.commentPublic = !!body.public; a.commentRead = false; hit = true; }
        return a;
      });
      if (!hit) return sendJson(res, 404, { error: '未找到该作业答案' });
      store.saveHw();
      return sendJson(res, 200, { ok: true, comment });
    });
route('GET', '/api/notifications/unread', async (req, res, pathname) => {
      const me = authUser(req);
      if (!me) return sendJson(res, 200, { count: 0, items: [] });
      const items = [];
      const seenHw = {}; // 同一作业多版本只显示最新一条未读
      for (const a of store.hwData.answers) {
        if (a.uid === me.id && a.comment && !a.commentRead) {
          const hw = store.hwData.homeworks.find((h) => h.id === a.homeworkId);
          const cur = items.find((x) => x.type === 'hw' && x.homeworkId === a.homeworkId);
          if (cur) { if (a.submittedAt > cur.submittedAt) { cur.submittedAt = a.submittedAt; } continue; }
          items.push({ type: 'hw', homeworkId: a.homeworkId, title: hw ? hw.title : ('作业 ' + a.homeworkId), submittedAt: a.submittedAt });
        }
      }
      // 题目提示更新通知（未读；跳过 __global__ 全站公告等非数字键——它没有逐人已读语义）
      for (const pid of Object.keys(store.noticesData)) {
        if (!/^\d+$/.test(pid)) continue;
        const nt = store.noticesData[pid];
        if (!nt || nt.readBy.indexOf(me.id) !== -1) continue;
        const p = store.getProblem(parseInt(pid, 10));
        items.push({ type: 'problem', problemId: parseInt(pid, 10), title: p ? ('#' + pid + ' ' + p.title) : ('#' + pid), text: nt.text, createdAt: nt.createdAt });
      }
      // 教师私信（未读；text 完整返回，前端截断显示、点开看全文）
      for (const m of store.messages) {
        if (m.toUid === me.id && !m.read) {
          items.push({ type: 'msg', messageId: m.id, fromName: m.fromName || '教师', text: m.text, createdAt: m.createdAt });
        }
      }
      items.sort((a, b) => (b.submittedAt || b.createdAt || 0) - (a.submittedAt || a.createdAt || 0));   // 最新的未读在前
      return sendJson(res, 200, { count: items.length, items });
    });
route('POST', '/api/notifications/problem/read', async (req, res, pathname) => {
      const me = authUser(req);
      if (!me) return sendUnauthorized(res);
      const body = await readJson(req);
      const key = String(parseInt(body.problemId, 10));
      const nt = store.noticesData[key];
      if (nt && nt.readBy.indexOf(me.id) === -1) { nt.readBy.push(me.id); store.saveNotices(); }
      return sendJson(res, 200, { ok: true });
    });
// 统一已读标记：{all:true} 全部已读；{type:'hw', homeworkId} 该作业我的评语全部已读（作业被删也可标记）；{type:'problem', problemId} 该题通知已读
route('POST', '/api/notifications/read', async (req, res, pathname) => {
      const me = authUser(req);
      if (!me) return sendUnauthorized(res);
      const body = await readJson(req);
      let changedHw = false, changedNt = false, changedMsg = false;
      const markHw = (hwId) => {
        for (const a of store.hwData.answers) {
          if (a.uid === me.id && a.comment && !a.commentRead && (hwId == null || a.homeworkId === hwId)) { a.commentRead = true; changedHw = true; }
        }
      };
      const markNt = (pidKey) => {
        for (const key of Object.keys(store.noticesData)) {
          if (!/^\d+$/.test(key)) continue;
          if (pidKey != null && key !== pidKey) continue;
          const nt = store.noticesData[key];
          if (nt && nt.readBy.indexOf(me.id) === -1) { nt.readBy.push(me.id); changedNt = true; }
        }
      };
      const markMsg = (mid) => {
        for (const m of store.messages) {
          if (m.toUid === me.id && !m.read && (mid == null || m.id === mid)) { m.read = true; m.readAt = Date.now(); changedMsg = true; }
        }
      };
      if (body && body.all === true) { markHw(null); markNt(null); markMsg(null); }
      else if (body && body.type === 'hw') { const id = parseInt(body.homeworkId, 10); if (!Number.isInteger(id)) return sendJson(res, 400, { error: '参数无效' }); markHw(id); }
      else if (body && body.type === 'problem') { const key = String(parseInt(body.problemId, 10)); if (!/^\d+$/.test(key)) return sendJson(res, 400, { error: '参数无效' }); markNt(key); }
      else if (body && body.type === 'msg') { const mid = parseInt(body.messageId, 10); if (!Number.isInteger(mid)) return sendJson(res, 400, { error: '参数无效' }); markMsg(mid); }
      else return sendJson(res, 400, { error: '参数无效' });
      if (changedHw) store.saveHw();
      if (changedNt) store.saveNotices();
      if (changedMsg) store.saveMessages();
      return sendJson(res, 200, { ok: true });
    });
// 教师向学生发送私信（text 1~2000 字；支持 #提交编号 引用与 http(s) 链接，由前端渲染）
route('POST', '/api/admin/message', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const toUid = parseInt(body.toUid, 10);
      const toUsername = String(body.toUsername || '').trim();
      const target = store.users.find((u) => u.id === toUid) || (toUsername ? store.users.find((u) => u.username === toUsername) : null);
      if (!target) return sendJson(res, 404, { error: '收件学生不存在' });
      if (target.role === 'admin' || target.role === 'superadmin') return sendJson(res, 400, { error: '只能发送给学生账号' });
      const text = String(body.text || '').trim();
      if (!text) return sendJson(res, 400, { error: '消息内容不能为空' });
      if (text.length > 2000) return sendJson(res, 400, { error: '消息内容过长（最多 2000 字）' });
      const id = (store.messages.length ? Math.max(...store.messages.map((m) => m.id)) : 0) + 1;
      store.messages.push({
        id, fromUid: me.id, fromName: me.fullname || me.username,
        toUid: target.id, toUsername: target.username, toFullname: target.fullname || '',
        text, createdAt: Date.now(), read: false, readAt: null,
      });
      // 每个收件人最多保留最近 200 条，防 messages.json 无限膨胀
      const mine = store.messages.filter((m) => m.toUid === target.id);
      if (mine.length > 200) {
        const keep = new Set(mine.slice(-200));
        store.messages = store.messages.filter((m) => m.toUid !== target.id || keep.has(m));
      }
      store.saveMessages();
      store.appendLog(me, 'interact', '/api/admin/message', '向 ' + target.username + ' 发送私信 #' + id);
      return sendJson(res, 200, { ok: true, id });
    });
// 学生查看自己的私信（含已读，最新 100 条倒序）
route('GET', '/api/messages', async (req, res, pathname) => {
      const me = authUser(req);
      if (!me) return sendUnauthorized(res);
      const list = store.messages
        .filter((m) => m.toUid === me.id)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 100)
        .map((m) => ({ id: m.id, fromName: m.fromName || '教师', text: m.text, createdAt: m.createdAt, read: !!m.read }));
      return sendJson(res, 200, { list });
    });
// 学生标记私信已读：{id} 单条（仅本人收件）或 {all:true} 全部
route('POST', '/api/messages/read', async (req, res, pathname) => {
      const me = authUser(req);
      if (!me) return sendUnauthorized(res);
      const body = await readJson(req);
      let changed = false;
      if (body && body.all === true) {
        for (const m of store.messages) if (m.toUid === me.id && !m.read) { m.read = true; m.readAt = Date.now(); changed = true; }
      } else {
        const mid = parseInt(body && body.id, 10);
        const m = store.messages.find((x) => x.id === mid);
        if (!m || m.toUid !== me.id) return sendJson(res, 404, { error: '消息不存在' });
        if (!m.read) { m.read = true; m.readAt = Date.now(); changed = true; }
      }
      if (changed) store.saveMessages();
      return sendJson(res, 200, { ok: true });
    });
// 教师查看已发私信（?toUid=N 过滤；最新 200 条倒序）
route('GET', '/api/admin/messages', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const q = getQuery(req);
      let toUid = q.toUid ? parseInt(q.toUid, 10) : null;
      if (toUid == null && q.toUsername) {
        const t = store.users.find((u) => u.username === String(q.toUsername));
        toUid = t ? t.id : -1; // 用户不存在 → 空列表
      }
      const list = store.messages
        .filter((m) => toUid == null || m.toUid === toUid)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 200);
      return sendJson(res, 200, { list });
    });
route('POST', '/api/admin/homework/settings', async (req, res, pathname) => {
      const body = await readJson(req);
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const hw = store.hwData.homeworks.find((h) => h.id === parseInt(body.id, 10));
      if (!hw) return sendJson(res, 404, { error: '作业不存在' });
      if (typeof body.hidden === 'boolean') hw.hidden = body.hidden;
      if (typeof body.allowViewOthers === 'boolean') hw.allowViewOthers = body.allowViewOthers;
      store.saveHw();
      return sendJson(res, 200, { ok: true, hidden: !!hw.hidden, allowViewOthers: !!hw.allowViewOthers });
    });
route('POST', '/api/admin/homework', async (req, res, pathname) => {
      const body = await readJson(req);
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const title = String(body.title || '').trim().slice(0, 60);
      const questions = Array.isArray(body.questions) ? body.questions.map((q) => String(q || '').trim().slice(0, 1000)).filter(Boolean) : [];
      const startAt = body.startAt ? parseInt(body.startAt, 10) : null;
      if (!title) return sendJson(res, 400, { error: '请填写作业标题' });
      if (!questions.length) return sendJson(res, 400, { error: '请至少提供一个问题' });
      const id = (store.hwData.homeworks.length ? Math.max(...store.hwData.homeworks.map((h) => h.id)) : 0) + 1;
      store.hwData.homeworks.push({ id, title, questions, startAt, publishedAt: Date.now(), hidden: !!body.hidden, allowViewOthers: !!body.allowViewOthers });
      store.saveHw();
      return sendJson(res, 200, { id, title, questionCount: questions.length });
    });
route('GET', '/api/homework/answers', async (req, res, pathname) => {
      const q = getQuery(req);
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const hwId = parseInt(q.homeworkId, 10);
      const hw = store.hwData.homeworks.find((h) => h.id === hwId);
      if (!hw) return sendJson(res, 404, { error: '作业不存在' });
      const answers = store.hwData.answers.filter((a) => a.homeworkId === hwId);
      return sendJson(res, 200, {
        title: hw.title,
        questions: hw.questions,
        answers: answers.sort((a, b) => b.submittedAt - a.submittedAt).map((a) => Object.assign({}, a, {
          version: a.version || 1,
          commentHtml: a.comment ? renderMarkdown(a.comment) : '',
          // 答案支持 Markdown：逐问渲染为 HTML（renderMarkdown 已转义）
          username: a.username || a.name || '匿名', answerHtml: (a.answers || []).map((t) => renderMarkdown(t || '')),
        })),
      });
    });
route('GET', '/api/status', async (req, res, pathname) => {
      const q = getQuery(req);
      const me = authUser(req);
      const isAdmin = isAdminUser(me);
      const freezeSt = contestFreezeState(me); // H1：封榜期隐藏窗口内提交的判定/分数
      let visible = isAdmin ? store.submissions : store.submissions.filter((s) => {
        if (!s.hidden) return true;
        // AI 拦截的提交：本人可见（列表显示「已拦截」），他人不可见
        if (s.aiBlocked && me) return (s.uid && s.uid === me.id) || (!s.uid && s.username && s.username === me.username);
        return false;
      });
      // 普通用户界面模式：不显示管理员（教师）的提交；管理员本人仍保留查看代码权限（canViewCode 按角色判断）
      if (q.excludeAdmins === '1') {
        const adminNames = {};
        for (const u of store.users) if (u.role === 'admin' || u.role === 'superadmin') adminNames[u.username] = true;
        visible = visible.filter((s) => !adminNames[s.username]);
      }
      if (q.user) visible = visible.filter((s) => (s.username || s.name) === String(q.user));
      if (q.problem) visible = visible.filter((s) => String(s.problemId || store.FIRST_PROBLEM_ID) === String(q.problem));
      // M-2：隐藏题的提交对非管理员不可见（模考进行中/已公布的题除外）
      if (!isAdmin) {
        const nowTs = Date.now();
        visible = visible.filter((s) => {
          const p = store.getProblem(s.problemId);
          return !p || !p.hidden || examAccessForProblem(s.problemId, nowTs);
        });
      }
      // 服务端分页：?page=&size= 翻页；?find=<submissionId>&size= 定位该提交所在页（缺省无参数 = 全量，兼容旧客户端/管理后台/测试）
      const total = visible.length;
      const pageN = parseInt(q.page, 10);
      const sizeN = parseInt(q.size, 10);
      const findId = parseInt(q.find, 10);
      const sizeOk = Number.isInteger(sizeN) && sizeN >= 1 && sizeN <= 200;
      const hasFind = Number.isInteger(findId) && findId > 0;
      const paged = sizeOk && (hasFind || (Number.isInteger(pageN) && pageN > 0));
      let page = (Number.isInteger(pageN) && pageN > 0) ? pageN : 1;
      if (paged) {
        if (hasFind) {
          const idx = visible.findIndex((s) => s.id === findId);
          page = idx === -1 ? 1 : Math.floor((total - 1 - idx) / sizeN) + 1;
        }
        const maxPage = Math.max(1, Math.ceil(total / sizeN));
        if (page > maxPage) page = maxPage; // L-5：超界页钳制到末页
        // 列表为最新在前：从尾部取本页区间（后续统一 reverse）
        const start = Math.max(0, total - page * sizeN);
        const end = Math.max(0, total - (page - 1) * sizeN);
        visible = visible.slice(start, end);
      }
      const list = visible.slice().reverse().map((s) => {
        const p = store.getProblem(s.problemId);
        const ex = s.examId ? store.exams.find((e) => e.id === s.examId) : null;
        // 模考成绩隐藏：hideVerdict 考试在公布前，学生（含匿名/普通用户界面模式）只能看到「已评测」，看不到结果
        const hideV = ex && ex.hideVerdict && Date.now() < ex.publishAt && !isAdmin;
        const freezeHide = freezeHidesSub(s, freezeSt); // H1：封榜期内窗口内提交隐藏判定/分数
        return {
          id: s.id, problemId: s.problemId || store.FIRST_PROBLEM_ID, problemTitle: p ? p.title : ('题目 ' + (s.problemId || store.FIRST_PROBLEM_ID)),
          username: s.username, name: s.name, std: s.std, ...(isAdmin ? { ip: s.ip } : {}), hidden: !!s.hidden, status: s.status, // M-10：IP 仅管理员可见
          summary: (hideV || freezeHide) ? null : s.summary,
          score: (hideV || freezeHide) ? null : (s.score != null ? s.score : (s.summary && s.summary.score != null ? s.summary.score : null)),
          examId: s.examId || null, phase: s.phase || null,
          verdictHidden: hideV || freezeHide,
          imported: !!s.imported, hwSession: s.hwSession != null ? s.hwSession : null,
          aiBlocked: !!s.aiBlocked, aiPending: !!s.aiPending, // AI 安全检测状态（blocked 项对学生已被 hidden 过滤，仅管理员可见）
          submittedAt: s.submittedAt, finishedAt: s.finishedAt,
          judgedCount: s.status === 'judging' && s.points ? s.points.length : 0, // 评测中进度点数（完整点结果走 /api/submission/<id>）
        };
      });
      return sendJson(res, 200, { list, total, page, size: paged ? sizeN : null, problems: store.PROBLEMS.filter((p) => isAdmin || !p.hidden).map((p) => ({ id: p.id, title: p.title, testCount: p.tests.length, judgeable: p.judgeable, hidden: p.hidden, rankEnabled: p.rankEnabled, timeLimitSec: p.timeLimitSec, memLimitKb: p.memLimitKb, owner: p.owner || '' })) });
    });
route('GET', /^\/api\/submission\/\d+$/, async (req, res, pathname) => {
      const id = parseInt(pathname.split('/')[3], 10);
      const me = authUser(req);
      if (!me) return sendUnauthorized(res); // S-4：登录后可见
      const s = store.submissions.find((x) => x.id === id);
      if (!s) return sendJson(res, 404, { error: '提交不存在' });
      // AI 拦截：本人可见「已被拦截」说明（不含任何评测细节/代码），他人一律 404，管理员全见
      if (s.aiBlocked && !isAdminUser(me)) {
        const own = (s.uid && s.uid === me.id) || (!s.uid && s.username && s.username === me.username);
        if (!own) return sendJson(res, 404, { error: '提交不存在' });
        return sendJson(res, 200, {
          id: s.id, problemId: s.problemId || store.FIRST_PROBLEM_ID, username: s.username, name: s.name, std: s.std,
          status: 'done', summary: null, score: null, blocked: true,
          submittedAt: s.submittedAt, finishedAt: s.finishedAt, points: [], exPoints: [], sampleResults: [], subtaskResults: [],
          prevId: null, help: null, canHelp: false, isOwn: true,
        });
      }
      if (s.hidden && !isAdminUser(me)) return sendJson(res, 404, { error: '提交不存在' });
      // M-2：隐藏题的提交对非管理员不可见（模考进行中/已公布的题除外）
      if (!isAdminUser(me)) {
        const sp = store.getProblem(s.problemId);
        if (sp && sp.hidden && !examAccessForProblem(s.problemId, Date.now())) return sendJson(res, 404, { error: '提交不存在' });
      }
      const p = store.getProblem(s.problemId);
      const ex = s.examId ? store.exams.find((e) => e.id === s.examId) : null;
      // 模考成绩隐藏：hideVerdict 考试在公布前，学生看不到逐点结果/分数（管理员全见）
      if (ex && ex.hideVerdict && Date.now() < ex.publishAt && !isAdminUser(me)) {
        return sendJson(res, 200, {
          id: s.id, problemId: s.problemId || store.FIRST_PROBLEM_ID, problemTitle: p ? p.title : ('题目 ' + (s.problemId || store.FIRST_PROBLEM_ID)),
          username: s.username, name: s.name, std: s.std, ...(isAdminUser(me) ? { ip: s.ip } : {}), hidden: !!s.hidden, status: s.status, summary: null,
          score: null, subtaskResults: [], examId: s.examId || null, phase: s.phase || null,
          verdictHidden: true, publishAt: ex.publishAt,
          submittedAt: s.submittedAt, finishedAt: s.finishedAt, points: [], exPoints: [], sampleResults: [],
          prevId: null,
          help: null, canHelp: false,
        });
      }
      // H1：封榜期内隐藏窗口内提交的判定/分数（防经 /api/submission/<id> 侧信道重建实时榜单）
      {
        const frz = contestFreezeState(me);
        if (freezeHidesSub(s, frz)) {
          return sendJson(res, 200, {
            id: s.id, problemId: s.problemId || store.FIRST_PROBLEM_ID, problemTitle: p ? p.title : ('题目 ' + (s.problemId || store.FIRST_PROBLEM_ID)),
            username: s.username, name: s.name, std: s.std, ...(isAdminUser(me) ? { ip: s.ip } : {}), hidden: !!s.hidden, status: s.status, summary: null,
            score: null, subtaskResults: [], examId: s.examId || null, phase: s.phase || null,
            verdictHidden: true, frozenHidden: true,
            submittedAt: s.submittedAt, finishedAt: s.finishedAt, points: [], exPoints: [], sampleResults: [], prevId: null,
            help: null, canHelp: false,
          });
        }
      }
      // 同一用户同一题的上一次提交（供「对比上次」diff）
      const prev = store.submissions
        .filter((x) => x.id < s.id && x.problemId === s.problemId && (x.uid != null ? x.uid === s.uid : x.username === s.username))
        .sort((a, b) => b.id - a.id)[0];
      // 归属门：非管理员且无查看权（canViewCode）时只返回汇总信息，隐藏逐点判定/Ex/样例细节
      const canDetail = isAdminUser(me) || canViewCode(s, me);
      const helpReq = (store.helpRequests || []).find((r) => r.submissionId === id);
      const isOwn = (s.uid && s.uid === me.id) || (!s.uid && s.username && s.username === me.username);
      const canHelp = !isAdminUser(me) && isOwn && isCurrentPeriodSubmission(s) && !(helpReq && helpReq.status === 'open');
      return sendJson(res, 200, {
        id: s.id, problemId: s.problemId || store.FIRST_PROBLEM_ID, problemTitle: p ? p.title : ('题目 ' + (s.problemId || store.FIRST_PROBLEM_ID)),
        username: s.username, name: s.name, std: s.std, ...(isAdminUser(me) ? { ip: s.ip } : {}), hidden: !!s.hidden, status: s.status, summary: s.summary,
        score: s.score != null ? s.score : (s.summary && s.summary.score != null ? s.summary.score : null),
        subtaskResults: canDetail ? (s.subtaskResults || []) : [],
        examId: s.examId || null, phase: s.phase || null,
        submittedAt: s.submittedAt, finishedAt: s.finishedAt,
        points: canDetail ? s.points : [], exPoints: canDetail ? (s.exPoints || []) : [], sampleResults: canDetail ? (s.sampleResults || []) : [],
        prevId: canDetail && prev ? prev.id : null,
        help: helpReq ? { id: helpReq.id, status: helpReq.status, note: helpReq.note || '', createdAt: helpReq.createdAt || 0, resolvedAt: helpReq.resolvedAt || null } : null,
        isOwn,
        inCurrentPeriod: isCurrentPeriodSubmission(s),
        canHelp,
        // AI 风险检测结果（仅管理员可见；未检测为 null）
        ...(isAdminUser(me) ? { aiReview: s.aiReview || null, aiBlocked: !!s.aiBlocked } : {}),
      });
    });
route('GET', '/api/admin/check', async (req, res, pathname) => {
      return sendJson(res, 200, { ok: isAdminUser(authUser(req)) });
    });
// AI 代码风险检测（需 config.json aiReview 启用；结果缓存进提交记录，force 重检）
route('POST', '/api/admin/ai-review', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      if (!aiReviewEnabled(store.CONFIG)) return sendJson(res, 400, { error: 'AI 风险检测未启用（在 config.json 配置 aiReview 后重启）' });
      const body = await readJson(req);
      const id = parseInt(body.submissionId, 10);
      const sub = store.submissions.find((s) => s.id === id);
      if (!sub) return sendJson(res, 404, { error: '提交不存在' });
      if (sub.aiReview && !body.force) return sendJson(res, 200, { ok: true, review: sub.aiReview, cached: true });
      if (!sub.codeFile) return sendJson(res, 404, { error: '代码文件不存在' });
      let code = '';
      try { code = fs.readFileSync(path.join(store.SUB_DIR, sub.codeFile), 'utf8'); } catch (e) { return sendJson(res, 404, { error: '代码文件不存在' }); }
      const r = await aiReviewCode(code, sub.std, store.CONFIG.aiReview);
      if (!r.ok) return sendJson(res, 502, { error: r.error });
      sub.aiReview = { risk: r.risk, categories: r.categories, summary: r.summary, model: r.model, at: Date.now() };
      store.saveIndex();
      store.appendLog(me, 'interact', '/api/admin/ai-review', 'AI 检测提交 #' + id + '：' + r.risk);
      return sendJson(res, 200, { ok: true, review: sub.aiReview });
    });
// 解除 AI 拦截：恢复可见性（不自动重评，管理员可再点重测）
route('POST', '/api/admin/ai-unblock', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const sub = store.submissions.find((s) => s.id === parseInt(body.submissionId, 10));
      if (!sub || !sub.aiBlocked) return sendJson(res, 404, { error: '没有该拦截记录' });
      sub.aiBlocked = false;
      sub.hidden = false;
      store.saveIndex();
      store.appendLog(me, 'interact', '/api/admin/ai-unblock', '解除拦截提交 #' + sub.id);
      return sendJson(res, 200, { ok: true });
    });
// AI 自动检测/拦截开关（运行期即时生效 + 写回 config.json 持久化；apiKey 等密钥不接受修改）
route('POST', '/api/admin/ai-settings', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const c = store.CONFIG.aiReview = store.CONFIG.aiReview || {};
      if (typeof body.autoCheck === 'boolean') c.autoCheck = body.autoCheck;
      if (typeof body.autoBlock === 'boolean') c.autoBlock = body.autoBlock;
      if (body.blockRisk !== undefined) {
        const v = String(body.blockRisk).toLowerCase();
        if (['high', 'medium'].indexOf(v) === -1) return sendJson(res, 400, { error: 'blockRisk 仅支持 high/medium' });
        c.blockRisk = v;
      }
      try {
        const cf = path.join(__dirname, 'config.json');
        const disk = JSON.parse(fs.readFileSync(cf, 'utf8'));
        disk.aiReview = Object.assign({}, disk.aiReview, { autoCheck: !!c.autoCheck, autoBlock: !!c.autoBlock, blockRisk: c.blockRisk || 'high' });
        fs.writeFileSync(cf, JSON.stringify(disk, null, 2));
        fs.chmodSync(cf, 0o600);
      } catch (e) { return sendJson(res, 500, { error: '配置已运行期生效，但写回 config.json 失败：' + e.message }); }
      store.appendLog(me, 'interact', '/api/admin/ai-settings', 'AI 自动检测=' + !!c.autoCheck + ' 自动拦截=' + !!c.autoBlock + ' 阈值=' + (c.blockRisk || 'high'));
      return sendJson(res, 200, { ok: true, autoCheck: !!c.autoCheck, autoBlock: !!c.autoBlock, blockRisk: c.blockRisk || 'high' });
    });
// 运行配置只读展示（P2：config.json 此前无任何管理界面）
route('GET', '/api/admin/config', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      return sendJson(res, 200, { config: {
        title: store.CONFIG.title || '', port: store.CONFIG.port,
        timeLimitSec: store.CONFIG.timeLimitSec, memLimitKb: store.CONFIG.memLimitKb,
        compileTimeoutMs: store.CONFIG.compileTimeoutMs, compilerPath: store.CONFIG.compilerPath || 'g++',
        maxParallel: store.CONFIG.maxParallel, maxPerUser: store.CONFIG.maxPerUser,
        examsEnabled: store.CONFIG.examsEnabled !== false,
        allowTestOutputDownload: store.CONFIG.allowTestOutputDownload === true,
        judgeUid: Number(store.CONFIG.judgeUid) || 0,
        judgeUidPool: Array.isArray(store.CONFIG.judgeUidPool) ? store.CONFIG.judgeUidPool.map(Number) : [],
        outputLimitKb: Number(store.CONFIG.outputLimitKb) || 64 * 1024,
        aiReviewEnabled: aiReviewEnabled(store.CONFIG), // 仅布尔，apiKey 永不下发
        aiAutoCheck: !!((store.CONFIG.aiReview || {}).autoCheck),
        aiAutoBlock: !!((store.CONFIG.aiReview || {}).autoBlock),
        aiBlockRisk: (store.CONFIG.aiReview || {}).blockRisk || 'high',
      } });
    });
// 全站公告（P2：此前只有题目级通知；存 noticesData['__global__']）
route('GET', '/api/notice', async (req, res, pathname) => {
      const nt = store.noticesData['__global__'];
      return sendJson(res, 200, { text: nt ? (nt.text || '') : '', createdAt: nt ? (nt.createdAt || 0) : 0 });
    });
// 说明页评测参数（公开只读，无敏感信息）
publicRoute('GET', '/api/judge-info', async (req, res, pathname) => {
      return sendJson(res, 200, {
        languages: ['C（gcc -std=c11）', 'C++14/17/20（g++ -std=c++14/17/20）', 'GNU++14/17/20（g++ -std=gnu++14/17/20，含 GNU 扩展）', 'Python3（解释执行，时空限制一致）'],
        compileFlags: '-O2 -lm -DONLINE_JUDGE',
        compileTimeoutSec: Math.round((Number(store.CONFIG.compileTimeoutMs) || 30000) / 1000),
        timeLimitSec: Number(store.CONFIG.timeLimitSec) || 1,
        memLimitMb: Math.round((Number(store.CONFIG.memLimitKb) || 262144) / 1024),
        outputLimitMb: Math.round((Number(store.CONFIG.outputLimitKb) || 65536) / 1024),
        maxParallel: MAX_PARALLEL,
        maxPerUser: MAX_PER_USER,
      });
    });
route('POST', '/api/admin/notice', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const text = String(body.text || '').trim().slice(0, 500);
      if (text) store.noticesData['__global__'] = { text, createdAt: Date.now(), readBy: [] };
      else delete store.noticesData['__global__'];
      store.saveNotices();
      return sendJson(res, 200, { ok: true, text });
    });
route('GET', /^\/api\/sample\/\d+$/, async (req, res, pathname) => {
      const id = parseInt(pathname.split('/')[3], 10);
      const q = getQuery(req);
      const sub = store.submissions.find((s) => s.id === id);
      if (!sub) return sendJson(res, 404, { error: '提交不存在' });
      if (!canViewCode(sub, authUser(req))) {
        return sendJson(res, 403, { error: '无权查看该样例详情' });
      }
      const problem = store.getProblem(sub.problemId);
      if (!problem) return sendJson(res, 400, { error: '题目不存在' });
      const sid = q.sid || '1';
      const sp = (problem.samples || []).find((x) => String(x.id) === String(sid));
      if (!sp) return sendJson(res, 404, { error: '样例不存在' });
      let input = '', expected = '';
      try { input = fs.readFileSync(sp.input, 'utf8'); } catch (e) {}
      try { expected = fs.readFileSync(sp.output, 'utf8'); } catch (e) {}
      const sr = (sub.sampleResults || []).find((x) => String(x.id) === String(sid));
      const actual = (sr && sr.out) || '';
      return sendJson(res, 200, { id: sid, verdict: sr ? sr.verdict : '', input, expected, actual, hint: (sr && sr.hint) || '' });
    });
route('GET', /^\/api\/excase\/\d+$/, async (req, res, pathname) => {
      // Ex 数据（hack 数据）下载：内容可能很长，不在页面内联展示，只支持下载
      const id = parseInt(pathname.split('/')[3], 10);
      const q = getQuery(req);
      const me = authUser(req);
      const sub = store.submissions.find((s) => s.id === id);
      if (!sub) return sendJson(res, 404, { error: '提交不存在' });
      if (sub.hidden && !isAdminUser(me)) return sendJson(res, 404, { error: '提交不存在' });
      if (!canViewCode(sub, me)) {
        return sendJson(res, 403, { error: '无权下载该 Ex 测试数据' });
      }
      const problem = store.getProblem(sub.problemId);
      if (!problem || !problem.exTests || !problem.exTests.length) return sendJson(res, 400, { error: '该题没有 Ex 附加点' });
      const eid = q.exid || 'ex1';
      const ep = problem.exTests.find((x) => String(x.id) === String(eid));
      if (!ep) return sendJson(res, 404, { error: 'Ex 测试点不存在' });
      const type = String(q.type || 'in'); // in（默认）/ out（期望输出）/ actual（用户输出）
      if (type === 'actual') {
        if (!isAdminUser(me) && me.id !== sub.uid) return sendJson(res, 403, { error: '仅提交者本人或管理员可下载该输出' });
        const er = (sub.exPoints || []).find((x) => String(x.id) === String(eid));
        if (!er || er.out == null) return sendJson(res, 404, { error: '没有该 Ex 点的输出记录' });
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${eid}.user.out"`,
        });
        return res.end(er.out);
      }
      const dataFile = type === 'out' ? ep.expected : ep.input;
      if (!dataFile || !fs.existsSync(dataFile)) return sendJson(res, 404, { error: 'Ex 数据文件不存在' });
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${eid}.${type === 'out' ? 'out' : 'in'}"`,
      });
      return res.end(fs.readFileSync(dataFile));
    });
route('GET', /^\/api\/testcase\/\d+$/, async (req, res, pathname) => {
      const id = parseInt(pathname.split('/')[3], 10);
      const q = getQuery(req);
      const me = authUser(req);
      const sub = store.submissions.find((s) => s.id === id);
      if (!sub) return sendJson(res, 404, { error: '提交不存在' });
      if (!canViewCode(sub, me)) {
        return sendJson(res, 403, { error: '无权下载该测试数据' });
      }
      const wantOut = q.type === 'out'; // ?type=out 下载标准输出，默认下载输入
      if (wantOut && !isAdminUser(me) && store.CONFIG.allowTestOutputDownload !== true) {
        return sendForbidden(res, '管理员未开启「允许下载测试点输出」'); // 防套出官方隐藏答案
      }
      const problem = store.getProblem(sub.problemId);
      if (!sub.points || !sub.points.length || !problem) return sendJson(res, 400, { error: '该提交没有可下载的错误数据' });
      if (sub.summary && sub.summary.verdict === 'CE') {
        return sendJson(res, 400, { error: '编译错误（CE），不提供数据下载' });
      }
      const bad = sub.points.find((p) => p.verdict !== 'AC');
      if (!bad) return sendJson(res, 400, { error: '该提交全部通过（AC），没有错误数据' });
      const dataFile = path.join(path.dirname(problem.descriptionFile), 'data', bad.id + (wantOut ? '.out' : '.in'));
      if (!fs.existsSync(dataFile)) return sendJson(res, 404, { error: '测试数据文件不存在' });
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${sub.problemId}-test-${bad.id}.${wantOut ? 'out' : 'in'}"`,
      });
      return res.end(fs.readFileSync(dataFile));
    });
route('GET', /^\/api\/code\/\d+$/, async (req, res, pathname) => {      const id = parseInt(pathname.split('/')[3], 10);
      const q = getQuery(req);
      const sub = store.submissions.find((s) => s.id === id);
      if (!sub) return sendJson(res, 404, { error: '提交不存在' });
      if (!canViewCode(sub, authUser(req))) {
        return sendJson(res, 403, { error: '无权查看该代码：管理员可查看全部；自己的代码可随时查看；通过(AC)后可查看他人的 AC 代码' });
      }
      const code = fs.readFileSync(path.join(store.SUB_DIR, sub.codeFile), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
      return res.end(code);
    });
route('GET', '/api/problem', async (req, res, pathname) => {
      const q = getQuery(req);
      const pid = parseInt(q.id, 10) || (store.PROBLEMS.length ? store.PROBLEMS[0].id : store.FIRST_PROBLEM_ID);
      const problem = store.getProblem(pid);
      const isAdm = isAdminUser(authUser(req));
      // 隐藏的模考题：所属模考进行中或已公布成绩后对学生可见（考试/订正需要打开题目页）
      {
        const nowTs = Date.now();
        if (!problem || (problem.hidden && !isAdm && !examAccessForProblem(pid, nowTs))) return sendJson(res, 404, { error: '题目不存在' });
      }
      let sampleInput = '', sampleOutput = '', solutionHtml = '', solutionText = '', samples = [];
      if (problem.samples && problem.samples.length) {
        for (const sp of problem.samples) {
          try {
            samples.push({ id: sp.id, input: fs.readFileSync(sp.input, 'utf8'), output: fs.readFileSync(sp.output, 'utf8') });
          } catch (e) { /* ignore */ }
        }
      }
      if (problem.hasSample) {
        try { sampleInput = fs.readFileSync(problem.sampleIn, 'utf8'); } catch (e) { /* ignore */ }
        try { sampleOutput = fs.readFileSync(problem.sampleOut, 'utf8'); } catch (e) { /* ignore */ }
      }
      // 做法/题解/参考代码可见性开关（老题无字段 → 默认开放；新题 assemble 写入 false）
      const approachOpen = isAdm || problem.approachOpen !== false;
      const solutionOpen = isAdm || problem.solutionOpen !== false;
      const referenceOpen = isAdm || problem.referenceOpen !== false;
      // 题解/参考代码多份（solution.json / reference.json 列表，兼容旧格式）
      const sols = (solutionOpen ? store.loadSolutions(problem) : []).map((s) => ({ name: s.name, content: s.content, html: renderMarkdown(s.content) }));
      const refs = referenceOpen ? store.loadReferences(problem) : [];
      if (sols.length) { solutionHtml = sols[0].html; solutionText = sols[0].content; }
      let descText = '';
      try { descText = fs.readFileSync(problem.descriptionFile, 'utf8'); } catch (e) { /* ignore */ }
      // 题面 HTML：做法开关关闭时剥离「## 做法」板块（管理员始终可见）
      let html;
      if (approachOpen) {
        html = renderProblem(problem);
      } else {
        html = renderMarkdown(descText.replace(/##\s*做法\s*\r?\n[\s\S]*?(?=\n##\s|$)/, ''));
      }
      // 模考信息：所属的最近一场/正在进行的模考（用于题目页横幅与提交归属提示）；examsEnabled=false 时不返回
      let examInfo = null;
      if (store.CONFIG.examsEnabled !== false) {
        const now = Date.now();
        const cands = store.exams.filter((e) => (e.problemIds || []).indexOf(problem.id) !== -1);
        const running = cands.filter((e) => e.startAt <= now && now <= e.endAt).sort((a, b) => a.startAt - b.startAt)[0];
        const recent = cands.filter((e) => e.endAt <= now).sort((a, b) => b.endAt - a.endAt)[0];
        const ex = running || recent;
        if (ex) {
          const st = examStatus(ex, now);
          examInfo = { id: ex.id, name: ex.name, startAt: ex.startAt, endAt: ex.endAt, publishAt: ex.publishAt, status: st.status, published: st.published, hideVerdict: !!ex.hideVerdict };
        }
      }
      return sendJson(res, 200, {
        id: problem.id, title: problem.title, html, judgeable: problem.judgeable,
        testCount: problem.tests.length, timeLimitSec: problem.timeLimitSec, memLimitKb: problem.memLimitKb,
        sampleInput, sampleOutput, samples, solutionHtml, solutionText, descriptionText: descText, hidden: !!problem.hidden,
        approachOpen, solutionOpen, referenceOpen,
        reference: referenceOpen ? store.loadReference(problem) : {},
        solutions: sols,
        references: refs,
        tags: problem.tags || [],
        fileIO: problem.fileIO || null, // 传统文件读写配置（编辑表单需要）
        scoring: problem.scoring, // 评分规则（子任务部分分配置；point 模式 subtasks 为空）
        examInfo,
      });
    });
// 我的错题本：聚合当前用户全部提交 → 每题最高分/最近提交（用于考后订正）
route('GET', '/api/myproblems', async (req, res, pathname) => {
      const me = authUser(req);
      if (!me) return sendUnauthorized(res);
      const isAdm = isAdminUser(me);
      // 【安全修复 2026-08】hideVerdict 第三处绕过封堵：错题本此前未过滤模考成绩隐藏，
      // 考试未公布时学生可经 /wrong.html 看到自己各模考题的得分/判定；封榜口径与 /api/status 对齐
      const freezeSt = contestFreezeState(me);
      const verdictHiddenSub = (s) => {
        const ex = s.examId ? store.exams.find((e) => e.id === s.examId) : null;
        return !!(ex && ex.hideVerdict && Date.now() < ex.publishAt && !isAdm);
      };
      const mine = store.submissions.filter((s) => !s.hidden && (s.uid === me.id || (!s.uid && s.username === me.username)));
      const agg = {};
      for (const s of mine) {
        const pid = s.problemId || store.FIRST_PROBLEM_ID;
        const a = agg[pid] || (agg[pid] = { pid, tries: 0, score: -1, verdict: '', lastAt: 0, lastSubId: 0 });
        a.tries++;
        if (verdictHiddenSub(s) || freezeHidesSub(s, freezeSt)) continue; // 成绩未公布/封榜期：计入尝试但不计分不显示判定
        let sc = null;
        if (s.status === 'done' && s.summary) {
          sc = typeof s.summary.score === 'number' ? s.summary.score : null;
          // 无 score 字段的极端兜底：按判定给分（AC=100），绝不能用不存在的 ac/total 字段算出幽灵 0 分
          if (sc == null && s.summary.verdict === 'AC') sc = 100;
          if (sc == null && s.summary.verdict && s.summary.verdict !== 'SE') sc = 0;
        }
        if (sc == null && typeof s.score === 'number') sc = s.score;
        if (sc != null && sc > a.score) { a.score = sc; a.verdict = s.summary ? s.summary.verdict : ''; }
        if (s.submittedAt && s.submittedAt > a.lastAt) { a.lastAt = s.submittedAt; a.lastSubId = s.id; }
      }
      const rows = [];
      for (const pid of Object.keys(agg)) {
        const a = agg[pid];
        const p = store.getProblem(parseInt(pid, 10));
        if (!p || (p.hidden && !isAdm)) continue;
        rows.push({
          id: p.id, title: p.title, tags: p.tags || [], judgeable: p.judgeable,
          bestScore: a.score < 0 ? null : a.score, verdict: a.verdict, ac: a.score >= 100,
          tries: a.tries, lastAt: a.lastAt || null, lastSubId: a.lastSubId || null,
        });
      }
      rows.sort((x, y) => (y.lastAt || 0) - (x.lastAt || 0));
      return sendJson(res, 200, { problems: rows });
    });
route('GET', '/api/rank', async (req, res, pathname) => {
      // 排行榜：只统计管理员开启排行的题目；得分默认满分 100，按测试点均分；
      // 提交次数统计到 AC 为止（AC 后不再增加）；同分时早完成（AC）在前。
      const q = getQuery(req);
      // 期次：0=最新（rankEnabled 题 + 星标 txt 作业），≥1=历史期（该期 order + homeworkIds）
      const sid2 = parseInt(q.session, 10);
      const sel2 = Number.isInteger(sid2) && sid2 > 0 ? sid2 : 0;
      // H1：封榜期榜单冻结（匿名/学生视角一致）；封榜状态随时间变化，用 10s 时间桶并入缓存 key 防止读到过期冻结态
      const freezeSt = contestFreezeState(null);
      const freezeBucket = (store.contest && store.contest.startAt && store.contest.endAt) ? Math.floor(Date.now() / 10000) : 0;
      // 排行榜聚合缓存：key=（期次|排序字段|方向|封榜时间桶），store.dataVersion 变化即失效重算
      const _ck = sel2 + '|' + String(q.sort || 'score') + '|' + String(q.dir || '') + '|f' + (freezeSt.frozen ? freezeSt.freezeStart : 0) + '_' + freezeBucket;
      if (store.rankCache.key === _ck && store.rankCache.ver === store.dataVersion) {
        return sendJson(res, 200, store.rankCache.payload);
      }
      let rankProbs, rankHws, rankOrder, rankStars2;
      if (sel2 === 0) {
        rankOrder = store.hwData.programmingOrder || [];
        rankStars2 = store.hwData.programmingStars || [];
        rankProbs = store.PROBLEMS.filter((p) => p.judgeable && rankOrder.indexOf(p.id) !== -1 && !p.hidden);
        // 当前期文本作业列 = 未被任何历史期归档的文本作业（与作业页一致）
        const arch = {};
        for (const s of (store.hwData.sessions || [])) for (const hid of (s.homeworkIds || [])) arch[hid] = true;
        rankHws = store.hwData.homeworks.filter((h) => !h.hidden && !arch[h.id]);
      } else {
        const s = (store.hwData.sessions || [])[sel2 - 1];
        if (!s) return sendJson(res, 404, { error: '作业期次不存在' });
        rankOrder = s.order || [];
        rankStars2 = s.stars || [];
        const pIds = {}; for (const pid of rankOrder) pIds[pid] = true;
        const hIds = {}; for (const hid of (s.homeworkIds || [])) hIds[hid] = true;
        rankProbs = store.PROBLEMS.filter((p) => p.judgeable && !p.hidden && pIds[p.id]);
        rankHws = store.hwData.homeworks.filter((h) => !h.hidden && hIds[h.id]);
      }
      const rankHwsList = rankHws.map((h) => ({ id: h.id, title: h.title, fullScore: 100 }));
      // 管理员（教师）不参与排行榜
      const adminIds = {}, adminNames = {};
      for (const u of store.users) {
        if (u.role === 'admin' || u.role === 'superadmin') { adminIds[u.id] = true; adminNames[u.username] = true; }
      }
      // 题目列顺序跟随所选期次的「编程作业」顺序（未设置的按题号排在末尾）
      {
        const orderMap = {};
        rankOrder.forEach((id, i) => { orderMap[id] = i; });
        rankProbs.sort((a, b) => {
          const ia = orderMap[a.id] !== undefined ? orderMap[a.id] : 1e9;
          const ib = orderMap[b.id] !== undefined ? orderMap[b.id] : 1e9;
          return (ia - ib) || (a.id - b.id);
        });
      }
      const rankIds = {};
      for (const p of rankProbs) rankIds[p.id] = p;
      const sortKey = String(q.sort || 'score');
      const dir = String(q.dir || '') === 'asc' ? 1 : -1; // 默认 desc
      const agg = {};
      for (const sb of store.submissions) {
        if (sb.hidden) continue;
        if (freezeHidesSub(sb, freezeSt)) continue; // H1：封榜期内窗口内提交不计入榜单（防实时成绩泄露）
        if (sb.examId && store.exams.some((e) => e.id === sb.examId)) continue; // 模考提交（考试 + 订正）不计入普通排行榜
        if ((sb.uid && adminIds[sb.uid]) || (!sb.uid && sb.username && adminNames[sb.username])) continue; // 管理员不计入排行
        const pid = sb.problemId || store.FIRST_PROBLEM_ID;
        const prob = rankIds[pid];
        if (!prob) continue;
        const key = sb.uid ? 'u' + sb.uid : (sb.username ? 'n' + sb.username : (sb.ip ? 'i' + sb.ip : '?'));
        if (!agg[key]) agg[key] = { username: sb.username || sb.name || '?', fullname: sb.name || '', problems: {} };
        const pr = agg[key].problems;
        if (!pr[pid]) pr[pid] = { best: 0, tries: 0, ac: false, acTime: 0, score: 0, exPassed: false };
        const pt = pr[pid];
        const fullCnt = prob.tests.length; // 正式点数（Ex 点不计分）
        const acCnt = (sb.points || []).filter((p) => p.verdict === 'AC' && !isExPointId(p.id)).length;
        // 得分：新提交直接带 score（子任务部分分 / 按点均分）；旧记录回退按 AC 点数均分
        const sc = (sb.score != null && sb.score >= 0) ? sb.score : (fullCnt > 0 ? Math.round(100 * acCnt / fullCnt) : 0);
        const isFull = fullCnt > 0 && sc >= 100;
        if (!pt.ac) {
          pt.tries++;
          if (isFull) { pt.ac = true; pt.acTime = sb.submittedAt || 0; }
        }
        if (sc > pt.best) pt.best = sc;
        // Ex 附加点：仅当「正式点满分」且 Ex 全 AC 才记通过
        if (isFull) {
          const hasEx = (prob.exTests || []).length > 0;
          let exAllAc;
          if (!hasEx) exAllAc = true;
          else {
            const exPts = sb.exPoints || [];
            exAllAc = exPts.length ? exPts.every((p) => p.verdict === 'AC') : false;
          }
          if (exAllAc) pt.exPassed = true;
        }
      }
      // 用户key → 该用户在所选期次 txt 作业上的得分
      // txt 作业得分：该学生最新提交的已评分分数（pending 视为 0）
      const hwScore = {};
      const hwInfo = {};
      const rankHwIds2 = {};
      for (const hw of rankHws) rankHwIds2[hw.id] = true;
      for (const a of store.hwData.answers) {
        if (!rankHwIds2[a.homeworkId]) continue;
        const k = a.uid ? 'u' + a.uid : (a.username ? 'n' + a.username : null);
        if (!k) continue;
        const prev = hwScore[k] ? hwScore[k][a.homeworkId] : undefined;
        // answers 按提交时间升序（push 顺序），取最新一条
        if (a.gradeStatus === 'graded' && a.score != null) {
          if (!hwScore[k]) hwScore[k] = {};
          hwScore[k][a.homeworkId] = a.score;
        } else {
          if (!hwScore[k]) hwScore[k] = {};
          hwScore[k][a.homeworkId] = 0;   // 待审核：重新提交后旧分作废，未评分不计分
        }
        hwInfo[k] = { username: a.username || '?', fullname: a.name || '' };
      }
      // 候选行：有编程提交的用户 ∪ 有星标作业已评分/提交的用户（纯交作业者也上榜）
      const rowKeys = new Set(Object.keys(agg));
      for (const k of Object.keys(hwScore)) rowKeys.add(k);
      const rows = Array.from(rowKeys).map((k) => {
        const u = agg[k] || { username: (hwInfo[k] || {}).username || '?', fullname: (hwInfo[k] || {}).fullname || '', problems: {} };
        let total = 0, lastAc = 0, anyAc = false;
        for (const pid in u.problems) {
          const pt = u.problems[pid];
          pt.score = pt.best; // 0~100（子任务部分分或按点均分）
          // Ex 星标：满分但未通过 Ex 数据
          const hasEx = rankIds[pid] ? (rankIds[pid].exTests || []).length > 0 : false;
          pt.exStar = pt.score === 100 && hasEx && !pt.exPassed;
          total += pt.score;
          if (pt.ac) { anyAc = true; if (pt.acTime > lastAc) lastAc = pt.acTime; }
        }
        // txt 作业：教师打分数（pending=0）
        const hwScores = {};
        const sc = hwScore[k] || {};
        for (const hw of rankHws) {
          const s = sc[hw.id] || 0;
          hwScores[hw.id] = { score: s };
          if (s > 0) { total += s; anyAc = true; }
        }
        return { username: u.username, fullname: u.fullname, total, doneTime: anyAc ? lastAc : Infinity, problems: u.problems, homeworks: hwScores };
      }).filter((r) => r.fullname !== '匿名'); // 有提交即参与排行榜，0 分也显示；姓名为「匿名」的不参与排名
      // 排序：score=总分(默认 desc，同分早完成在前)；其他关键字 asc/desc
      let cmp;
      if (sortKey === 'score') {
        cmp = (a, b) => (b.total - a.total) || (a.doneTime - b.doneTime) || (a.username < b.username ? -1 : a.username > b.username ? 1 : 0);
      } else if (sortKey === 'user') {
        cmp = (a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0);
      } else if (sortKey === 'name') {
        cmp = (a, b) => (a.fullname < b.fullname ? -1 : a.fullname > b.fullname ? 1 : 0);
      } else if (sortKey.indexOf('p') === 0) {
        const pid = parseInt(sortKey.slice(1), 10);
        cmp = (a, b) => ((a.problems[pid] ? a.problems[pid].score : 0) - (b.problems[pid] ? b.problems[pid].score : 0));
      } else if (sortKey.indexOf('h') === 0) {
        const hid = parseInt(sortKey.slice(1), 10);
        cmp = (a, b) => ((a.homeworks && a.homeworks[hid] ? a.homeworks[hid].score : 0) - (b.homeworks && b.homeworks[hid] ? b.homeworks[hid].score : 0));
      } else {
        cmp = (a, b) => (b.total - a.total) || (a.doneTime - b.doneTime);
      }
      rows.sort(cmp);
      if (sortKey !== 'score' && dir === -1) rows.reverse();
      // 排名不并列：同分按排序顺序连续排名（默认规则下同分时最早达到该分数的在前）
      for (let i = 0; i < rows.length; i++) rows[i].rank = i + 1;
      const sessList = [{ id: 0, name: store.hwData.currentSessionName || '最新作业' }]
        .concat((store.hwData.sessions || []).map((s, i) => ({ id: i + 1, name: s.name })));
      store.rankCache = {
        key: _ck,
        ver: store.dataVersion,
        payload: { sessions: sessList, session: sel2, rows, problems: rankProbs.map((p) => ({ id: p.id, title: p.title, testCount: p.tests.length, fullScore: 100, star: rankStars2.indexOf(p.id) !== -1 })), homeworkCols: rankHwsList },
      };
      return sendJson(res, 200, store.rankCache.payload);
    });
// 学生发起代码求助（仅当前期次内自己的提交）
route('POST', '/api/help/request', async (req, res, pathname) => {
      const me = authUser(req);
      if (!me) return sendUnauthorized(res);
      const body = await readJson(req);
      const submissionId = parseInt(body.submissionId, 10);
      if (!Number.isInteger(submissionId) || submissionId <= 0) return sendJson(res, 400, { error: '提交编号无效' });
      const sub = store.submissions.find((s) => s.id === submissionId);
      if (!sub || (sub.hidden && !isAdminUser(me))) return sendJson(res, 404, { error: '提交不存在' });
      const isOwn = (sub.uid && sub.uid === me.id) || (!sub.uid && sub.username && sub.username === me.username);
      if (!isOwn) return sendForbidden(res, '只能求助自己的提交');
      if (!isCurrentPeriodSubmission(sub)) return sendJson(res, 400, { error: '只能对当前期次的题目提交发起求助' });
      if (store.helpRequests.some((r) => r.submissionId === submissionId && r.status === 'open')) {
        return sendJson(res, 400, { error: '该提交已发起求助，请等待教师处理' });
      }
      const id = (store.helpRequests.length ? Math.max(...store.helpRequests.map((r) => r.id)) : 0) + 1;
      const p = store.getProblem(sub.problemId);
      store.helpRequests.push({
        id, submissionId, uid: me.id, username: me.username, fullname: me.fullname || '',
        problemId: sub.problemId, problemTitle: p ? p.title : '', note: String(body.note || '').trim().slice(0, 500),
        status: 'open', createdAt: Date.now(), resolvedAt: null, resolvedBy: null,
      });
      store.saveHelpRequests();
      store.appendLog(me, 'interact', '/api/help/request', '提交 #' + submissionId + ' 发起代码求助');
      return sendJson(res, 200, { ok: true, id });
    });
// 教师查看求助列表（open 优先；?status=open|done 过滤；?withCode=1 附带代码全文）
route('GET', '/api/help', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const q = getQuery(req);
      let list = store.helpRequests.slice().sort((a, b) => {
        const sa = a.status === 'open' ? 0 : 1, sb = b.status === 'open' ? 0 : 1;
        return (sa - sb) || (b.createdAt - a.createdAt);
      });
      if (q.status === 'open') list = list.filter((r) => r.status === 'open');
      else if (q.status === 'done') list = list.filter((r) => r.status === 'done');
      return sendJson(res, 200, {
        list: list.map((r) => helpRequestView(r, q.withCode === '1')),
        openCount: store.helpRequests.filter((r) => r.status === 'open').length,
      });
    });
// 教师端未处理求助数量（红点提醒用，轻量接口）
route('GET', '/api/help/count', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      return sendJson(res, 200, { openCount: store.helpRequests.filter((r) => r.status === 'open').length });
    });
// 教师标记求助已处理（公屏/列表不再展示该代码）
route('POST', '/api/admin/help/resolve', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const r = store.helpRequests.find((x) => x.id === parseInt(body.id, 10));
      if (!r) return sendJson(res, 404, { error: '求助不存在' });
      if (r.status !== 'open') return sendJson(res, 400, { error: '该求助已处理' });
      r.status = 'done';
      r.resolvedAt = Date.now();
      r.resolvedBy = me.username;
      store.saveHelpRequests();
      store.appendLog(me, 'interact', '/api/admin/help/resolve', '处理求助 #' + r.id + '（提交 #' + r.submissionId + '）');
      return sendJson(res, 200, { ok: true });
    });
// 用户提交 Bug 反馈（登录即可；10 分钟最多 3 条防刷）
route('POST', '/api/bugreport', async (req, res, pathname) => {
      const me = authUser(req);
      if (!me) return sendUnauthorized(res);
      const body = await readJson(req);
      const text = String(body.text || '').trim();
      if (!text) return sendJson(res, 400, { error: '反馈内容不能为空' });
      if (text.length > 1000) return sendJson(res, 400, { error: '反馈内容过长（最多 1000 字）' });
      const recent = store.bugReports.filter((r) => r.uid === me.id && r.createdAt > Date.now() - 10 * 60 * 1000);
      if (recent.length >= 3) return sendJson(res, 429, { error: '提交太频繁，请 10 分钟后再试' });
      const id = (store.bugReports.length ? Math.max(...store.bugReports.map((r) => r.id)) : 0) + 1;
      store.bugReports.push({
        id, uid: me.id, username: me.username, fullname: me.fullname || '',
        text, page: String(body.page || '').slice(0, 200),
        status: 'open', createdAt: Date.now(), resolvedAt: null, resolvedBy: null,
      });
      store.saveBugReports();
      store.appendLog(me, 'interact', '/api/bugreport', '提交 Bug 反馈 #' + id);
      return sendJson(res, 200, { ok: true, id });
    });
// 管理员查看反馈列表（open 优先；?status=open|done 过滤）
route('GET', '/api/admin/bugreports', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const q = getQuery(req);
      let list = store.bugReports.slice().sort((a, b) => {
        const sa = a.status === 'open' ? 0 : 1, sb = b.status === 'open' ? 0 : 1;
        return (sa - sb) || (b.createdAt - a.createdAt);
      });
      if (q.status === 'open') list = list.filter((r) => r.status === 'open');
      else if (q.status === 'done') list = list.filter((r) => r.status === 'done');
      return sendJson(res, 200, {
        list,
        openCount: store.bugReports.filter((r) => r.status === 'open').length,
      });
    });
// 管理员端未处理反馈数量（红点提醒用，轻量接口）
route('GET', '/api/admin/bugreports/count', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      return sendJson(res, 200, { openCount: store.bugReports.filter((r) => r.status === 'open').length });
    });
// 管理员标记反馈已处理
route('POST', '/api/admin/bugreport/resolve', async (req, res, pathname) => {
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const body = await readJson(req);
      const r = store.bugReports.find((x) => x.id === parseInt(body.id, 10));
      if (!r) return sendJson(res, 404, { error: '反馈不存在' });
      if (r.status !== 'open') return sendJson(res, 400, { error: '该反馈已处理' });
      r.status = 'done';
      r.resolvedAt = Date.now();
      r.resolvedBy = me.username;
      store.saveBugReports();
      store.appendLog(me, 'interact', '/api/admin/bugreport/resolve', '处理反馈 #' + r.id);
      return sendJson(res, 200, { ok: true });
    });
route('GET', '/api/problems', async (req, res, pathname) => {
      const me2 = authUser(req);
      const visibleP = store.PROBLEMS.filter((p) => isAdminUser(me2) || !p.hidden);
      if (store.problemsStatsCache.ver !== store.dataVersion) {
        const stats = {};
        for (const sb of store.submissions) {
          if (sb.hidden) continue; // 隐藏提交不计入 过题/尝试 统计
          const pid = sb.problemId || store.FIRST_PROBLEM_ID;
          if (!stats[pid]) stats[pid] = { ac: {}, tried: {} };
          const key = sb.uid ? ('u' + sb.uid) : (sb.username ? ('n' + sb.username) : (sb.ip ? ('i' + sb.ip) : '?'));
          stats[pid].tried[key] = 1;
          if (sb.summary && sb.summary.verdict === 'AC') stats[pid].ac[key] = 1;
        }
        const cached = {};
        for (const pid of Object.keys(stats)) cached[pid] = { ac: Object.keys(stats[pid].ac).length, tried: Object.keys(stats[pid].tried).length };
        store.problemsStatsCache = { ver: store.dataVersion, data: cached };
      }
      return sendJson(res, 200, { problems: visibleP.map((p) => {
        const st = store.problemsStatsCache.data[p.id] || { ac: 0, tried: 0 };
        return { id: p.id, title: p.title, tags: p.tags || [], testCount: p.tests.length, judgeable: p.judgeable, hidden: p.hidden, rankEnabled: p.rankEnabled, timeLimitSec: p.timeLimitSec, memLimitKb: p.memLimitKb, owner: p.owner || '', acCount: st.ac, triedCount: st.tried };
      }) });
    });
route('GET', '/api/admin/stats', async (req, res, pathname) => {
      // 题目统计（教师）：错误分布 + 通过率 + 平均尝试次数（当前期次或指定题）
      const me = authUser(req);
      if (!isAdminUser(me)) return sendForbidden(res, '需要管理员权限');
      const q = getQuery(req);
      const pid = parseInt(q.problemId, 10) || 0;
      const order = store.hwData.programmingOrder || [];
      const targetIds = pid ? [pid] : order;
      const problems = targetIds.map((id) => {
        const prob = store.getProblem(id);
        if (!prob) return null;
        const subs = store.submissions.filter((s) => s.problemId === id && s.status === 'done' && !s.hidden);
        const acUsers = new Set(), triedUsers = new Set();
        const verdictCounts = {};
        for (const s of subs) {
          const key = s.uid != null ? s.uid : (s.username || s.ip || '?');
          triedUsers.add(key);
          const v = (s.summary && s.summary.verdict) || '?';
          verdictCounts[v] = (verdictCounts[v] || 0) + 1;
          if (v === 'AC') acUsers.add(key);
        }
        return {
          id, title: prob.title,
          acCount: acUsers.size, triedCount: triedUsers.size, totalCount: subs.length,
          verdictCounts,
          avgTries: triedUsers.size ? Math.round((subs.length / triedUsers.size) * 10) / 10 : 0,
        };
      }).filter(Boolean);
      return sendJson(res, 200, { problems });
    });
route('GET', '/api/board', async (req, res, pathname) => {
      // 课堂大屏（投影）：仅管理员可查看（含学生姓名/提交动态，不公开）
      if (!isAdminUser(authUser(req))) return sendForbidden(res, '仅管理员可访问课堂大屏');
      // 与排行榜一致：管理员（教师）不计入统计、不参与提交流
      const order = store.hwData.programmingOrder || [];
      const stars = store.hwData.programmingStars || [];
      const adminIds = {}, adminNames = {};
      for (const u of store.users) {
        if (u.role === 'admin' || u.role === 'superadmin') { adminIds[u.id] = true; adminNames[u.username] = true; }
      }
      const isAdminSub = (s) => (s.uid && adminIds[s.uid]) || (!s.uid && s.username && adminNames[s.username]);
      const problems = [];
      const participantSet = new Set(); // 当前期次有提交的非管理员用户（参赛人数）
      for (const id of order) {
        const prob = store.getProblem(id);
        if (!prob || prob.hidden) continue;
        const subs = store.submissions.filter((s) => s.problemId === id && !s.hidden && !isAdminSub(s));
        const acUsers = new Set(), triedUsers = new Set();
        let submitCount = 0, judging = 0;
        for (const s of subs) {
          submitCount++; // 评测条数（所有提交，含评测中）
          if (s.status === 'judging' || s.status === 'queued') judging++;
          const key = s.uid != null ? s.uid : (s.username || s.ip || '?');
          triedUsers.add(key);
          participantSet.add(key);
          if (s.status === 'done' && s.summary && s.summary.verdict === 'AC') acUsers.add(key);
        }
        problems.push({ id, title: prob.title, star: stars.indexOf(id) !== -1, acCount: acUsers.size, triedCount: triedUsers.size, submitCount, judging });
      }
      // 最近提交（含评测中，排除管理员），按提交时间倒序，供大屏实时跟踪
      const recentSubs = store.submissions
        .filter((s) => order.indexOf(s.problemId) !== -1 && !s.hidden && !isAdminSub(s))
        .sort((a, b) => b.submittedAt - a.submittedAt)
        .slice(0, 25)
        .map((s) => {
          const p = store.getProblem(s.problemId);
          return {
            id: s.id, username: s.username || '', name: s.name || '', problemId: s.problemId,
            status: s.status, verdict: s.summary ? s.summary.verdict : '',
            judgedCount: s.status === 'judging' && s.points ? s.points.length : 0,
            totalTests: p ? p.tests.length : 0,
            submittedAt: s.submittedAt,
          };
        });
      // 参赛人数：当前期次有提交的用户数（去重，排除管理员）
      const participantCount = participantSet.size;
      // 未处理的代码求助：只展示当前期次内的；大屏需保持显示，直到教师标记已处理
      const currentOrder = store.hwData.programmingOrder || [];
      const helpRequests = store.helpRequests
        .filter((r) => r.status === 'open' && currentOrder.indexOf(r.problemId) !== -1)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 20)
        .map((r) => helpRequestView(r, true));
      return sendJson(res, 200, { sessionName: store.hwData.currentSessionName || '最新作业', participantCount, problems, recentSubs, helpRequests, now: Date.now() });
    });
publicRoute('POST', '/api/auth/register', async (req, res, pathname) => {
      const body = await readJson(req);
      if (!regThrottle(reqIp(req))) return sendJson(res, 429, { error: '注册过于频繁，请稍后再试' });
      const username = String(body.username || '').trim().toLowerCase().slice(0, 30);
      const fullname = String(body.fullname || '').trim().slice(0, 30);
      const password = String(body.password || '');
      if (!/^[a-z][a-z0-9_]{1,15}$/.test(username)) return sendJson(res, 400, { error: '用户名须以字母开头，2-16 位字母/数字/下划线' });
      if (!/[\u4e00-\u9fa5]/.test(fullname) || fullname.length < 2) return sendJson(res, 400, { error: '姓名请填写真实中文姓名（实名制）' });
      if (password.length < 7) return sendJson(res, 400, { error: '密码至少 7 位' });
      if (store.users.some((u) => u.username === username)) {
        // E：用户名枚举防护——「已占用」与通用失败提示不可区分；真实原因只记服务端日志
        store.appendLog(null, 'register-duplicate', '/api/auth/register', '用户名已被占用: ' + username);
        return sendJson(res, 400, { error: '注册失败：请检查用户名、姓名与密码是否符合要求；如已注册过请联系管理员' });
      }
      const salt = crypto.randomBytes(8).toString('hex');
      store.users.push({ id: store.users.length ? Math.max(...store.users.map((u) => u.id)) + 1 : 1, username, fullname, role: 'user', status: 'pending', salt, passwordHash: store.hashPw(password, salt), createdAt: Date.now() });
      store.saveUsers();
      return sendJson(res, 200, { ok: true, message: '注册成功，请等待管理员审核后登录' });
    });
publicRoute('POST', '/api/auth/change-password', async (req, res, pathname) => {
      const me = authUserForced(req);
      if (!me) return sendUnauthorized(res);
      const body = await readJson(req);
      const oldPw = String(body.oldPassword || '');
      const newPw = String(body.newPassword || '');
      const ov = store.verifyPw(oldPw, me.salt, me.passwordHash);
      if (!ov.ok) return sendJson(res, 400, { error: '原密码错误' });
      if (newPw.length < 7) return sendJson(res, 400, { error: '新密码至少 7 位' });
      if (newPw === oldPw) return sendJson(res, 400, { error: '新密码不能与原密码相同' });
      me.salt = crypto.randomBytes(8).toString('hex');
      me.passwordHash = store.hashPw(newPw, me.salt);
      me.mustChangePassword = false; // 改密成功，解除强制改密窗口
      store.saveUsers();
      // 使该用户的其他会话失效（保留当前会话）
      const cookie = req.headers.cookie || '';
      const cm = /tgboj_token=([^;]+)/.exec(cookie);
      const curToken = cm ? cm[1] : null;
      const curKey = curToken ? store.hashToken(curToken) : null;
      for (const k of Object.keys(store.sessions)) if (store.sessions[k].uid === me.id && k !== curKey) delete store.sessions[k];
      store.saveSessions();
      return sendJson(res, 200, { ok: true, message: '密码已修改' });
    });
publicRoute('POST', '/api/auth/login', async (req, res, pathname) => {
      const body = await readJson(req);
      const username = String(body.username || '').trim().toLowerCase();
      const failKey = username + '|' + reqIp(req);
      const rec = loginFails.get(failKey);
      if (rec && rec.lockUntil > Date.now()) return sendJson(res, 429, { error: '尝试过于频繁，请稍后再试' });
      const u = store.users.find((x) => x.username === username);
      if (!u) { recordLoginFail(failKey); return sendJson(res, 400, { error: '用户名或密码错误' }); }
      const v = store.verifyPw(String(body.password || ''), u.salt, u.passwordHash);
      if (!v.ok) { recordLoginFail(failKey); return sendJson(res, 400, { error: '用户名或密码错误' }); }
      if (v.legacy) { u.mustChangePassword = true; store.saveUsers(); } // 旧口令格式：强制改密后才能继续使用
      if (u.status !== 'active') return sendJson(res, 400, { error: u.status === 'pending' ? '账号待管理员审核' : '账号已被拒绝' });
      loginFails.delete(failKey); // 登录成功清除失败计数
      const token = crypto.randomBytes(32).toString('hex');
      const days = body.remember ? 30 : 1;
      store.sessions[store.hashToken(token)] = { uid: u.id, expireAt: Date.now() + days * 24 * 3600 * 1000 };
      store.saveSessions();
      const securePart = store.CONFIG.cookieSecure ? '; Secure' : '';
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': `tgboj_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}${securePart}`,
      });
      return res.end(JSON.stringify({ ok: true, user: { username: u.username, fullname: u.fullname, role: u.role }, mustChangePassword: !!u.mustChangePassword }));
    });
publicRoute('POST', '/api/auth/logout', async (req, res, pathname) => {
      const cookie = req.headers.cookie || '';
      const m = /tgboj_token=([^;]+)/.exec(cookie);
      const key = m ? store.hashToken(m[1]) : null;
      if (key && store.sessions[key]) { delete store.sessions[key]; store.saveSessions(); }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': 'tgboj_token=; Path=/; HttpOnly; Max-Age=0',
      });
      return res.end(JSON.stringify({ ok: true }));
    });
publicRoute('GET', '/api/auth/me', async (req, res, pathname) => {
      const u = authUserForced(req);
      const allowOut = store.CONFIG.allowTestOutputDownload === true;
      if (!u) return sendJson(res, 200, { user: null, mustChangePassword: false, allowTestOutputDownload: allowOut });
      const base = { username: u.username, fullname: u.fullname, role: u.role, adminLabel: adminLabel(u), studentId: u.studentId || '', bio: u.bio || '' };
      return sendJson(res, 200, { user: base, mustChangePassword: !!u.mustChangePassword, allowTestOutputDownload: allowOut, aiReviewEnabled: isAdminUser(u) && aiReviewEnabled(store.CONFIG) });
    });

const server = http.createServer(async (req, res) => {
  const pathname = getPath(req);
  try {
    // ---- CSRF 防护：非只读请求必须同源（写入/登录等）----
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      if (!sameOrigin(req)) return sendForbidden(res, '跨站请求被拒绝');
    }

    // ---- auth 公开路由（统一登录校验前）----
    for (const r of publicRoutes) {
      if (req.method !== r.method) continue;
      const m = typeof r.pattern === 'string' ? pathname === r.pattern : r.pattern.test(pathname);
      if (!m) continue;
      await r.handler(req, res, pathname);
      return;
    }

    // ---- 统一登录校验：题目与评测状态公开浏览；其余 API 与附件需登录（写入类服务端强制） ----
    if (pathname.startsWith('/api/') || pathname.startsWith('/files/')) {
      const isPublic = /^\/api\/auth\/(register|login|logout|me|change-password)$/.test(pathname)
        || (req.method === 'GET' && pathname === '/api/warnings')
        || pathname === '/api/problems' || pathname === '/api/problem' || pathname === '/api/status' || pathname === '/api/rank' || pathname === '/api/board' || pathname === '/api/notice'
        || (req.method === 'GET' && isImageAttachmentRaw(pathname));
      // 注：GET /api/submission/<id> 已于 2026-08-18 改为需登录（S-4：曾匿名公开逐点判定/IP）
      if (!isPublic && !authUser(req)) return sendUnauthorized(res);
    }

    // ---- 模考功能开关：config.json 的 examsEnabled=false 时整体停用（接口 404，数据保留）----
    // ---- 登录墙（F-3 修复）：publicLoginWall 开启时——
    //   ① 经隧道/反代（loopback + X-Forwarded-For）→ 视为公网流量，需登录；
    //   ② 非 loopback 直连（LAN/Tailscale）→ 同样需登录，杜绝匿名读取实名成绩的绕过面；
    //   ③ 本机 loopback 且无 XFF → 视为本地信任源，匿名放行（隔离实例/本地调试不受影响）。
    const ra = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const isLoop = ra === '127.0.0.1' || ra === '::1';
    const wallHit = store.CONFIG.publicLoginWall && !authUser(req) && (isTunnelReq(req) || !isLoop);
    if (wallHit && (pathname === '/api/status' || pathname === '/api/rank' || pathname === '/api/board')) {
      return sendUnauthorized(res);
    }

    // ---- 模考功能开关：config.json 的 examsEnabled=false 时整体停用（接口 404，数据保留）----
    if (store.CONFIG.examsEnabled === false &&
        (pathname === '/api/exams' || pathname === '/api/exam' || pathname.startsWith('/api/admin/exam'))) {
      return sendJson(res, 404, { error: '模考功能暂未开放' });
    }

    // ---- 业务路由 ----
    for (const r of routes) {
      if (req.method !== r.method) continue;
      const m = typeof r.pattern === 'string' ? pathname === r.pattern : r.pattern.test(pathname);
      if (!m) continue;
      await r.handler(req, res, pathname);
      return;
    }

    // 静态页面
    let file = pathname === '/' ? '/index.html' : pathname;
    const full = path.join(store.PUBLIC_DIR, file);
    if (!full.startsWith(store.PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      const isDynamic = /\.(html?|js|css)$/.test(path.extname(full));
      const headers = { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'" };
      // html/js/css 每次重新校验，避免更新后浏览器仍用缓存旧版
      if (isDynamic) headers['Cache-Control'] = 'no-cache';
      res.writeHead(200, headers);
      return res.end(fs.readFileSync(full));
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    // L-7：非法 JSON → 400；请求体过大 → 413；其余内部错误不向客户端泄露路径/堆栈，仅写服务器日志
    if (e && e.statusCode === 413) return sendJson(res, 413, { error: '请求体过大' });
    if (e instanceof SyntaxError) return sendJson(res, 400, { error: '请求体不是合法 JSON' });
    console.error('[server] 请求处理异常:', e && e.stack ? e.stack : e);
    sendJson(res, 500, { error: '服务内部错误' });
  }
});

// F-3 加固：绑定地址可配。生产若仅经本机隧道/反向代理暴露，建议 bindHost=127.0.0.1 并配合入站防火墙收紧直连面。
const BIND_HOST = store.CONFIG.bindHost || '0.0.0.0';
server.listen(store.CONFIG.port, BIND_HOST, () => {
  // 启动时恢复上次进程中断时未完成的评测（queued/judging 重新入队；受单用户/全局并发上限约束）
  let restored = 0;
  for (const s of store.submissions) {
    if (s.status === 'queued' || s.status === 'judging') {
      s.status = 'queued';
      enqueue(s);
      restored++;
    }
  }
  if (restored) console.log(`恢复评测队列: ${restored} 条提交重新入队`);
  const ifaces = require('os').networkInterfaces();
  const addrs = [];
  for (const k of Object.keys(ifaces)) for (const i of ifaces[k]) if (i.family === 'IPv4' && !i.internal) addrs.push(i.address);
  console.log(`=== TGBOJ服务已启动 ===`);
  console.log(`题目: ${store.PROBLEMS.length} 道  ${store.PROBLEMS.map((p) => p.id + ':' + p.title).join('，')}`);
  console.log(`时间限制: ${store.CONFIG.timeLimitSec}s / 点   内存限制: ${Math.round(store.CONFIG.memLimitKb / 1024)}MB / 点`);
  console.log(`本机访问:  http://localhost:${store.CONFIG.port}`);
  addrs.forEach((a) => console.log(`局域网访问: http://${a}:${store.CONFIG.port}`));
  console.log(`管理员页: http://localhost:${store.CONFIG.port}/admin.html`);
  console.log('按 Ctrl+C 停止');
});
