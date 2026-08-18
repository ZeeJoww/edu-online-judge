'use strict';
// 代码查重：归一化 + SimHash（字符 n-gram）+ 海明距离
// 用于检测疑似抄袭的提交对（同一题内两两比较）
// 归一化：去注释/字符串/空白 + 标识符统一编号（对变量改名鲁棒）→ 字符 n-gram → SimHash(64位)

// FNV-1a 64 位哈希
function fnv64(str) {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}

const CPP_KEYWORDS = new Set(('alignas alignof and and_eq asm auto bitand bitor bool break case catch char char8_t char16_t char32_t class compl concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected public register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor xor_eq define include ifdef ifndef endif pragma main cin cout cerr endl std string vector map set queue stack pair printf scanf').split(/\s+/));

const PY_KEYWORDS = new Set(('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield print range len').split(/\s+/));

// 归一化：去注释、去字符串、标识符统一编号、去空白（保留结构）
function normalizeCode(code, std) {
  let s = String(code || '');
  if (std === 'python3') {
    s = s.replace(/#[^\n]*/g, ' '); // 去 # 注释
  } else {
    s = s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' '); // 去块/行注释
  }
  s = s.replace(/"(?:[^"\\]|\\.)*"/g, ' S ').replace(/'(?:[^'\\]|\\.)*'/g, ' C '); // 字符串/字符字面量
  const kw = std === 'python3' ? PY_KEYWORDS : CPP_KEYWORDS;
  const seen = new Map();
  let cnt = 0;
  s = s.replace(/[a-zA-Z_][a-zA-Z0-9_]*/g, (m) => {
    if (kw.has(m)) return m; // 关键字保留
    if (!seen.has(m)) seen.set(m, 'v' + (cnt++));
    return seen.get(m);
  });
  s = s.replace(/\s+/g, '');
  return s;
}

// SimHash（字符 n-gram，n=5）
function simhash(code, std) {
  const s = normalizeCode(code, std);
  const N = 5;
  const v = new Array(64).fill(0);
  for (let i = 0; i + N <= s.length; i++) {
    const h = fnv64(s.slice(i, i + N));
    for (let bit = 0; bit < 64; bit++) {
      v[bit] += (h >> BigInt(bit)) & 1n ? 1 : -1;
    }
  }
  let hash = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if (v[bit] > 0) hash |= 1n << BigInt(bit);
  }
  return hash;
}

// 海明距离
function hamming(a, b) {
  let x = a ^ b;
  let d = 0;
  while (x) { d++; x &= x - 1n; }
  return d;
}

// 计算一组提交的两两相似度，返回疑似抄袭对（按距离升序）
// subs: [{ id, code, std }]
// 返回 [{ a, b, distance, level }]，level: 'near-identical'(≤3) | 'high'(≤10)
function findPairs(subs) {
  const hashes = subs.map((s) => simhash(s.code, s.std));
  const pairs = [];
  for (let i = 0; i < subs.length; i++) {
    for (let j = i + 1; j < subs.length; j++) {
      const d = hamming(hashes[i], hashes[j]);
      if (d <= 10) {
        pairs.push({ a: subs[i].id, b: subs[j].id, distance: d, level: d <= 3 ? 'near-identical' : 'high' });
      }
    }
  }
  pairs.sort((x, y) => x.distance - y.distance);
  return pairs;
}

module.exports = { fnv64, normalizeCode, simhash, hamming, findPairs };
