'use strict';
const fs = require('fs');

function esc(s) {
  // 同时转义引号：防止用户 Markdown（作业答案/警示等）在 <img>/<a> 属性内闭合引号注入 onerror 等属性（存储型 XSS）
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function renderMath(s) {
  // LaTeX 公式保持原样输出，由前端 KaTeX 渲染（$...$ 行内 / $$...$$ 块级）
  return s;
}
function renderMarkdown(src) {
  // 提取「## 提示」「## 提示1」「## 提示2」…板块（题目末尾）：每个独立折叠为 <details class="md-hint">，点击展开
  let hintHtml = '';
  const re = /##\s*提示(\d*)\s*\r?\n([\s\S]*?)(?=\n##\s|$)/g;
  const blocks = [];
  let m;
  while ((m = re.exec(src)) !== null) blocks.push(m);
  src = src.replace(re, '');
  for (const b of blocks) {
    const label = '提示' + (b[1] || '');
    hintHtml += '<details class="md-hint"><summary>' + label + '</summary><div class="hint-body">' + renderMarkdownBody(b[2]) + '</div></details>';
  }
  // 提取「## 做法」板块（题目末尾）：折叠为 <details class="md-sol">，绿色系配色
  const sm = /##\s*做法\s*\r?\n([\s\S]*?)(?=\n##\s|$)/.exec(src);
  if (sm) {
    src = src.replace(sm[0], '');
    hintHtml += '<details class="md-sol"><summary>做法</summary><div class="hint-body">' + renderMarkdownBody(sm[1]) + '</div></details>';
  }
  return renderMarkdownBody(src) + hintHtml;
}

function renderMarkdownBody(src) {
  const lines = src.split(/\r?\n/);
  let html = '', inCode = false, codeBuf = [], listStack = [], quoteBuf = [], inMath = false, mathBuf = [];
  // 问答格式（Q/A 两级折叠）：`Q: 问题` 开内层折叠，`A: 答案`（可多行）为其内容，遇下一个 Q 或块尾关闭
  let qaMode = false, qaAns = [];
  const closeAllLists = () => { while (listStack.length) { html += '</ul>'; listStack.pop(); } };
  const flushQuote = () => {
    if (quoteBuf.length) { html += '<blockquote>' + quoteBuf.map((l) => '<p>' + l + '</p>').join('') + '</blockquote>'; quoteBuf = []; }
  };
  // 行内渲染：转义 + 粗体 + 行内代码 + 链接（公式原样输出由前端 KaTeX 渲染）
  const inline = (t) => {
    t = renderMath(esc(t));
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    // 图片：![alt](https://...) → <img>（须在链接之前处理）
    t = t.replace(/!\[([^\]\[]+)\]\(([^)\s]+)\)/g, (m, alt, url) =>
      (/^(https?:\/\/|\/)/i.test(url)) ? '<img src="' + url + '" alt="' + alt + '" loading="lazy" class="md-img">' : m);
    // 链接：http(s) 外链（新窗口）+ 站内 /files/ 附件链接（同窗口下载/查看）
    t = t.replace(/\[([^\]\[]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    t = t.replace(/\[([^\]\[]+)\]\((\/files\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
    return t;
  };
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    // 问答格式：Q: 开头 → 新内层折叠（关闭上一个）；A: 及其后行归入答案缓冲
    if (/^Q:\s?/.test(raw.trim())) {
      flushQuote();
      closeAllLists();
      if (qaMode) html += renderMarkdownBody(qaAns.join('\n')) + '</div></details>';
      html += '<details class="md-qa"><summary>' + inline(raw.trim().replace(/^Q:\s?/, 'Q: ')) + '</summary><div class="qa-ans">';
      qaMode = true;
      qaAns = [];
      continue;
    }
    if (qaMode) {
      if (/^A:\s?/.test(raw.trim())) qaAns.push(raw.trim().replace(/^A:\s?/, ''));
      else qaAns.push(raw);
      continue;
    }
    if (raw.trim().startsWith('```')) {
      flushQuote();
      closeAllLists(); // 代码块前先闭合列表
      if (inCode) { html += '<pre class="codeblock">' + esc(codeBuf.join('\n')) + '</pre>'; codeBuf = []; inCode = false; }
      else inCode = true;
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }
    // 块级公式：$$ 开闭行（可跨多行），中间内容原样拼接后由前端 KaTeX 渲染
    if (raw.trim() === '$$') {
      flushQuote();
      closeAllLists();
      if (inMath) {
        html += '<div class="md-math">$$\n' + esc(mathBuf.join('\n')) + '\n$$</div>';
        mathBuf = []; inMath = false;
      } else {
        inMath = true;
      }
      continue;
    }
    if (inMath) { mathBuf.push(raw); continue; }
    // 引用块：> 开头，连续行合并为一个 <blockquote>
    if (/^\s*>\s?/.test(raw)) { closeAllLists(); quoteBuf.push(inline(raw.replace(/^\s*>\s?/, ''))); continue; }
    flushQuote();
    // 表格：以 | 开头的行且下一行为分隔线（| --- | / | :---: |）
    if (/^\s*\|/.test(raw) && li + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[li + 1])) {
      closeAllLists();
      const tbl = [raw, lines[li + 1]]; // 表头 + 分隔行
      li += 2;
      while (li < lines.length && /^\s*\|/.test(lines[li])) { tbl.push(lines[li]); li++; }
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      html += '<table class="md-table"><thead><tr>' + cells(tbl[0]).map((c) => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>';
      for (let r = 2; r < tbl.length; r++) html += '<tr>' + cells(tbl[r]).map((c) => '<td>' + c + '</td>').join('') + '</tr>';
      html += '</tbody></table>';
      continue;
    }
    // 列表：支持分级（按行首缩进嵌套），无序 - / * / +，有序 1. 等
    const lm = /^(\s*)([-*+]|\d+[.)])\s+/.exec(raw);
    if (lm) {
      flushQuote();
      const indent = lm[1].replace(/\t/g, '    ').length;
      while (listStack.length && listStack[listStack.length - 1] > indent) { html += '</ul>'; listStack.pop(); }
      if (!listStack.length || listStack[listStack.length - 1] < indent) { html += '<ul>'; listStack.push(indent); }
      html += '<li>' + inline(raw.replace(/^\s*[-*+]\s+/, '').replace(/^\s*\d+[.)]\s+/, '')) + '</li>';
      continue;
    }
    if (listStack.length && raw.trim() !== '') closeAllLists();
    const line = inline(raw);
    if (/^###\s+/.test(line)) { html += '<h3>' + line.replace(/^###\s+/, '') + '</h3>'; }
    else if (/^##\s+/.test(line)) { html += '<h2>' + line.replace(/^##\s+/, '') + '</h2>'; }
    else if (/^#\s+/.test(line)) { html += '<h1>' + line.replace(/^#\s+/, '') + '</h1>'; }
    else if (/^\s*-{3,}\s*$/.test(line)) { html += '<hr>'; }
    else if (line.trim() === '') { html += ''; }
    else html += '<p>' + line + '</p>';
  }
  flushQuote();
  closeAllLists();
  if (inCode) html += '<pre class="codeblock">' + esc(codeBuf.join('\n')) + '</pre>';
  if (qaMode) html += renderMarkdownBody(qaAns.join('\n')) + '</div></details>'; // 关闭未闭合的问答折叠
  return html;
}
function renderProblem(problem) {
  try {
    return renderMarkdown(fs.readFileSync(problem.descriptionFile, 'utf8'));
  } catch (e) {
    return '<p>(题目描述缺失)</p>';
  }
}

// ---- multipart/form-data 解析（无依赖）----
function parseMultipart(buf, boundary) {
  const parts = [];
  const sep = Buffer.from('--' + boundary);
  let pos = 0;
  while (true) {
    const idx = buf.indexOf(sep, pos);
    if (idx === -1) break;
    let start = idx + sep.length;
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    else if (buf[start] === 0x0a) start += 1;
    else break; // 结束分隔线 --boundary--
    const next = buf.indexOf(sep, start);
    let end;
    if (next === -1) {
      // 缺少结束分隔线（--boundary--）时：把剩余内容作为最后一个 part（容错）
      end = buf.length;
    } else {
      end = next;
    }
    if (end >= 2 && buf[end - 2] === 0x0d && buf[end - 1] === 0x0a) end -= 2;
    const part = buf.slice(start, end);
    const hIdx = part.indexOf('\r\n\r\n');
    if (hIdx === -1) continue;
    const headerText = part.slice(0, hIdx).toString('utf8');
    const body = part.slice(hIdx + 4);
    const nm = /name="([^"]*)"/.exec(headerText);
    const fn = /filename="([^"]*)"/.exec(headerText);
    parts.push({ name: nm ? nm[1] : '', filename: fn ? fn[1] : '', body });
    pos = next;
  }
  return parts;
}

module.exports = { esc, renderMath, renderMarkdown, renderMarkdownBody, renderProblem, parseMultipart };
