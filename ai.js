'use strict';
// AI 代码风险检测（OpenAI 兼容 chat completions 接口）
// config.json: aiReview { enabled, apiUrl, model, key, timeoutSec }
// 密钥惯例：环境变量 TGBOJ_AI_API_KEY 优先于配置 key（与 TGBOJ_ADMIN_PASSWORD 一致，密钥尽量不落文件）

const SYSTEM_PROMPT = [
  '你是信息学竞赛评测系统的代码安全审计员。分析学生提交代码的恶意风险，只关注安全风险，不评价算法正确性。',
  '风险类别：',
  '1) 危险系统调用：system/popen/exec 系列、fork 炸弹、内联汇编 syscall/int 0x80、提权、读写敏感文件（/etc、评测数据、标准答案、checker）、网络 socket、dlopen 加载外部库；',
  '2) 卡评测机：无意义死循环（如 while(1){x++;}）、刻意超时/睡眠、内存炸弹、输出轰炸、刻意触发评测器最坏情况；',
  '3) 其他风险：窃取测试数据/标准答案、攻击评测进程或 checker、反检测混淆、作弊行为。',
  '注意：正常竞赛写法（快读、大数组、递归、位运算、freopen 文件读写、STL）不是风险，不要误报。',
  '仅输出一行 JSON，不要输出任何其他内容：{"risk":"none|low|medium|high","categories":["危险系统调用","卡评测机","其他风险"],"summary":"中文简述，80字以内"}。无风险时 risk 为 none、categories 为空数组。',
].join('\n');

function parseVerdict(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const d = JSON.parse(m[0]);
    const risk = ['none', 'low', 'medium', 'high'].indexOf(d.risk) !== -1 ? d.risk : 'unknown';
    const categories = Array.isArray(d.categories) ? d.categories.map((c) => String(c).slice(0, 40)).slice(0, 6) : [];
    const summary = String(d.summary || '').slice(0, 300);
    return { risk, categories, summary };
  } catch (e) { return null; }
}

// 返回 { ok, risk, categories, summary, model } 或 { ok:false, error }
async function aiReviewCode(code, std, cfg) {
  const c = cfg || {};
  const apiUrl = String(c.apiUrl || '').trim();
  const model = String(c.model || '').trim();
  const key = String(process.env.TGBOJ_AI_API_KEY || c.key || '').trim();
  if (!apiUrl || !model) return { ok: false, error: 'AI 检测未配置 apiUrl/model' };
  const timeoutMs = Math.max(5, Math.min(120, Number(c.timeoutSec) || 45)) * 1000;
  const clipped = code.length > 16000 ? code.slice(0, 16000) + '\n// …（代码过长已截断）' : code;
  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: '语言：' + (std || 'c++') + '\n```\n' + clipped + '\n```' },
    ],
    temperature: 0,
    max_tokens: 600,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(apiUrl, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, key ? { Authorization: 'Bearer ' + key } : {}),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const txt = await r.text();
    if (!r.ok) return { ok: false, error: 'AI 接口返回 ' + r.status + '：' + txt.slice(0, 200) };
    let data;
    try { data = JSON.parse(txt); } catch (e) { return { ok: false, error: 'AI 接口返回非 JSON' }; }
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    const v = parseVerdict(content);
    if (!v) return { ok: false, error: 'AI 输出无法解析：' + String(content || '').slice(0, 200) };
    return { ok: true, risk: v.risk, categories: v.categories, summary: v.summary, model };
  } catch (e) {
    return { ok: false, error: 'AI 请求失败：' + (e && e.name === 'AbortError' ? '超时' : String(e && e.message || e)) };
  } finally {
    clearTimeout(timer);
  }
}

function aiReviewEnabled(cfg) {
  const c = (cfg && cfg.aiReview) || {};
  return !!(c.enabled && String(c.apiUrl || '').trim() && String(c.model || '').trim());
}

// 风险等级数值化：unknown=-1（解析失败，视为无风险放行）none=0 low=1 medium=2 high=3
function riskLevel(risk) {
  const m = { unknown: -1, none: 0, low: 1, medium: 2, high: 3 };
  return m[risk] != null ? m[risk] : -1;
}

// 自动拦截阈值：blockRisk='medium' → 中/高风险拦截；缺省 'high' → 仅高风险
function blockThreshold(cfg) {
  const c = (cfg && cfg.aiReview) || {};
  return String(c.blockRisk || 'high').toLowerCase() === 'medium' ? 2 : 3;
}

module.exports = { aiReviewCode, aiReviewEnabled, parseVerdict, riskLevel, blockThreshold };
