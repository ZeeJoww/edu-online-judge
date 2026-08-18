'use strict';
// 评测核心：编译 + 逐测试点运行（CPU 1.5s / 内存 2GB）+ 输出比对 + OI 子任务计分
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STD_FLAGS = { c11: 'c11', 'c++14': 'c++14', 'c++17': 'c++17', 'c++20': 'c++20', 'gnu++14': 'gnu++14', 'gnu++17': 'gnu++17', 'gnu++20': 'gnu++20', python3: null };

// 检测 GNU time（/usr/bin/time -v）是否可用；不可用时评测降级（无 CPU/RSS 统计）
let gnuTimeCache = null;
function gnuTimeOk() {
  if (gnuTimeCache !== null) return gnuTimeCache;
  try {
    require('child_process').execSync('/usr/bin/time -v true 2>/dev/null', { stdio: 'ignore' });
    gnuTimeCache = true;
  } catch (e) {
    gnuTimeCache = false;
  }
  return gnuTimeCache;
}

// 检测 setpriv（util-linux ≥2.32，支持 --ambient-caps）是否可用。
// 【安全修复 2026-08】systemd AmbientCapabilities 方案下，node 以非 0 uid + ambient CAP_SETUID 运行，
// libuv 的 spawn({uid}) 在 fork 内做非 0→非 0 setuid 时 kernel 不清 capability（cap_emulate_setxuid 仅对旧 uid=0 清除），
// ambient 集随 exec 链完整保留到学生二进制 → 学生程序持有效 CAP_SETUID，setuid(0) 即 root。
// 修复：评测/编译 exec 前统一经 setpriv 切换 uid 并清空 inheritable/ambient capability 集。
let setprivCache = null;
function setprivOk() {
  if (setprivCache !== null) return setprivCache;
  try {
    const r = spawnSync('setpriv', ['--reuid=' + process.getuid(), '--regid=' + process.getgid(), '--clear-groups', '--inh-caps=-all', '--ambient-caps=-all', 'true'], { stdio: 'ignore', timeout: 5000 });
    setprivCache = r.status === 0;
  } catch (e) {
    setprivCache = false;
  }
  if (!setprivCache) console.error('[judge] setpriv 降权不可用（无 caps 环境属正常）：评测/编译使用原生 uid 切换，无法额外清空 capability 集');
  return setprivCache;
}

// 统一降权 spawn：优先 setpriv（切 uid/gid + 清空补充组 + 清空 capability 集），不可用回退 node 原生 uid 选项。
// wrapper（setuid-root 包装器方案）分支保持原语义：由包装器自身完成降权。
// 注意：spawn 可能同步抛异常（如无权限 setgid 的 EPERM），调用方必须 try/catch 兜底，
// 防 Promise executor 内同步抛出演变为未处理 rejection 崩溃全站。
function dropSpawn(cmd, args, opts, ro) {
  const ro2 = ro || {};
  const so = Object.assign({}, opts);
  if (ro2.wrapper) return spawn(ro2.wrapper, [cmd].concat(args), so);
  if (ro2.uid && setprivOk()) {
    const argv = ['--reuid=' + ro2.uid, '--regid=' + (ro2.gid || ro2.uid), '--clear-groups',
      '--inh-caps=-all', '--ambient-caps=-all', cmd].concat(args);
    delete so.uid; delete so.gid; // uid/gid 切换交由 setpriv 完成（其自身会清 caps）
    return spawn('setpriv', argv, so);
  }
  if (ro2.uid) so.uid = ro2.uid;
  if (ro2.gid) so.gid = ro2.gid;
  return spawn(cmd, args, so);
}

function compile(srcFile, binFile, std, workDir, timeoutMs, gccPath, runOpts) {
  return new Promise((resolve) => {
    if (std === 'python3') {
      // Python3：解释执行，此阶段做语法检查，报错即 CE。
      // 用 compile() 内存编译而非 py_compile——py_compile 会把 __pycache__/*.pyc 写进 workDir，
      // 属判题池 uid，服务器用户删不掉，导致启动清空 work/ 时 EACCES 崩溃（2026-08-18 事故）
      // 【安全修复 2026-08】编译/语法检查同样降权：此前 g++ 以服务器用户运行，
      // 学生可用 #include "../../users.json" 等让 GCC 诊断信息带出任意属主可读文件全文（含口令/测试答案）
      let p;
      try { p = dropSpawn('python3', ['-B', '-c', 'import sys; compile(open(sys.argv[1], "rb").read(), sys.argv[1], "exec")', srcFile], { cwd: workDir }, runOpts); }
      catch (e) { return resolve({ ok: false, error: '无法启动 python3: ' + e.message }); }
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      const killer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
      p.on('error', (e) => { clearTimeout(killer); resolve({ ok: false, error: '无法启动 python3: ' + e.message }); });
      p.on('close', (code) => {
        clearTimeout(killer);
        resolve({ ok: code === 0, error: err.slice(0, 8192) });
      });
      return;
    }
    if (!STD_FLAGS[std]) return resolve({ ok: false, error: '未知语言标准: ' + std });
    // C 用 gcc、C++ 用 g++；-DONLINE_JUDGE 为 OJ 惯例宏（选手代码可 #ifdef ONLINE_JUDGE 区分本地/评测环境）
    const isC = std === 'c11';
    const compiler = isC ? 'gcc' : (gccPath || 'g++');
    const args = ['-std=' + STD_FLAGS[std], '-O2', '-DONLINE_JUDGE', '-o', binFile, srcFile, '-lm'];
    let p;
    try { p = dropSpawn(compiler, args, { cwd: workDir }, runOpts); }
    catch (e) { return resolve({ ok: false, error: '无法启动编译器: ' + e.message }); }
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    const killer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => { clearTimeout(killer); resolve({ ok: false, error: '无法启动编译器: ' + e.message }); });
    p.on('close', (code) => {
      clearTimeout(killer);
      resolve({ ok: code === 0, error: err.slice(0, 8192) });
    });
  });
}

// 跨 uid 进程组强杀（C）：guard/收尾需杀 setuid 到池 uid 的进程组，服务器用户无跨 uid 杀权限
// （此前 process.kill 会静默 EPERM）→ 派同 uid 的 node 助手执行；uid 缺失/相同则直杀。
// timeout 仍是主杀路径（同 uid 父子），这里只是兜底彻底化。
function killProcessGroup(pgid, uid) {
  if (!pgid || pgid <= 0) return;
  if (uid && uid !== process.getuid()) {
    try {
      const k = spawn(process.execPath, ['-e', 'process.kill(-' + pgid + ',"SIGKILL")'], { uid, stdio: 'ignore' });
      k.on('error', () => { try { process.kill(-pgid, 'SIGKILL'); } catch (e) { /* ignore */ } });
      return;
    } catch (e) { /* 助手不可用则退化直杀 */ }
  }
  try { process.kill(-pgid, 'SIGKILL'); } catch (e) { /* ignore */ }
}

// 运行单个测试点（cmd = argv 数组，用户程序为 timeout 的直接子进程，TLE 可被准确终止）。
// watchOut = { limitBytes, files[] }：输出超限监视——100ms 轮询输出文件大小，超限即杀进程组（OLE 及时终止）
// 返回 { rc, wallMs, cpuMs, maxRssKb, ole }
function runPoint(workDir, cmd, inputFile, timeLimitSec, memLimitKb, libPath, runOpts, watchOut) {
  return new Promise((resolve) => {
    const outFile = path.join(workDir, 'out.txt');
    const errFile = path.join(workDir, 'prog.err');
    const rcFile = path.join(workDir, 'rc.txt');
    const timeFile = path.join(workDir, 'time.txt');
    // 单引号包裹 + 内部单引号转义：杜绝路径元字符注入 shell（M-5）
    const shellQ = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
    // 墙钟兜底放宽为 max(3, 2×时限)：CPU 判 TLE 仍以 GNU time CPU 为准；
    // 无 GNU time 时墙钟是唯一时限，放宽可防并发评测把正常程序误杀
    const wall = Math.max(3, Math.ceil(timeLimitSec * 2));
    // exec + 重定向：sh 应用重定向后原地替换为用户程序 → 用户程序是 timeout 的直接子进程，
    // TERM/KILL 直接送达，不会再出现「timeout 只杀 sh、程序成孤儿」的残留（S-2）
    const inner = 'exec ' + cmd.map(shellQ).join(' ') + ' < ' + shellQ(inputFile) + ' > ' + shellQ(outFile) + ' 2> ' + shellQ(errFile);
    const libEnv = libPath ? '[ -n "${LD_LIBRARY_PATH:-}" ] && export LD_LIBRARY_PATH=' + shellQ(libPath + ':') + '"${LD_LIBRARY_PATH}"; [ -z "${LD_LIBRARY_PATH:-}" ] && export LD_LIBRARY_PATH=' + shellQ(libPath) + '; ' : '';
    let bashCmd;
    if (gnuTimeOk()) {
      bashCmd = [
        'exec 2> ' + shellQ(timeFile) + ';',
        libEnv,
        'ulimit -v ' + memLimitKb + ';',
        'ulimit -s unlimited;', // 无限栈空间（用户要求；深度递归改由 MLE 按 RSS 峰值兜底）
        'ulimit -f 589824 2>/dev/null;', // 单文件上限（576MB，输出比对 512MB 留余量），防写满磁盘；进程数上限由 systemd TasksMax/独立 uid 提供（ulimit -u 按全 uid 线程计数，不可用）
        'cd ' + shellQ(workDir) + ';',
        'LC_ALL=C /usr/bin/time -v timeout -k 2s ' + wall + 's /bin/sh -c ' + shellQ(inner) + ';',
        'echo "RC=$?" > ' + shellQ(rcFile)
      ].join(' ');
    } else {
      // 无 GNU time：降级为仅 timeout + 退出码判定（CPU/RSS 统计不可用）
      bashCmd = [
        libEnv,
        'ulimit -v ' + memLimitKb + ';',
        'ulimit -s unlimited;', // 无限栈空间（用户要求；深度递归改由 MLE 按 RSS 峰值兜底）
        'ulimit -f 589824 2>/dev/null;', // 单文件上限（576MB，输出比对 512MB 留余量），防写满磁盘；进程数上限由 systemd TasksMax/独立 uid 提供（ulimit -u 按全 uid 线程计数，不可用）
        'cd ' + shellQ(workDir) + ';',
        'timeout -k 2s ' + wall + 's /bin/sh -c ' + shellQ(inner) + ';',
        'echo "RC=$?" > ' + shellQ(rcFile)
      ].join(' ');
    }
    const t0 = Date.now();
    // detached 使 bash 成为进程组组长，兜底时可按组强杀；guard 兜底防止 close 事件丢失导致队列永久卡死
    const ro = runOpts || {};
    const spawnOpts = { cwd: workDir, stdio: ['ignore', 'ignore', 'ignore'], detached: true };
    if (ro.uid) spawnOpts.uid = ro.uid; // 供 guard/close 的 killProcessGroup 跨 uid 兜底判定
    if (ro.gid) spawnOpts.gid = ro.gid;
    // dropSpawn：setpriv 可用时经其降权并清空 capability 集（见函数注释）；wrapper/回退路径保持原语义
    let p;
    try { p = dropSpawn('bash', ['-c', bashCmd], spawnOpts, ro); }
    catch (e) { return resolve({ rc: -1, wallMs: 0, cpuMs: 0, maxRssKb: 0, ole: false, error: e.message }); }
    let settled = false;
    let oleKilled = false;
    // 输出超限监视：轮询输出文件大小，超过限额立即强杀整个进程组（比跑完再查文件及时，
    // 防 while(1) 狂写把磁盘/比对拖垮；轮询间隔内的超出量 ≈ 百毫秒级写入，可接受）
    let oleTimer = null;
    if (watchOut && watchOut.limitBytes > 0 && Array.isArray(watchOut.files) && watchOut.files.length) {
      oleTimer = setInterval(() => {
        for (const f of watchOut.files) {
          let sz = 0;
          try { sz = fs.statSync(f).size; } catch (e) { continue; }
          if (sz > watchOut.limitBytes) {
            oleKilled = true;
            killProcessGroup(p.pid, spawnOpts.uid);
            break;
          }
        }
      }, 100);
      oleTimer.unref && oleTimer.unref();
    }
    const finish = (v) => { if (!settled) { settled = true; if (oleTimer) clearInterval(oleTimer); clearTimeout(guard); resolve(v); } };
    const guard = setTimeout(() => {
      killProcessGroup(p.pid, spawnOpts.uid);
      finish({ rc: 124, wallMs: Date.now() - t0, cpuMs: 0, maxRssKb: 0, timedOut: true });
    }, wall * 1000 + 5000);
    p.on('error', (e) => { console.error('[judge] 运行进程 spawn 失败:', e && e.message, e && e.code); finish({ rc: -1, wallMs: 0, cpuMs: 0, maxRssKb: 0, timedOut: false, error: e.message }); });
    p.on('close', () => {
      const wallMs = Date.now() - t0;
      let rc = -1, cpuMs = 0, maxRssKb = 0;
      try {
        const rcText = fs.readFileSync(rcFile, 'utf8');
        const m = rcText.match(/RC=(\d+)/);
        if (m) rc = parseInt(m[1], 10);
      } catch (e) { /* ignore */ }
      try {
        const timeText = fs.readFileSync(timeFile, 'utf8');
        const rss = timeText.match(/Maximum resident set size \(kbytes\): (\d+)/);
        if (rss) maxRssKb = parseInt(rss[1], 10);
        const ut = timeText.match(/User time \(seconds\): ([\d.]+)/);
        const st = timeText.match(/System time \(seconds\): ([\d.]+)/);
        const u = ut ? parseFloat(ut[1]) : 0;
        const s = st ? parseFloat(st[1]) : 0;
        cpuMs = Math.round((u + s) * 1000);
      } catch (e) { /* ignore */ }
      // 无论正常结束还是超时，结束前按进程组兜底清理：用户程序派生的后台进程一并杀掉（防残留占 CPU/磁盘）
      killProcessGroup(p.pid, spawnOpts.uid);
      finish({ rc, wallMs, cpuMs, maxRssKb, ole: oleKilled });
    });
  });
}

// 宽松输出比对（流式，内存 O(单行)）：忽略每行行尾空白与文件末尾空行；
// 先查文件大小上限（MAX_OUT_BYTES），防止全量官方数据的超大输出撑爆内存/磁盘
const MAX_OUT_BYTES = 512 * 1024 * 1024; // 单点输出上限 512MB

function lineReader(file) {
  const stream = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  const st = { chunks: [], len: 0, nlAt: -1, ended: false, failed: false, eofSent: false };
  stream.on('error', () => { st.failed = true; st.ended = true; });
  function ingest(c) {
    if (st.nlAt < 0) {
      const i = c.indexOf('\n');
      if (i >= 0) st.nlAt = st.len + i;
    }
    st.chunks.push(c);
    st.len += c.length;
  }
  async function next() {
    while (st.nlAt < 0 && !st.ended && !st.failed) {
      const c = stream.read();
      if (c) { ingest(c); continue; }
      if (stream.readableEnded) { st.ended = true; break; }
      await new Promise((res) => {
        const done = () => {
          stream.removeListener('readable', done);
          stream.removeListener('end', done);
          stream.removeListener('error', done);
          res();
        };
        stream.once('readable', done);
        stream.once('end', done);
        stream.once('error', done);
      });
    }
    if (st.failed) return { done: true, line: '' }; // 读失败按 EOF 处理，由 compareFiles 的 failed 检查判 RE/WA（防死循环）
    if (st.ended && st.len === 0) {
      if (st.eofSent) return { done: true };
      st.eofSent = true;
      return { done: false, line: '' }; // 末尾空行（比对时忽略）
    }
    let line;
    if (st.nlAt >= 0) {
      const nlAt = st.nlAt;
      let off = nlAt;
      let ci = 0;
      while (off >= st.chunks[ci].length) { off -= st.chunks[ci].length; ci++; }
      const lineParts = st.chunks.slice(0, ci);
      if (off > 0) lineParts.push(st.chunks[ci].slice(0, off));
      line = (lineParts.length === 1 ? lineParts[0] : Buffer.concat(lineParts)).toString('utf8');
      const rest = st.chunks[ci].slice(off + 1); // slice 为视图（零拷贝），避免逐行复制剩余缓冲
      st.chunks = rest.length ? [rest].concat(st.chunks.slice(ci + 1)) : st.chunks.slice(ci + 1);
      st.len -= nlAt + 1;
      st.nlAt = -1;
      if (rest.length) {
        const i = rest.indexOf('\n');
        if (i >= 0) st.nlAt = i;
      }
    } else {
      const all = st.chunks.length === 1 ? st.chunks[0] : (st.chunks.length ? Buffer.concat(st.chunks, st.len) : Buffer.alloc(0));
      line = all.toString('utf8');
      st.chunks = [];
      st.len = 0;
    }
    return { done: false, line: line.replace(/[ \t\r]+$/, '') };
  }
  return { next, get failed() { return st.failed; } };
}

// 截取一行用于小结展示（控制长度，防 submissions.json 膨胀）
function hintLine(s) {
  const t = String(s == null ? '' : s);
  return t.length > 120 ? t.slice(0, 120) + '…' : t;
}

// 宽松输出比对（流式，内存 O(单行)）：忽略每行行尾空白与文件末尾空行。
// 返回 { verdict, hint? }——WA 时 hint 给出首个不同位置（行号 + 期望/实际片段）
async function compareFiles(outFile, expectedFile) {
  try {
    const so = fs.statSync(outFile);
    const se = fs.statSync(expectedFile);
    if (so.size > MAX_OUT_BYTES) return { verdict: 'OLE' }; // 参赛输出超绝对上限（正常 OLE 限额在运行期已拦截，此为兜底）
    if (se.size > MAX_OUT_BYTES) return { verdict: 'WA' };
  } catch (e) {
    if (!fs.existsSync(outFile)) return { verdict: 'RE', hint: '程序没有产生输出文件' };
    return { verdict: 'WA' };
  }
  const a = lineReader(outFile);
  const b = lineReader(expectedFile);
  let n = 0; // 当前比对的行号
  while (true) {
    const la = await a.next();
    const lb = await b.next();
    if (a.failed) return { verdict: 'RE' };
    if (b.failed) return { verdict: 'WA' };
    if (la.done && lb.done) return { verdict: 'AC' };
    n++;
    if (la.done) {
      // 你的输出结束：标准答案若只剩空行也算 AC，否则 WA（缺内容）
      let extra = null, extraN = n;
      while (true) {
        if (b.failed) return { verdict: 'WA' };
        const l = await b.next();
        if (l.done) break;
        if (l.line !== '') { extra = l.line; break; }
        extraN++;
      }
      if (extra == null) return { verdict: 'AC' };
      return { verdict: 'WA', hint: '输出过早结束：第 ' + n + ' 行起缺少内容（期望第 ' + extraN + ' 行为 "' + hintLine(extra) + '"）' };
    }
    if (lb.done) {
      // 标准答案结束：你的输出若只剩空行也算 AC，否则 WA（多内容）
      let extra = null, extraN = n;
      while (true) {
        if (a.failed) return { verdict: 'RE' };
        const l = await a.next();
        if (l.done) break;
        if (l.line !== '') { extra = l.line; break; }
        extraN++;
      }
      if (extra == null) return { verdict: 'AC' };
      return { verdict: 'WA', hint: '输出多余：标准答案共 ' + (n - 1) + ' 行，你的输出第 ' + extraN + ' 行还有 "' + hintLine(extra) + '"' };
    }
    if (la.line !== lb.line) {
      // 一侧为 '' 可能是「该侧输出已结束」的合成末尾空行：向后探测非空行以区分「真正的空行不符」与「内容缺失/多余」
      if (la.line === '' && lb.line !== '') {
        let more = null;
        while (true) {
          if (a.failed) return { verdict: 'RE' };
          const l = await a.next();
          if (l.done) break;
          if (l.line !== '') { more = l.line; break; }
        }
        if (more == null) return { verdict: 'WA', hint: '输出过早结束：第 ' + n + ' 行起缺少内容（期望 "' + hintLine(lb.line) + '"）' };
        return { verdict: 'WA', hint: '第 ' + n + ' 行不同：期望 "' + hintLine(lb.line) + '"，你的输出为空行' };
      }
      if (lb.line === '' && la.line !== '') {
        let more = null;
        while (true) {
          if (b.failed) return { verdict: 'WA' };
          const l = await b.next();
          if (l.done) break;
          if (l.line !== '') { more = l.line; break; }
        }
        if (more == null) return { verdict: 'WA', hint: '输出多余：标准答案共 ' + (n - 1) + ' 行，你的输出第 ' + n + ' 行还有 "' + hintLine(la.line) + '"' };
        return { verdict: 'WA', hint: '第 ' + n + ' 行不同：期望空行，你的输出 "' + hintLine(la.line) + '"' };
      }
      return { verdict: 'WA', hint: '第 ' + n + ' 行不同：期望 "' + hintLine(lb.line) + '"，你的输出 "' + hintLine(la.line) + '"' };
    }
  }
}

// 题目目录放 checker.cpp（testlib 自定义判题器）→ 启动时编译为 checker
// M-14：checker.cpp 比二进制新（或二进制缺失）即重编译；编译失败记录告警并回退文本比对（不再静默）
function ensureChecker(pdir) {
  const cpp = path.join(pdir, 'checker.cpp');
  const bin = path.join(pdir, 'checker');
  if (!fs.existsSync(cpp)) {
    try { fs.rmSync(bin, { force: true }); } catch (e) { /* ignore */ }
    return null;
  }
  let rebuild = false;
  try {
    rebuild = !fs.existsSync(bin) || fs.statSync(cpp).mtimeMs > fs.statSync(bin).mtimeMs;
  } catch (e) { rebuild = true; }
  if (rebuild) {
    try { fs.rmSync(bin, { force: true }); } catch (e) { /* ignore */ }
    const r = spawnSync('g++', ['-O2', '-std=c++17', '-I', path.join(__dirname, '..', 'problems-src', 'testlib'), cpp, '-o', bin], { timeout: 30000 });
    if (r.error || r.status !== 0) {
      console.error('[judge] 题目 ' + path.basename(pdir) + ' 的 checker.cpp 编译失败，暂回退文本比对: ' + String(r.stderr).slice(0, 300));
      return null;
    }
  }
  return bin;
}

// 运行 checker（异步 + 超时 + 进程组强杀）：替代 spawnSync，防死循环 checker 阻塞事件循环拖垮全站
// 捕获 stderr 前 4KB（testlib checker 的判题说明），返回 { code, note }
function runCheckerBin(checkerBin, args, timeoutMs) {
  return new Promise((resolve) => {
    let p;
    let errBuf = '';
    try {
      p = spawn(checkerBin, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
      p.stderr.on('data', (c) => { if (errBuf.length < 4096) errBuf += c.toString('utf8'); });
    } catch (e) { return resolve({ code: -1, note: '' }); }
    let settled = false;
    const finish = (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(killer);
        const note = errBuf.split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
        resolve({ code, note: note.slice(0, 200) });
      }
    };
    const killer = setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch (e) { /* ignore */ } finish(-1); }, timeoutMs);
    p.on('error', () => finish(-1));
    p.on('close', (code) => finish(code));
  });
}

// 跑一个测试点，返回单点判定。fileIO：传统文件读写 {in:"xx.in", out:"xx.out"}——
// 运行前把输入复制为 workDir/<in>（freopen/文件流可读），运行后若生成 <out> 则以它覆盖 stdout 捕获；
// 未生成 <out>（程序用标准输出）则保持 stdout，两种写法同一题内等价兼容。
async function runTestPoint(workDir, cmd, inputFile, expectedFile, timeLimitSec, memLimitKb, libPath, checkerBin, fileIO, runOpts, outLimitKb) {
  const outFile = path.join(workDir, 'out.txt');
  // fileIO 路径白名单：仅纯文件名，防题包注入 ../ 穿越
  const fioIn = fileIO && fileIO.in && /^[\w.-]{1,64}$/.test(String(fileIO.in)) ? path.join(workDir, fileIO.in) : null;
  const fioOut = fileIO && fileIO.out && /^[\w.-]{1,64}$/.test(String(fileIO.out)) ? path.join(workDir, fileIO.out) : null;
  if (fioIn) { try { fs.copyFileSync(inputFile, fioIn); } catch (e) { /* 复制失败退回标准输入 */ } }
  if (fioOut) { try { fs.rmSync(fioOut, { force: true }); } catch (e) { /* ignore */ } }
  // 输入复制到工作目录：降权后的 judger 无权限读 problems/ 数据，统一从 workDir 喂输入
  const stdinFile = path.join(workDir, 'in.txt');
  try { fs.copyFileSync(inputFile, stdinFile); } catch (e) { /* 复制失败则回退原路径 */ }
  // 数据文件如果是从 600 权限源复制而来，判题 uid 会因读不了 stdin 而 RE；统一修正为可读
  try { if (fs.existsSync(stdinFile)) fs.chmodSync(stdinFile, 0o644); } catch (e) { /* ignore */ }
  const stdinPath = fs.existsSync(stdinFile) ? stdinFile : inputFile;
  // Python 解释器虚拟内存开销大：ulimit -v 放宽到至少 512MB（M-13）；MLE 判定仍按题目内存上限对 RSS 比较
  const vml = Array.isArray(cmd) && cmd[0] === 'python3' ? Math.max(memLimitKb, 512 * 1024) : memLimitKb;
  // OLE 监视：stdout 捕获文件 + fileIO 输出文件（若配置）；限额默认 64MB（server 侧已钳制 1MB~512MB）
  const limitKb = (typeof outLimitKb === 'number' && outLimitKb > 0) ? outLimitKb : 64 * 1024;
  const watchFiles = [outFile];
  if (fioOut) watchFiles.push(fioOut);
  const r = await runPoint(workDir, cmd, stdinPath, timeLimitSec, vml, libPath, runOpts, { limitBytes: limitKb * 1024, files: watchFiles });
  // OLE：输出超限被监视器强杀，或触碰 ulimit -f 内核兜底（SIGXFSZ → bash 退出码 128+25=153）
  if (r.ole || r.rc === 153) return { verdict: 'OLE', timeMs: r.wallMs, cpuMs: r.cpuMs, memKb: r.maxRssKb, hint: '输出超过限额 ' + Math.round(limitKb / 1024) + 'MB，已被强制终止（Output Limit Exceeded）' };
  if (fioOut) {
    try {
      if (fs.existsSync(fioOut)) {
        // stdout 捕获文件由降权评测用户创建，通常为 0644，服务进程无法直接覆盖；
        // 目录对服务进程可写，先删除再复制传统文件输出，避免 freopen 结果被静默丢弃。
        try { fs.rmSync(outFile, { force: true }); } catch (e) { /* ignore */ }
        fs.copyFileSync(fioOut, outFile);
        // 后续测试点仍需由降权评测用户打开/截断 out.txt；工作目录本身已隔离，放开文件写权限即可。
        try { fs.chmodSync(outFile, 0o666); } catch (e) { /* ignore */ }
      }
    } catch (e) { /* 无文件输出则用 stdout */ }
  }
  if (r.rc === 124 || r.rc === 137) {
    // 137 = SIGKILL（timeout -k 兜底或 OOM killer）；内存接近上限按 MLE，否则 TLE
    if (r.maxRssKb >= memLimitKb * 0.9) return { verdict: 'MLE', timeMs: r.wallMs, memKb: r.maxRssKb, hint: '内存峰值约 ' + Math.round(r.maxRssKb / 1024) + 'MB，达到/超过 ' + Math.round(memLimitKb / 1024) + 'MB 限制被终止' };
    return { verdict: 'TLE', timeMs: r.wallMs, memKb: r.maxRssKb, hint: '运行超过 ' + timeLimitSec + 's 时间限制被终止（CPU 时间 ' + (r.cpuMs / 1000).toFixed(2) + 's）' };
  }
  if (r.cpuMs > timeLimitSec * 1000) return { verdict: 'TLE', timeMs: r.wallMs, cpuMs: r.cpuMs, memKb: r.maxRssKb, hint: 'CPU 时间 ' + (r.cpuMs / 1000).toFixed(2) + 's 超过 ' + timeLimitSec + 's 时间限制' };
  if (r.maxRssKb > memLimitKb) return { verdict: 'MLE', timeMs: r.wallMs, memKb: r.maxRssKb, hint: '内存峰值约 ' + Math.round(r.maxRssKb / 1024) + 'MB，超过 ' + Math.round(memLimitKb / 1024) + 'MB 限制' };
  if (r.rc !== 0) {
    // 因内存受限被杀（malloc 失败 abort 等）且内存接近上限 → MLE
    if (r.maxRssKb >= memLimitKb * 0.95) return { verdict: 'MLE', timeMs: r.wallMs, memKb: r.maxRssKb, hint: '内存峰值约 ' + Math.round(r.maxRssKb / 1024) + 'MB，达到/超过 ' + Math.round(memLimitKb / 1024) + 'MB 限制' };
    // 退出码 >128 = 被信号终止（如 139=SIGSEGV 段错误、134=SIGABRT）
    const sig = r.rc > 128 ? '，信号 ' + (r.rc - 128) + (r.rc === 139 ? '（段错误，常见原因：数组越界/非法指针/递归爆栈）' : r.rc === 134 ? '（异常中止，常见原因：断言失败/容器越界访问）' : '') : '';
    return { verdict: 'RE', timeMs: r.wallMs, memKb: r.maxRssKb, hint: '程序异常退出（退出码 ' + r.rc + sig + '）' };
  }
  let verdict, hint;
  if (checkerBin) {
    // 自定义判题器（testlib）：checker <输入> <参赛输出> <标准答案>，退出码 0=AC 1=WA 2=PE(计WA)
    const chk = await runCheckerBin(checkerBin, [inputFile, path.join(workDir, 'out.txt'), expectedFile], 10000); // 10s 超时
    verdict = chk.code === 0 ? 'AC' : 'WA';
    hint = chk.code === 0 ? undefined : (chk.note || undefined);
  } else {
    const cmp = await compareFiles(path.join(workDir, 'out.txt'), expectedFile);
    verdict = cmp.verdict;
    hint = cmp.hint;
  }
  return { verdict, timeMs: r.wallMs, cpuMs: r.cpuMs, memKb: r.maxRssKb, hint };
}

// 汇总：全 AC → AC；否则 x/y + 第一个错误（point 模式，向后兼容旧调用）
function summarize(points, total) {
  return scoreSubmission(points, total, null);
}

// ---- 评分（OI 模式核心）----
// points：逐测试点结果 [{id, verdict, timeMs, memKb}]；scoring：题目的评分规则（null/point → 按点均分）
// 返回 {score, maxScore, verdict, display, firstError, timeMs, memKb, subtaskResults}
//   point 模式：score = round(100 * ac/total)，display = "x/y"（全 AC 为 "AC"）
//   subtask 模式：子任务全过（含依赖）才得分；display = 分数（满分 100 时为 "AC"）
function scoreSubmission(points, total, scoring) {
  const maxTime = points.length ? Math.max(...points.map((p) => p.timeMs || 0)) : 0;
  const maxMem = points.length ? Math.max(...points.map((p) => p.memKb || 0)) : 0;
  if (points.some((p) => p.verdict === 'CE')) {
    return { score: 0, maxScore: 100, verdict: 'CE', display: 'CE', firstError: '编译错误', timeMs: maxTime, memKb: maxMem, subtaskResults: [] };
  }
  const bad = points.find((p) => p.verdict !== 'AC');
  const badErr = bad ? bad.verdict + ' on test #' + bad.id : '';
  if (!scoring || scoring.mode !== 'subtask' || !scoring.subtasks.length) {
    const ac = points.filter((p) => p.verdict === 'AC').length;
    if (total > 0 && ac === total) {
      return { score: 100, maxScore: 100, verdict: 'AC', display: 'AC', firstError: '', timeMs: maxTime, memKb: maxMem, subtaskResults: [] };
    }
    const score = total > 0 ? Math.round((100 * ac) / total) : 0;
    return { score, maxScore: 100, verdict: bad ? bad.verdict : 'SE', display: ac + '/' + total, firstError: badErr, timeMs: bad ? bad.timeMs : 0, memKb: bad ? bad.memKb : 0, subtaskResults: [] };
  }
  // subtask 模式：子任务内全 AC + 依赖子任务全部通过 → 得该子任务满分
  const byId = {}; for (const p of points) byId[String(p.id)] = p;
  const passed = {};
  const results = [];
  let score = 0;
  for (const st of scoring.subtasks) {
    const depsOk = st.depends.every((d) => !!passed[d]);
    const pts = st.tests.map((tid) => byId[tid]).filter(Boolean);
    const allAc = depsOk && pts.length === st.tests.length && pts.every((p) => p.verdict === 'AC');
    let subVerdict = 'AC';
    if (!allAc) {
      if (!depsOk) subVerdict = 'WA'; // 依赖未通过：子任务不计分（标注 WA）
      else {
        const f = pts.find((p) => p.verdict !== 'AC');
        subVerdict = f ? f.verdict : 'WA';
      }
    } else { passed[st.id] = true; score += st.score; }
    results.push({ id: st.id, score: allAc ? st.score : 0, maxScore: st.score, pass: allAc, verdict: subVerdict, tests: st.tests });
  }
  const full = score >= 100;
  return {
    score, maxScore: 100,
    verdict: full ? 'AC' : (bad ? bad.verdict : 'SE'),
    display: full ? 'AC' : String(score),
    firstError: full ? '' : badErr,
    timeMs: maxTime, memKb: maxMem,
    subtaskResults: results,
  };
}

// ---- 编译缓存 ----
// 按「源码哈希 + 编译器版本 + 编译参数」缓存 g++ 二进制（judge/.compile-cache/）。
// 重评 / 重复提交相同代码时免重编译（C++ 编译常为评测链路中最慢的一环）；python3 解释执行无需缓存。
const CACHE_DIR = path.join(__dirname, '.compile-cache');
const compileInflight = new Map(); // key -> Promise：同 key 并发编译去重

const gccVersionCache = {};
function gccVersion(gccPath) {
  const key = gccPath || 'g++';
  if (gccVersionCache[key]) return gccVersionCache[key];
  try {
    gccVersionCache[key] = String(spawnSync(key, ['--version'], { encoding: 'utf8' }).stdout).split('\n')[0] || 'unknown';
  } catch (e) {
    gccVersionCache[key] = 'unknown';
  }
  return gccVersionCache[key];
}

function compileKey(srcFile, std, gccPath) {
  const src = fs.readFileSync(srcFile);
  const srcHash = crypto.createHash('sha256').update(src).digest('hex').slice(0, 32);
  const compiler = std === 'c11' ? 'gcc' : (gccPath || 'g++'); // C 用 gcc 编译，缓存键须体现真实编译器
  const envHash = crypto.createHash('sha256')
    .update(gccVersion(compiler) + '|' + (STD_FLAGS[std] || std) + '|-O2|-DONLINE_JUDGE|-lm')
    .digest('hex').slice(0, 16);
  return srcHash + '-' + envHash;
}

// BUG-5：除条数上限外，增加「单条字节上限 + 总字节上限」，防巨型二进制把磁盘耗尽（1000×64MB≈64GB）
const CACHE_MAX_ENTRY_BYTES = 256 * 1024 * 1024;   // 单条 256MB：巨型静态数组二进制不再缓存，每次重编译
const CACHE_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 总量 2GB
// 缓存清理：30 天以上未用的缓存、超量的最旧缓存（保留最新 1000 个）、1 小时以上的残留 .tmp
function pruneCache() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch (e) { return; }
  try {
    const now = Date.now();
    const all = fs.readdirSync(CACHE_DIR);
    for (const f of all) {
      const p = path.join(CACHE_DIR, f);
      let t = 0;
      try { t = fs.statSync(p).mtimeMs; } catch (e) { continue; }
      if (f.endsWith('.bin') && now - t > 30 * 24 * 3600 * 1000) { try { fs.unlinkSync(p); } catch (e) { /* ignore */ } }
      if ((f.includes('.tmp') || f.endsWith('.tmp')) && now - t > 3600 * 1000) { try { fs.unlinkSync(p); } catch (e) { /* ignore */ } }
    }
    const bins = all.filter((f) => f.endsWith('.bin')).map((f) => {
      const p = path.join(CACHE_DIR, f);
      try { const st = fs.statSync(p); return { p, t: st.mtimeMs, size: st.size }; } catch (e) { return null; }
    }).filter(Boolean).sort((a, b) => b.t - a.t); // 最新在前
    // 单条超限直接删
    for (const s of bins) if (s.size > CACHE_MAX_ENTRY_BYTES) { try { fs.unlinkSync(s.p); } catch (e) { /* ignore */ } }
    const kept = bins.filter((s) => s.size <= CACHE_MAX_ENTRY_BYTES);
    // 总字节超限或条数超限：从最旧（数组尾部）开始逐出
    let total = kept.reduce((a, b) => a + b.size, 0);
    let i = kept.length - 1;
    while (i >= 0 && (total > CACHE_MAX_TOTAL_BYTES || kept.length > 1000)) {
      total -= kept[i].size;
      try { fs.unlinkSync(kept[i].p); } catch (e) { /* ignore */ }
      kept.splice(i, 1);
      i--;
    }
  } catch (e) { /* 清理失败不影响评测 */ }
}
pruneCache();
setInterval(pruneCache, 3600 * 1000).unref(); // L-10：每小时清理一次（原每进程仅一次）

// 编译（带缓存）。返回与 compile 同构的 {ok, error}，附加 cacheHit 供观测。
// 【安全修复 2026-08】编译已降权（runOpts），判题 uid 无权写 CACHE_DIR：
// 改为在 workDir 内编译出临时二进制，再由服务器用户（本进程）复制进缓存与目标位置。
async function compileCached(srcFile, binFile, std, workDir, timeoutMs, gccPath, runOpts) {
  if (std === 'python3' || !STD_FLAGS[std]) return compile(srcFile, binFile, std, workDir, timeoutMs, gccPath, runOpts);
  pruneCache();
  let key;
  try { key = compileKey(srcFile, std, gccPath); } catch (e) { return compile(srcFile, binFile, std, workDir, timeoutMs, gccPath, runOpts); }
  const cacheFile = path.join(CACHE_DIR, key + '.bin');
  try {
    if (fs.existsSync(cacheFile)) {
      fs.copyFileSync(cacheFile, binFile);
      return { ok: true, cacheHit: true };
    }
  } catch (e) { return compile(srcFile, binFile, std, workDir, timeoutMs, gccPath, runOpts); }
  let inflight = compileInflight.get(key);
  if (!inflight) {
    inflight = (async () => {
      // 降权编译在 workDir 内产出临时二进制；成功后由本进程（服务器用户）收进缓存
      const tmpBin = path.join(workDir, '.cc-tmp-' + process.pid + '-' + Math.random().toString(36).slice(2));
      const r = await compile(srcFile, tmpBin, std, workDir, timeoutMs, gccPath, runOpts);
      if (r.ok) {
        try { fs.copyFileSync(tmpBin, cacheFile); } catch (e) { /* 缓存写失败不影响本次评测 */ }
      }
      try { fs.unlinkSync(tmpBin); } catch (e) { /* ignore */ }
      return r;
    })();
    compileInflight.set(key, inflight);
    // 【修复 2026-08】finally 会派生新的 promise 链：编译失败（rejection）若不同步挂 catch，
    // 该派生链成为 unhandled rejection → 整个服务进程崩溃（曾致隔离实例全站挂掉）
    inflight.finally(() => compileInflight.delete(key)).catch(() => { /* 失败已由等待方处理 */ });
  }
  const r = await inflight;
  if (!r.ok) return r;
  try {
    fs.copyFileSync(cacheFile, binFile);
    return { ok: true, cacheHit: false };
  } catch (e) {
    // 缓存产物异常（罕见）：兜底直接编译到目标位置
    return compile(srcFile, binFile, std, workDir, timeoutMs, gccPath, runOpts);
  }
}

module.exports = { compile, compileCached, runTestPoint, summarize, scoreSubmission, ensureChecker, STD_FLAGS };
