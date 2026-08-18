'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ensureChecker, scoreSubmission } = require('./judge');
const { isExPointId } = require('./util');

const ROOT = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
// 管理员初始密码来源：环境变量 TGBOJ_ADMIN_PASSWORD 优先，其次 config.json（允许为空，见 config.example.json）
CONFIG.adminPassword = process.env.TGBOJ_ADMIN_PASSWORD || CONFIG.adminPassword || '';
const SUB_DIR = path.join(ROOT, 'submissions');
const WORK_DIR = path.join(ROOT, 'work');
const PROBLEMS_DIR = path.join(ROOT, 'problems'); // 每题一个目录 problems/<id>/
const INDEX_FILE = path.join(SUB_DIR, 'submissions.json');
const HW_FILE = path.join(ROOT, 'homework.json'); // 作业数据（作业 + 答案）
const FILES_DIR = path.join(ROOT, 'files'); // 附件目录
const FILES_INDEX = path.join(ROOT, 'files.json'); // 附件元数据
const USERS_FILE = path.join(ROOT, 'users.json'); // 用户账号
const SESSIONS_FILE = path.join(ROOT, 'sessions.json'); // 登录会话（token 持久化）
const LOGS_FILE = path.join(ROOT, 'logs.json'); // 用户交互日志
const PROBLEM_VIEWS_FILE = path.join(ROOT, 'problem_views.json'); // 打开过题目的用户 {pid: [uid]}
const NOTICES_FILE = path.join(ROOT, 'notices.json'); // 题目提示更新通知 {pid: {text, createdAt, readBy: []}}
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONTEST_FILE = path.join(ROOT, 'contest.json'); // 比赛时间（限时开赛/锁定提交）
const EXAMS_FILE = path.join(ROOT, 'exams.json'); // 模考（考试）：题目集 + 时间窗 + 成绩公布 + 隐藏判定
const FIRST_PROBLEM_ID = 2026; // 题目编号从 2026 开始，后续上传编号递增

fs.mkdirSync(SUB_DIR, { recursive: true });
// 启动时清空历史评测工作目录。判题池 uid 可能留下服务器用户删不掉的条目（0700 子目录、python
// 字节缓存等，EACCES）——绝不能让启动崩溃（2026-08-18 事故：单个残留目录导致 crash-loop 全站宕机）：
// 先整体 rm，失败或残留时逐条处理，删不掉的 rename 隔离到 orphan-work/（同分区即可，work/ 根属服务器用户）
try {
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
} catch (e) {
  console.error('[store] work/ 整体清空失败（' + (e && e.code) + '），转逐条处理: ' + (e && e.message));
}
try {
  if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true, mode: 0o1771 });
  const leftovers = fs.readdirSync(WORK_DIR);
  if (leftovers.length) {
    const ORPHAN = path.join(ROOT, 'orphan-work');
    for (const name of leftovers) {
      const full = path.join(WORK_DIR, name);
      try { fs.rmSync(full, { recursive: true, force: true }); continue; } catch (e2) { /* 转入隔离 */ }
      try {
        fs.mkdirSync(ORPHAN, { recursive: true });
        fs.renameSync(full, path.join(ORPHAN, name + '-' + Date.now()));
        console.error('[store] work/' + name + ' 无法删除，已隔离到 orphan-work/（需 root 清理）');
      } catch (e3) { console.error('[store] work/' + name + ' 隔离失败: ' + (e3 && e3.message)); }
    }
  }
} catch (e) { console.error('[store] work/ 残留处理异常: ' + (e && e.message)); }
fs.mkdirSync(WORK_DIR, { recursive: true, mode: 0o1771 });
// F-1 加固：work/ 根目录属主改为「服务器运行用户」并加 sticky(1771)，不再归判题池 uid。
// 池内 judge-run* 全部是 others(--x)：只能沿路径穿越进 work/<id>/，既不能列目录/在根建文件/建符号链接，
// 也无法利用「属主=池 uid」这一旧形态预置 work/<id+1> 符号链接做 TOCTOU。子目录仍 0770 属主隔离。
try {
  fs.chmodSync(WORK_DIR, 0o1771);
  fs.chownSync(WORK_DIR, process.getuid(), process.getgid());
} catch (e) { /* 无 CAP_CHOWN 时忽略（chown 到自身 uid 无需特权，此处仅兜底） */ }
fs.mkdirSync(PROBLEMS_DIR, { recursive: true });
fs.mkdirSync(FILES_DIR, { recursive: true });

// ---- 题目加载 ----
let PROBLEMS = [];
let dataVersion = 0; // 排行榜缓存失效版本号（提交/题目/作业/用户任一变化自增）
let rankCache = { key: '', ver: -1, payload: null }; // 排行榜聚合结果缓存
let problemsStatsCache = { ver: -1, data: null }; // 题目列表 ac/tried 统计缓存
function cmpName(a, b) { // 数字名按数值、否则按字符串排序
  const na = parseInt(a, 10), nb = parseInt(b, 10);
  const da = isNaN(na), db = isNaN(nb);
  if (da || db) return String(a) < String(b) ? -1 : 1;
  return na - nb;
}
const MAX_TIME_SEC = 60; // 时限上限 60s
const MAX_MEM_KB = 8 * 1024 * 1024; // 空间上限 8GB
function clampSec(v) {
  const x = parseFloat(v);
  if (!(x > 0)) return CONFIG.timeLimitSec;
  return Math.min(Math.max(x, 0.1), MAX_TIME_SEC); // BUG-6：下限 0.1s，避免亚毫秒时限形同虚设
}
function clampMem(v) {
  const x = parseInt(v, 10);
  if (!(x > 0)) return CONFIG.memLimitKb;
  return Math.min(x, MAX_MEM_KB);
}
// S-3：JSON 数据文件损坏时不得静默置空覆盖——先把原文件改名备份（.corrupt-<时间戳>）并告警，再由上层决定是否重建
const corruptFiles = new Set(); // 本次启动中发现损坏的数据文件（供上层拒绝用 fallback 覆盖 live 文件）
function loadJsonSafe(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    const bak = file + '.corrupt-' + Date.now();
    try { fs.copyFileSync(file, bak); } catch (e2) { /* ignore */ }
    corruptFiles.add(file);
    console.error('[store] 数据文件损坏，已备份到 ' + bak + '（请检查后手工恢复；本次启动不会自动覆盖该文件）');
    return fallback;
  }
}
function loadWarnings(pid) {
  try { return JSON.parse(fs.readFileSync(path.join(PROBLEMS_DIR, String(pid), 'warnings.json'), 'utf8')); }
  catch (e) { return { list: [] }; }
}
function saveWarnings(pid, data) {
  // M-7：与其他数据文件一致，改为 tmp+rename 原子写
  const f = path.join(PROBLEMS_DIR, String(pid), 'warnings.json');
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, f);
  chmod600(f);
}
// ---- 评分规则解析 ----
// point（默认/缺省）：按正式测试点均分，满分 100（原行为）
// subtask：子任务部分分。problem.json 的 scoring 形如：
//   { "mode":"subtask", "subtasks":[ {"id":"1","score":20,"tests":["1","2"],"depends":[]}, ... ] }
// 规则：子任务内所有测试点全 AC 且其依赖（depends 引用的子任务 id）全部通过 → 得该子任务满分，否则 0 分；
// 总分 = 通过子任务分数之和。未归入任何子任务的测试点仍会评测，但不计分。
function parseScoring(raw, tests) {
  if (!raw || !raw.mode || raw.mode !== 'subtask') return { mode: 'point', subtasks: [] };
  const src = Array.isArray(raw.subtasks) ? raw.subtasks : [];
  const validIds = {}; for (const t of tests) validIds[t.id] = true;
  const subs = [];
  for (const s of src) {
    if (!s || typeof s !== 'object') continue;
    const id = String(s.id != null ? s.id : subs.length + 1);
    const score = parseInt(s.score, 10);
    if (!(score > 0)) continue;
    const ts = (Array.isArray(s.tests) ? s.tests : []).map(String).filter((x) => validIds[x]);
    if (!ts.length) continue; // 该子任务没有有效测试点 → 丢弃
    const depends = (Array.isArray(s.depends) ? s.depends : []).map(String);
    subs.push({ id, score, tests: ts, depends });
  }
  if (!subs.length) return { mode: 'point', subtasks: [] }; // 无有效子任务 → 退回按点均分
  // 分数归一化：总分不足/超过 100 时按比例缩放为整数；floor + 余数前分配（L-1：杜绝最后一项出现负分）
  const total = subs.reduce((a, b) => a + b.score, 0);
  if (total !== 100) {
    const scaled = subs.map((s) => Math.floor((s.score * 100) / total));
    let rem = 100 - scaled.reduce((a, b) => a + b, 0);
    for (let i = 0; i < subs.length && rem > 0; i++) { scaled[i] += 1; rem -= 1; }
    for (let i = 0; i < subs.length; i++) subs[i].score = scaled[i];
  }
  return { mode: 'subtask', subtasks: subs };
}

// 加载单个题目目录为题目对象；problem.json 缺失/损坏或无目录时返回 null
function loadOneProblem(pdir) {
  const pj = path.join(pdir, 'problem.json');
  if (!fs.existsSync(pj)) return null;
  let meta;
  try { meta = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch (e) { return null; }
  const dir = path.basename(pdir);
  const dataDir = path.join(pdir, 'data');
  const tests = [];
  const exTests = [];
  if (fs.existsSync(dataDir)) {
    const names = fs.readdirSync(dataDir).filter((f) => f.endsWith('.in')).sort(cmpName);
    for (const f of names) {
      const base = f.slice(0, -3);
      // 缺失 .out 的 .in 不参与评测（否则该点恒 WA），也不计入点数
      if (!fs.existsSync(path.join(dataDir, base + '.out'))) continue;
      const t = { id: base, input: path.join(dataDir, f), expected: path.join(dataDir, base + '.out') };
      if (isExPointId(base)) exTests.push(t); else tests.push(t);
    }
  }
  const scoring = parseScoring(meta.scoring, tests);
  return {
    id: parseInt(dir, 10),
    title: meta.title || ('题目 ' + dir),
    timeLimitSec: clampSec(meta.timeLimitSec),
    memLimitKb: clampMem(meta.memLimitKb),
    // OLE 输出限额（可选覆盖全局）：problem.json outputLimitKb（KB）；0/缺省 = 用全局 config
    outputLimitKb: (typeof meta.outputLimitKb === 'number' && meta.outputLimitKb > 0) ? Math.round(meta.outputLimitKb) : 0,
    hidden: !!meta.hidden,
    // 传统文件读写（NOIP 风格）：{in:"network.in", out:"network.out"}；评测时把输入复制为 <in>、运行后以 <out> 为准
    fileIO: (meta.fileIO && typeof meta.fileIO === 'object' && meta.fileIO.in && meta.fileIO.out)
      ? { in: String(meta.fileIO.in), out: String(meta.fileIO.out) } : null,
    checkerBin: ensureChecker(pdir),
    owner: meta.owner || '',
    rankEnabled: meta.rankEnabled !== false,
    // 做法/题解/参考代码 可见性开关：老题无字段 → 默认开放；新题 assemble 写入 false
    tags: (Array.isArray(meta.tags) ? meta.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20) : []),
    approachOpen: meta.approachOpen !== false,
    solutionOpen: meta.solutionOpen !== false,
    referenceOpen: meta.referenceOpen !== false,
    descriptionFile: path.join(pdir, 'description.md'),
    solutionFile: path.join(pdir, 'solution.md'),
    referenceFile: path.join(pdir, 'reference.json'),
    hasSolution: fs.existsSync(path.join(pdir, 'solution.md')),
    // 样例：支持多组 sample.in/out、sample2.in/out、sample3.in/out…（按编号排序）
    samples: (() => {
      const arr = [];
      try {
        for (const f of fs.readdirSync(pdir)) {
          const m = /^sample(\d*)\.in$/.exec(f);
          if (!m) continue;
          const base = m[1] ? ('sample' + m[1]) : 'sample';
          if (!fs.existsSync(path.join(pdir, base + '.out'))) continue;
          arr.push({ id: m[1] || '1', num: m[1] ? parseInt(m[1], 10) : 1, input: path.join(pdir, f), output: path.join(pdir, base + '.out') });
        }
        arr.sort((a, b) => a.num - b.num);
      } catch (e) { /* ignore */ }
      return arr;
    })(),
    sampleIn: path.join(pdir, 'sample.in'),
    sampleOut: path.join(pdir, 'sample.out'),
    hasSample: fs.existsSync(path.join(pdir, 'sample.in')) && fs.existsSync(path.join(pdir, 'sample.out')),
    tests,
    exTests,
    scoring, // 评分规则：{mode:'point'|'subtask', subtasks:[{id,score,tests,depends}]}（满分 100）
    judgeable: tests.length > 0,
  };
}

function loadProblems() {
  PROBLEMS = [];
  for (const dir of fs.readdirSync(PROBLEMS_DIR)) {
    const pdir = path.join(PROBLEMS_DIR, dir);
    let st; try { st = fs.statSync(pdir); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    const p = loadOneProblem(pdir);
    if (p) PROBLEMS.push(p);
  }
  PROBLEMS.sort((a, b) => a.id - b.id);
  dataVersion++;
}

// 重载单个题目（改元数据/题解后增量更新，避免全量重扫；目录已删则从内存移除）
function reloadProblem(id) {
  const pdir = path.join(PROBLEMS_DIR, String(id));
  const p = loadOneProblem(pdir);
  if (!p) { PROBLEMS = PROBLEMS.filter((x) => x.id !== id); dataVersion++; return; }
  const idx = PROBLEMS.findIndex((x) => x.id === id);
  if (idx === -1) PROBLEMS.push(p);
  else PROBLEMS[idx] = p;
  dataVersion++;
}
loadProblems();
function getProblem(id) { return PROBLEMS.find((p) => p.id === id) || null; }

// ---- 提交持久化 ----
let submissions = loadJsonSafe(INDEX_FILE, []);
if (!Array.isArray(submissions)) submissions = [];
// aiPending 是瞬态标记（AI 检测中），绝不能随落盘复活——否则回调丢失后该提交永远显示「等待中」（#2249 教训）
for (const s of submissions) { if (s && s.aiPending !== undefined) delete s.aiPending; }
// M5：写放大治理——紧凑序列化 + 异步单飞写 + 50ms 合并。数据版本号在内存变更时同步递增（缓存失效不受异步写影响）。
let indexDirty = false, indexWriting = false, indexTimer = null, indexExiting = false;
function saveIndex() {
  indexDirty = true;
  dataVersion++;
  if (indexExiting || indexWriting || indexTimer) return;
  indexTimer = setTimeout(() => { indexTimer = null; doIndexWrite(); }, 50);
  if (indexTimer.unref) indexTimer.unref();
}
function doIndexWrite() {
  if (indexWriting || indexExiting) return;
  if (!indexDirty) return;
  indexDirty = false;
  indexWriting = true;
  // 瞬态字段不落盘：aiPending（AI 检测中，重启恢复会重新入队或已完成）
  const json = JSON.stringify(submissions, (k, v) => (k === 'aiPending' ? undefined : v)); // 紧凑（去 null,2），体积降低约 1/3
  const tmp = INDEX_FILE + '.tmp';
  fs.promises.writeFile(tmp, json)
    .then(() => (indexExiting ? null : fs.promises.rename(tmp, INDEX_FILE)))
    .then(() => { if (!indexExiting) chmod600(INDEX_FILE); })
    .catch((e) => { indexDirty = true; console.error('[store] 提交索引写入失败:', e && e.message); })
    .finally(() => {
      indexWriting = false;
      if (indexDirty && !indexExiting) {
        indexTimer = setTimeout(() => { indexTimer = null; doIndexWrite(); }, 50);
        if (indexTimer.unref) indexTimer.unref();
      }
    });
}
function flushIndexSync() {
  // 进程退出兜底（SIGTERM/SIGINT/exit）：同步落盘最新内存态，避免刚完成的评测因异步写未完成而丢失
  indexExiting = true;
  if (indexTimer) { clearTimeout(indexTimer); indexTimer = null; }
  if (!indexDirty && !indexWriting) return;
  indexDirty = false;
  try {
    const tmp = INDEX_FILE + '.tmp2';
    fs.writeFileSync(tmp, JSON.stringify(submissions, (k, v) => (k === 'aiPending' ? undefined : v)));
    fs.renameSync(tmp, INDEX_FILE);
    chmod600(INDEX_FILE);
  } catch (e) { console.error('[store] 退出前提交索引落盘失败:', e && e.message); }
}
// 启动不再无条件重写整份提交索引（F-5/M5：既避免损坏文件被空数组覆盖，也省去每次重启的全量写放大）

// 历史数据回填：2026-08 之前的提交 summary 没有 score 字段（早期 judge 只记 verdict/display），
// 导致错题本 /api/myproblems 的兜底算分把 AC 题算成 0 分（summary.ac/total 字段从未存在过）。
// 启动时用当前评分口径（scoreSubmission）按已记录的测试点结果重算，只补缺失、不覆盖已有分数。
{
  let backfilled = 0;
  for (const s of submissions) {
    if (!s || s.status !== 'done' || !s.summary) continue;
    if (typeof s.score === 'number' || typeof s.summary.score === 'number') continue;
    const pts = Array.isArray(s.points) ? s.points : [];
    const prob = s.problemId ? getProblem(s.problemId) : null;
    const scoring = prob && prob.scoring && prob.scoring.mode === 'subtask' && prob.scoring.subtasks.length ? prob.scoring : null;
    // point 模式按该提交实际评测的点数计分（题目日后增删数据点不影响历史成绩）
    const res = scoreSubmission(pts, pts.length, scoring);
    s.summary.score = res.score;
    s.summary.maxScore = 100;
    s.score = res.score;
    backfilled++;
  }
  if (backfilled) {
    console.error('[store] 已回填 ' + backfilled + ' 条历史提交的缺失得分字段（错题本 0 分修复）');
    saveIndex();
  }
}

// ---- 作业数据（作业 + 学生答案）----
let hwData = loadJsonSafe(HW_FILE, { homeworks: [], answers: [] });
if (!hwData || typeof hwData !== 'object') hwData = { homeworks: [], answers: [] };
if (!hwData.homeworks) hwData.homeworks = [];
if (!hwData.programmingOrder) hwData.programmingOrder = [];
if (!hwData.programmingStars) hwData.programmingStars = [];
if (!hwData.homeworkStars) hwData.homeworkStars = [];
if (!hwData.answers) hwData.answers = [];
function saveHw() {
  const tmp = HW_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(hwData, null, 2));
  fs.renameSync(tmp, HW_FILE);
  chmod600(HW_FILE);
  dataVersion++;
}

// ---- 附件数据 ----
let filesData = loadJsonSafe(FILES_INDEX, []);
if (!Array.isArray(filesData)) filesData = [];
// 数据文件落盘后强制 600：防 writeFileSync+rename 按 umask 重建为 644（泄露哈希/token/日志）
function chmod600(p) { try { fs.chmodSync(p, 0o600); } catch (e) { /* ignore */ } }

function saveFilesIndex() {
  const tmp = FILES_INDEX + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(filesData, null, 2));
  fs.renameSync(tmp, FILES_INDEX);
  chmod600(FILES_INDEX);
}
const VIEW_EXTS = { '.md': true, '.cpp': true, '.pdf': true, '.txt': true };
const IMG_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp' };

// ---- 用户与认证 ----
let users = [];
function loadUsers() {
  const usersExisted = fs.existsSync(USERS_FILE);
  users = loadJsonSafe(USERS_FILE, []);
  if (!Array.isArray(users)) users = [];
  users = users.filter((u) => u && typeof u === 'object'); // BUG-4：忽略 null/非对象条目，避免启动即崩
  if (usersExisted && corruptFiles.has(USERS_FILE)) {
    // F-5/M2：users.json 损坏时不重建超管、不覆盖 live 文件；保持空用户表并告警，等待人工从 .corrupt 恢复后重启
    console.error('[store] users.json 已损坏：拒绝自动重建超管账号以免覆盖现场。请从 .corrupt 备份恢复后重启服务。');
  } else if (!users.length || !users.some((u) => u.role === 'superadmin')) {
    // S-6：未配置初始密码时生成随机密码并仅打印一次——绝不创建空密码超管
    if (!CONFIG.adminPassword) {
      CONFIG.adminPassword = crypto.randomBytes(12).toString('base64');
      console.error('==========================================');
      console.error('[TGBOJ] 未设置 TGBOJ_ADMIN_PASSWORD，已生成随机初始密码（请立即记录）:');
      console.error('  admin / ' + CONFIG.adminPassword);
      console.error('==========================================');
    }
    // 初始化超管 admin（密码取环境变量/随机兜底）
    users.push({
      id: 1, username: 'admin', fullname: '超级管理员', role: 'superadmin', status: 'active',
      salt: crypto.randomBytes(8).toString('hex'),
      passwordHash: null, createdAt: Date.now(), approvedAt: Date.now(),
    });
    const u = users[users.length - 1];
    u.passwordHash = hashPw(CONFIG.adminPassword, u.salt);
    saveUsers();
  }
  // 安全加固：旧 sha256 快哈希一次性离线迁移为 scrypt 包裹（防 users.json 泄露后 GPU 秒破）。
  // 这些账号下次登录会被强制改密并升级为纯 scrypt(pw)（见 server.js 登录流程 mustChangePassword）
  let migrated = 0;
  for (const u of users) {
    if (u.passwordHash && typeof u.passwordHash === 'string' && u.passwordHash.length === 64) {
      u.passwordHash = { alg: 'scrypt-sha256', hash: hashPw(u.passwordHash, u.salt) };
      migrated++;
    }
  }
  if (migrated) {
    saveUsers();
    console.error('[TGBOJ] 已迁移 ' + migrated + ' 个旧 sha256 口令哈希为 scrypt 包裹（这些账号下次登录需强制改密）');
  }
}
function saveUsers() {
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
  fs.renameSync(tmp, USERS_FILE);
  chmod600(USERS_FILE);
  dataVersion++;
}
function hashPw(pw, salt) {
  // scrypt 慢哈希（64 字节输出），显著加硬暴力破解
  return crypto.scryptSync(String(pw), salt, 64).toString('hex');
}
// 会话 token 落盘前哈希化：sessions.json 只存 sha256(token)，防止文件被读时直接重放明文 token
function hashToken(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }
// 校验密码。存储格式三种：
//   string 64hex  = 旧 sha256(salt:pw) 快哈希（遗留兜底，登录即升级）
//   string 128hex = scrypt(pw)（新格式）
//   {alg:'scrypt-sha256', hash} = scrypt(sha256(salt:pw))（离线迁移格式，登录即升级为 scrypt(pw)）
// 返回 { ok, legacy, upgrade }：legacy=true 表示当前口令仍是旧格式，必须强制改密
function verifyPw(pw, salt, storedHash) {
  if (!storedHash) return { ok: false, legacy: false, upgrade: null };
  const old = crypto.createHash('sha256').update(salt + ':' + pw).digest('hex');
  if (typeof storedHash === 'string') {
    if (storedHash.length === 64) { // 旧格式 sha256
      return storedHash === old ? { ok: true, legacy: true, upgrade: hashPw(pw, salt) } : { ok: false, legacy: false, upgrade: null };
    }
    return { ok: hashPw(pw, salt) === storedHash, legacy: false, upgrade: null };
  }
  if (storedHash && storedHash.alg === 'scrypt-sha256') {
    return hashPw(old, salt) === storedHash.hash ? { ok: true, legacy: true, upgrade: hashPw(pw, salt) } : { ok: false, legacy: false, upgrade: null };
  }
  return { ok: false, legacy: false, upgrade: null };
}
function findUser(pred) { return users.find(pred); }

let sessions = {};
function loadSessions() {
  const d = loadJsonSafe(SESSIONS_FILE, {});
  sessions = (d && typeof d === 'object') ? d : {};
  // 清理过期 + BUG-3：忽略 null/非对象条目（合法 JSON 但结构非法），避免启动即崩
  const now = Date.now();
  let dirty = false;
  for (const k of Object.keys(sessions)) {
    const s = sessions[k];
    if (!s || typeof s !== 'object' || typeof s.expireAt !== 'number') { delete sessions[k]; dirty = true; continue; }
    if (s.expireAt < now) { delete sessions[k]; dirty = true; }
  }
  if (dirty) saveSessions();
}
function saveSessions() {
  const tmp = SESSIONS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2));
  fs.renameSync(tmp, SESSIONS_FILE);
  chmod600(SESSIONS_FILE);
}
loadUsers();
loadSessions();

// ---- 比赛时间（限时开赛：startAt/endAt 锁定提交）----
let contest = { startAt: 0, endAt: 0, title: '', mode: 'oi', penaltyMinutes: 20 };
function loadContest() {
  const d = loadJsonSafe(CONTEST_FILE, null);
  contest = (d && typeof d === 'object') ? d : { startAt: 0, endAt: 0, title: '', mode: 'oi', penaltyMinutes: 20 };
  if (!contest.mode) contest.mode = 'oi'; // 比赛赛制：oi（末次）/ ioi（最高）/ acm（罚时）
  if (!(contest.penaltyMinutes > 0)) contest.penaltyMinutes = 20;
}
function saveContest() {
  const tmp = CONTEST_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(contest, null, 2));
  fs.renameSync(tmp, CONTEST_FILE);
  chmod600(CONTEST_FILE);
}
loadContest();

// ---- 模考（考试）：exams.json [{id,name,problemIds,startAt,endAt,publishAt,hideVerdict,owner,createdAt}] ----
let exams = [];
function loadExams() {
  const d = loadJsonSafe(EXAMS_FILE, []);
  exams = Array.isArray(d) ? d : [];
}
function saveExams() {
  const tmp = EXAMS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(exams, null, 2));
  fs.renameSync(tmp, EXAMS_FILE);
  chmod600(EXAMS_FILE);
  dataVersion++;
}
loadExams();

// ---- 用户交互日志 ----
let logs = loadJsonSafe(LOGS_FILE, []);
if (!Array.isArray(logs)) logs = [];
const LOG_LIMIT = 5000; // 最多保留 5000 条
let logsDirty = false;
function appendLog(u, action, page, detail) {
  logs.push({ time: Date.now(), uid: u ? u.id : null, username: u ? u.username : null, fullname: u ? u.fullname : null, action, page: page || '', detail: detail || '' });
  if (logs.length > LOG_LIMIT) logs = logs.slice(-LOG_LIMIT);
  logsDirty = true;
}
function flushLogs() {
  if (!logsDirty) return;
  logsDirty = false;
  try {
    const tmp = LOGS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(logs));
    fs.renameSync(tmp, LOGS_FILE);
    chmod600(LOGS_FILE);
  } catch (e) { /* 日志写入失败不影响主流程 */ }
}
setInterval(flushLogs, 10000); // 每 10 秒批量落盘，避免每次交互都全量写 logs.json
process.on('exit', () => { flushLogs(); flushIndexSync(); }); // 进程退出时兜底落盘（日志 + 提交索引）
['SIGTERM', 'SIGINT'].forEach((sig) => process.on(sig, () => { flushLogs(); flushIndexSync(); process.exit(0); }));

// ---- 题目打开记录（用于「提示更新」通知目标）----
let problemViews = loadJsonSafe(PROBLEM_VIEWS_FILE, {});
if (!problemViews || typeof problemViews !== 'object') problemViews = {};
function saveProblemViews() {
  const tmp = PROBLEM_VIEWS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(problemViews));
  fs.renameSync(tmp, PROBLEM_VIEWS_FILE);
  chmod600(PROBLEM_VIEWS_FILE);
}
// ---- 题目提示更新通知 ----
let noticesData = loadJsonSafe(NOTICES_FILE, {});
if (!noticesData || typeof noticesData !== 'object') noticesData = {};
function saveNotices() {
  const tmp = NOTICES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(noticesData));
  fs.renameSync(tmp, NOTICES_FILE);
  chmod600(NOTICES_FILE);
}

// ---- 比赛澄清（clarification）----
const CLAR_FILE = path.join(ROOT, 'clarifications.json');
let clars = loadJsonSafe(CLAR_FILE, []);
if (!Array.isArray(clars)) clars = [];
function saveClars() {
  const tmp = CLAR_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clars));
  fs.renameSync(tmp, CLAR_FILE);
  chmod600(CLAR_FILE);
}
function loadClars() { return clars; }

// ---- 代码求助（help request）----
const HELP_FILE = path.join(ROOT, 'help_requests.json');
let helpRequests = loadJsonSafe(HELP_FILE, []);
if (!Array.isArray(helpRequests)) helpRequests = [];
function saveHelpRequests() {
  const tmp = HELP_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(helpRequests, null, 2));
  fs.renameSync(tmp, HELP_FILE);
  chmod600(HELP_FILE);
  dataVersion++;
}
function loadHelpRequests() { return helpRequests; }

// ---- Bug 反馈（bug report）----
const BUG_FILE = path.join(ROOT, 'bug_reports.json');
let bugReports = loadJsonSafe(BUG_FILE, []);
if (!Array.isArray(bugReports)) bugReports = [];
function saveBugReports() {
  const tmp = BUG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(bugReports, null, 2));
  fs.renameSync(tmp, BUG_FILE);
  chmod600(BUG_FILE);
  dataVersion++;
}
function loadBugReports() { return bugReports; }

// ---- 教师私信（message）----
const MSG_FILE = path.join(ROOT, 'messages.json');
let messages = loadJsonSafe(MSG_FILE, []);
if (!Array.isArray(messages)) messages = [];
function saveMessages() {
  const tmp = MSG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(messages, null, 2));
  fs.renameSync(tmp, MSG_FILE);
  chmod600(MSG_FILE);
  dataVersion++;
}
function loadMessages() { return messages; }

function loadReference(problem) {
  if (!problem || !problem.referenceFile) return {};
  try {
    const d = JSON.parse(fs.readFileSync(problem.referenceFile, 'utf8')) || {};
    return { cpp: typeof d.cpp === 'string' ? d.cpp : '', py: typeof d.py === 'string' ? d.py : '' };
  } catch (e) { return {}; }
}
// 题解多份：solution.json（[{name,content}]）优先，兼容旧 solution.md
function loadSolutions(problem) {
  if (!problem || !problem.solutionFile) return [];
  const sj = path.join(path.dirname(problem.solutionFile), 'solution.json');
  try {
    const arr = JSON.parse(fs.readFileSync(sj, 'utf8'));
    if (Array.isArray(arr)) return arr.filter((s) => s && typeof s.content === 'string').map((s) => ({ name: s.name || '题解', content: s.content }));
  } catch (e) { /* 无 solution.json */ }
  try {
    if (fs.existsSync(problem.solutionFile)) return [{ name: '题解', content: fs.readFileSync(problem.solutionFile, 'utf8') }];
  } catch (e) { /* ignore */ }
  return [];
}
// 参考代码多份：reference.json（[{name,lang,code}]）优先，兼容旧格式 {cpp,py}
function loadReferences(problem) {
  if (!problem || !problem.referenceFile) return [];
  try {
    const d = JSON.parse(fs.readFileSync(problem.referenceFile, 'utf8'));
    if (Array.isArray(d)) return d.filter((x) => x && typeof x.code === 'string').map((x) => ({ name: x.name || '参考代码', lang: (x.lang === 'py' ? 'py' : 'cpp'), code: x.code }));
    const out = [];
    if (typeof d.cpp === 'string' && d.cpp.trim()) out.push({ name: 'C++', lang: 'cpp', code: d.cpp });
    if (typeof d.py === 'string' && d.py.trim()) out.push({ name: 'Python', lang: 'py', code: d.py });
    return out;
  } catch (e) { return []; }
}

// ---- HTTP ----

module.exports = {
  ROOT,
  CONFIG,
  SUB_DIR,
  WORK_DIR,
  PROBLEMS_DIR,
  INDEX_FILE,
  HW_FILE,
  FILES_DIR,
  FILES_INDEX,
  USERS_FILE,
  SESSIONS_FILE,
  LOGS_FILE,
  PROBLEM_VIEWS_FILE,
  NOTICES_FILE,
  PUBLIC_DIR,
  FIRST_PROBLEM_ID,
  VIEW_EXTS,
  IMG_MIME,
  get PROBLEMS() { return PROBLEMS; }, set PROBLEMS(v) { PROBLEMS = v; },
  get dataVersion() { return dataVersion; }, set dataVersion(v) { dataVersion = v; },
  get rankCache() { return rankCache; }, set rankCache(v) { rankCache = v; },
  get problemsStatsCache() { return problemsStatsCache; }, set problemsStatsCache(v) { problemsStatsCache = v; },
  get submissions() { return submissions; }, set submissions(v) { submissions = v; },
  get hwData() { return hwData; }, set hwData(v) { hwData = v; },
  get filesData() { return filesData; }, set filesData(v) { filesData = v; },
  get users() { return users; }, set users(v) { users = v; },
  get sessions() { return sessions; }, set sessions(v) { sessions = v; },
  get contest() { return contest; }, set contest(v) { contest = v; },
  saveContest,
  get exams() { return exams; }, set exams(v) { exams = v; },
  loadExams,
  saveExams,
  get logs() { return logs; }, set logs(v) { logs = v; },
  get logsDirty() { return logsDirty; }, set logsDirty(v) { logsDirty = v; },
  get problemViews() { return problemViews; }, set problemViews(v) { problemViews = v; },
  get noticesData() { return noticesData; }, set noticesData(v) { noticesData = v; },
  cmpName,
  clampSec,
  clampMem,
  loadWarnings,
  saveWarnings,
  loadOneProblem,
  loadProblems,
  reloadProblem,
  getProblem,
  saveIndex,
  saveHw,
  saveFilesIndex,
  loadUsers,
  saveUsers,
  hashPw,
  verifyPw,
  hashToken,
  findUser,
  loadSessions,
  saveSessions,
  appendLog,
  flushLogs,
  saveProblemViews,
  saveNotices,
  loadClars,
  saveClars,
  get helpRequests() { return helpRequests; }, set helpRequests(v) { helpRequests = v; },
  loadHelpRequests,
  saveHelpRequests,
  get bugReports() { return bugReports; }, set bugReports(v) { bugReports = v; },
  loadBugReports,
  saveBugReports,
  get messages() { return messages; }, set messages(v) { messages = v; },
  loadMessages,
  saveMessages,
  loadReference,
  loadSolutions,
  loadReferences,
};
