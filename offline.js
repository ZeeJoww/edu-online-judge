'use strict';
// 线下机房模考代码包解析：按「学生编号/题目名/题目名.cpp」结构提取 zip/tar.gz
// 路径遍历全程用 Buffer（原始字节）以兼容 GBK 文件名；显示名用 decodeName 解码
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CODE_EXTS = { '.cpp': 'c++17', '.cc': 'c++17', '.cxx': 'c++17', '.py': 'python3' };

// 文件名解码（用于显示/匹配）：UTF-8 优先；出现替换符则按 GBK 重解（Windows 打包常见）
function decodeName(buf) {
  const utf8 = new TextDecoder('utf-8').decode(buf);
  if (utf8.indexOf('\uFFFD') === -1) return utf8;
  try { return new TextDecoder('gbk').decode(buf); } catch (e) { return utf8; }
}

// Buffer 路径拼接（子路径名保持原始字节）
function bjoin(dir, name) {
  const d = Buffer.isBuffer(dir) ? dir : Buffer.from(String(dir));
  const n = Buffer.isBuffer(name) ? name : Buffer.from(String(name));
  return Buffer.concat([d, Buffer.from('/'), n]);
}

function readdirBuf(dir) {
  return fs.readdirSync(dir, { withFileTypes: true, encoding: 'buffer' });
}

// M-4：解压前校验条目清单——拒绝绝对路径与 .. 穿越（zip-slip），并统计解压总量（防解压炸弹）
function checkArchiveEntries(pkgFile, kind, maxBytes) {
  const entries = [];
  if (kind === 'zip') {
    const out = execFileSync('unzip', ['-l', pkgFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(?:\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{4})\s+\d{2}:\d{2}\s+(.+?)\s*$/.exec(line);
      if (m) entries.push({ size: parseInt(m[1], 10), name: m[2] });
    }
  } else {
    const out = execFileSync('tar', ['-tzvf', pkgFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    for (const line of out.split('\n')) {
      const m = /^\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.+?)\s*$/.exec(line);
      if (m) entries.push({ size: parseInt(m[1], 10), name: m[2] });
    }
  }
  let total = 0;
  for (const e of entries) {
    const n = String(e.name);
    if (n.startsWith('/') || n.split('/').some((c) => c === '..')) throw new Error('压缩包内含非法路径: ' + n);
    total += e.size;
    if (maxBytes && total > maxBytes) throw new Error('压缩包解压后超过 ' + Math.round(maxBytes / 1024 / 1024) + 'MB 上限');
  }
  return total;
}

// D：解压后全树扫描——拒绝符号链接条目（防 symlink 写穿：恶意包可「先建链接、再写同名路径」写到解压根外）
// 在 checkArchiveEntries 路径预检之后、任何业务读取之前调用；lstat 不跟随链接，目录层级设上限防病态包
function assertNoSymlinks(root) {
  const stack = [root];
  let dirs = 0;
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      let st;
      try { st = fs.lstatSync(full); } catch (e) { continue; }
      if (st.isSymbolicLink()) throw new Error('压缩包内含符号链接（不安全，已拒绝）: ' + ent.name);
      if (st.isDirectory()) {
        if (++dirs > 128) throw new Error('压缩包目录层级过深（上限 128 层）');
        stack.push(full);
      }
    }
  }
}

// 解压到临时目录，返回解压根目录（唯一顶层目录则自动进入）
function extractArchive(pkgBuf, kind, tmpDir) {
  const pkgFile = path.join(tmpDir, 'pkg.' + (kind === 'zip' ? 'zip' : 'tar.gz'));
  fs.writeFileSync(pkgFile, pkgBuf);
  checkArchiveEntries(pkgFile, kind, 1024 * 1024 * 1024); // 1GB 上限
  if (kind === 'zip') execFileSync('unzip', ['-q', '-o', pkgFile, '-d', tmpDir], { stdio: 'pipe' });
  else execFileSync('tar', ['-xzf', pkgFile, '-C', tmpDir], { stdio: 'pipe' });
  assertNoSymlinks(tmpDir);
  let root = tmpDir;
  const entries = fs.readdirSync(root).filter((f) => !f.startsWith('pkg.'));
  if (entries.length === 1 && fs.statSync(path.join(root, entries[0])).isDirectory()) root = path.join(root, entries[0]);
  return root;
}

// 扫描「编号/题目名/题目名.cpp」结构。返回 { students, warnings }
// file 字段为相对解压根的 latin1 编码路径（字节无损，apply 时按同法还原）
function scanStudents(root) {
  const rootBuf = Buffer.from(root);
  const students = [];
  const warnings = [];
  for (const ent of readdirBuf(rootBuf)) {
    if (!ent.isDirectory()) continue;
    const name = decodeName(ent.name);
    if (name.startsWith('.') || name === '__MACOSX') continue;
    const sdir = bjoin(rootBuf, ent.name);
    const problems = [];
    for (const pent of readdirBuf(sdir)) {
      if (!pent.isDirectory()) continue;
      const pname = decodeName(pent.name);
      if (pname.startsWith('.') || pname === '__MACOSX') continue;
      const pdir = bjoin(sdir, pent.name);
      const codeFiles = [];
      for (const fent of readdirBuf(pdir)) {
        if (!fent.isFile()) continue;
        const fname = decodeName(fent.name);
        const ext = path.extname(fname).toLowerCase();
        if (CODE_EXTS[ext]) codeFiles.push({ name: fname, ext, file: bjoin(pdir, fent.name) });
      }
      if (!codeFiles.length) { warnings.push('目录 ' + name + '/' + pname + ' 下没有代码文件（.cpp/.cc/.cxx/.py），已跳过'); continue; }
      // 优先选与题目目录同名的代码文件，否则取第一个
      const pref = codeFiles.find((c) => c.name.slice(0, -c.ext.length) === pname) || codeFiles[0];
      let head = '';
      try { head = fs.readFileSync(pref.file, 'utf8').slice(0, 200); } catch (e) { /* ignore */ }
      let size = 0;
      try { size = fs.statSync(pref.file).size; } catch (e) { /* ignore */ }
      problems.push({
        folder: pname,
        file: pref.file.slice(rootBuf.length + 1).toString('latin1'), // 相对路径（字节无损）
        std: CODE_EXTS[pref.ext],
        size,
        head,
      });
    }
    if (!problems.length) { warnings.push('编号 ' + name + ' 下没有可识别的题目目录，已跳过'); continue; }
    students.push({ folder: name, problems });
  }
  return { students, warnings };
}

// ---- 匹配规则 ----
// 编号 → 账号：学号（studentId）> 用户名 > 姓名，精确匹配（忽略大小写）
function matchUser(folder, users) {
  const f = String(folder || '').trim().toLowerCase();
  if (!f) return null;
  return users.find((u) => u.studentId != null && String(u.studentId).toLowerCase() === f)
    || users.find((u) => (u.username || '').toLowerCase() === f)
    || users.find((u) => (u.fullname || '').toLowerCase() === f) || null;
}

// 候选账号（精确优先，其次包含关系），供预览下拉提示
function userCandidates(folder, users, limit) {
  limit = limit || 6;
  const f = String(folder || '').trim().toLowerCase();
  if (!f) return [];
  const active = users.filter((u) => u.status === 'active' && u.role === 'user');
  const exact = []; const fuzzy = [];
  for (const u of active) {
    const keys = [(u.username || '').toLowerCase(), (u.fullname || '').toLowerCase(), String(u.studentId || '').toLowerCase()];
    if (keys.some((k) => k === f)) exact.push(u);
    else if (keys.some((k) => k && (k.indexOf(f) !== -1 || f.indexOf(k) !== -1))) fuzzy.push(u);
  }
  return exact.concat(fuzzy).slice(0, limit);
}

// 题目名 → 模考题：标题精确匹配 > 目录名为题号（2134/T2134）> 标题以目录名开头 > 标题包含目录名
function matchProblem(folder, problems) {
  const f = String(folder || '').trim();
  if (!f) return null;
  const exact = problems.find((p) => String(p.title || '').trim() === f);
  if (exact) return exact;
  const idM = /^[^\d]*(\d+)[^\d]*$/.exec(f);
  if (idM) {
    const idn = parseInt(idM[1], 10);
    const byId = problems.find((p) => p.id === idn);
    if (byId) return byId;
  }
  const prefix = problems.find((p) => String(p.title || '').trim().indexOf(f) === 0);
  if (prefix) return prefix;
  return problems.find((p) => String(p.title || '').indexOf(f) !== -1 || f.indexOf(String(p.title || '').trim()) !== -1) || null;
}

// 候选题目（同上顺序），供预览下拉
function problemCandidates(folder, problems, limit) {
  limit = limit || 6;
  const f = String(folder || '').trim();
  if (!f) return [];
  const out = [];
  const push = (p) => { if (p && out.indexOf(p) === -1) out.push(p); };
  problems.forEach((p) => { if (String(p.title || '').trim() === f) push(p); });
  const idM = /^[^\d]*(\d+)[^\d]*$/.exec(f);
  if (idM) { const idn = parseInt(idM[1], 10); problems.forEach((p) => { if (p.id === idn) push(p); }); }
  problems.forEach((p) => { if (String(p.title || '').trim().indexOf(f) === 0) push(p); });
  problems.forEach((p) => { if (String(p.title || '').indexOf(f) !== -1 || f.indexOf(String(p.title || '').trim()) !== -1) push(p); });
  return out.slice(0, limit);
}

// 编号 → 合法用户名（字母开头 2-16 位；非法字符剔除；数字开头补 stu 前缀）
function sanitizeUsername(folder) {
  let u = String(folder || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!/^[a-z]/.test(u)) u = 'stu' + u;
  u = u.slice(0, 16);
  return /^[a-z][a-z0-9_]{1,15}$/.test(u) ? u : null;
}

module.exports = { CODE_EXTS, decodeName, checkArchiveEntries, assertNoSymlinks, extractArchive, scanStudents, matchUser, userCandidates, matchProblem, problemCandidates, sanitizeUsername };
