/* TGBOJ GitHub Pages student demo: original in-browser data, no backend calls. */
(() => {
  'use strict';

  const NOW = Date.now();
  const student = {
    id: 1001,
    username: 'demo_student',
    fullname: '演示同学',
    studentId: 'DEMO-001',
    role: 'user',
    status: 'active',
    bio: '每天解决一个小问题，保持思考。'
  };

  const problemDefs = {
    1000: {
      id: 1000,
      title: 'A + B',
      tags: ['入门', '输入输出'],
      timeLimitSec: 1,
      memLimitKb: 262144,
      testCount: 3,
      judgeable: true,
      rankEnabled: true,
      hidden: false,
      acCount: 8,
      triedCount: 9,
      html: '<h2>题目描述</h2><p>读入两个整数 <code>a</code> 与 <code>b</code>，输出它们的和。</p><h2>输入格式</h2><p>一行两个整数，满足 $-10^9 \\le a,b \\le 10^9$。</p><h2>输出格式</h2><p>输出一个整数，表示 <code>a+b</code>。</p>',
      samples: [{ id: '1', input: '3 5\n', output: '8\n' }],
      solutions: [{ name: '直接计算', content: '读入两个整数后相加输出即可。', html: '<p>读入两个整数后相加输出即可，时间复杂度为 <code>O(1)</code>。</p>' }],
      references: [{ name: 'C++17', lang: 'cpp', code: '#include <iostream>\nusing namespace std;\nint main(){ long long a,b; cin>>a>>b; cout<<a+b<<"\\n"; }\n' }]
    },
    1001: {
      id: 1001,
      title: '多个整数求和',
      tags: ['入门', '循环'],
      timeLimitSec: 1,
      memLimitKb: 262144,
      testCount: 5,
      judgeable: true,
      rankEnabled: true,
      hidden: false,
      acCount: 5,
      triedCount: 8,
      html: '<h2>题目描述</h2><p>给定 $n$ 个整数，求它们的总和。</p><h2>输入格式</h2><p>第一行一个整数 <code>n</code>，第二行给出 <code>n</code> 个整数。</p><h2>输出格式</h2><p>输出这些整数的和。</p>',
      samples: [{ id: '1', input: '5\n1 2 3 4 5\n', output: '15\n' }],
      solutions: [{ name: '线性扫描', content: '遍历所有整数并累加。', html: '<p>使用一个 64 位整数累加答案，时间复杂度为 <code>O(n)</code>。</p>' }],
      references: []
    },
    1002: {
      id: 1002,
      title: '区间整数和',
      tags: ['数学', '等差数列'],
      timeLimitSec: 1,
      memLimitKb: 262144,
      testCount: 4,
      judgeable: true,
      rankEnabled: true,
      hidden: false,
      acCount: 3,
      triedCount: 6,
      html: '<h2>题目描述</h2><p>给定两个整数 <code>l</code> 和 <code>r</code>，求闭区间 $[l,r]$ 内所有整数的和。</p><h2>输入格式</h2><p>一行两个整数 <code>l r</code>，且 <code>l ≤ r</code>。</p><h2>输出格式</h2><p>输出区间整数和。</p>',
      samples: [{ id: '1', input: '3 6\n', output: '18\n' }],
      solutions: [],
      references: []
    },
    1003: {
      id: 1003,
      title: '加权求和',
      tags: ['入门', '数组'],
      timeLimitSec: 1,
      memLimitKb: 262144,
      testCount: 6,
      judgeable: true,
      rankEnabled: true,
      hidden: false,
      acCount: 2,
      triedCount: 4,
      html: '<h2>题目描述</h2><p>给定两个长度为 $n$ 的整数序列 $a,b$，计算 $\\sum a_i b_i$。</p><h2>输入格式</h2><p>第一行一个整数 <code>n</code>，随后两行分别给出序列 <code>a</code> 与 <code>b</code>。</p><h2>输出格式</h2><p>输出加权和。</p>',
      samples: [{ id: '1', input: '3\n1 2 3\n4 5 6\n', output: '32\n' }],
      solutions: [],
      references: []
    }
  };

  const submissions = [
    { id: 1024, problemId: 1000, problemTitle: 'A + B', username: student.username, name: student.fullname, std: 'c++17', status: 'done', score: 100, submittedAt: NOW - 18 * 60 * 1000, summary: { verdict: 'AC', score: 100, display: 'AC', firstError: '', timeMs: 7, memKb: 1900 } },
    { id: 1023, problemId: 1001, problemTitle: '多个整数求和', username: student.username, name: student.fullname, std: 'c++17', status: 'done', score: 60, submittedAt: NOW - 55 * 60 * 1000, summary: { verdict: 'WA', score: 60, display: '60', firstError: '第 4 个测试点答案错误', timeMs: 11, memKb: 2100 } },
    { id: 1022, problemId: 1001, problemTitle: '多个整数求和', username: 'sample_user', name: '示例用户', std: 'python3', status: 'done', score: 100, submittedAt: NOW - 95 * 60 * 1000, summary: { verdict: 'AC', score: 100, display: 'AC', firstError: '', timeMs: 19, memKb: 9300 } },
    { id: 1021, problemId: 1002, problemTitle: '区间整数和', username: 'learner_02', name: '学习者乙', std: 'c++20', status: 'done', score: 50, submittedAt: NOW - 3 * 60 * 60 * 1000, summary: { verdict: 'WA', score: 50, display: '2/4', firstError: '大数据范围发生整数溢出', timeMs: 6, memKb: 1800 } }
  ];

  const codes = {
    1024: '#include <iostream>\nusing namespace std;\nint main() {\n  long long a, b;\n  cin >> a >> b;\n  cout << a + b << "\\n";\n}\n',
    1023: '#include <iostream>\nusing namespace std;\nint main() {\n  int n, x, sum = 0;\n  cin >> n;\n  while (n--) { cin >> x; sum += x; }\n  cout << sum << "\\n";\n}\n',
    1022: 'n = int(input())\nprint(sum(map(int, input().split())))\n',
    1021: '#include <iostream>\nusing namespace std;\nint main(){ int l,r; cin>>l>>r; cout<<(l+r)*(r-l+1)/2<<"\\n"; }\n'
  };

  function json(data, status = 200, headers = {}) {
    return Promise.resolve(new Response(JSON.stringify(data), {
      status,
      headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers)
    }));
  }

  function text(data, status = 200, headers = {}) {
    return Promise.resolve(new Response(data, { status, headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, headers) }));
  }

  function getProblem(id) {
    return problemDefs[id] || problemDefs[1000];
  }

  function statusList(url) {
    let list = submissions.slice();
    const user = url.searchParams.get('user');
    const problem = url.searchParams.get('problem');
    const find = Number(url.searchParams.get('find') || 0);
    if (user) list = list.filter((x) => x.username === user);
    if (problem) list = list.filter((x) => String(x.problemId) === String(problem));
    if (find) list = list.filter((x) => x.id === find);
    const page = Math.max(1, Number(url.searchParams.get('page') || 1));
    const size = Math.max(1, Number(url.searchParams.get('size') || 10));
    return { list: list.slice((page - 1) * size, page * size), total: list.length, page, size, problems: Object.values(problemDefs).map((p) => ({ id: p.id, title: p.title, testCount: p.testCount })) };
  }

  function submissionDetail(id) {
    const base = submissions.find((x) => x.id === id) || submissions[0];
    const count = getProblem(base.problemId).testCount;
    const passed = base.score === 100 ? count : Math.max(1, Math.round(count * base.score / 100));
    const points = Array.from({ length: count }, (_, i) => ({
      id: String(i + 1), verdict: i < passed ? 'AC' : 'WA', timeMs: 5 + i * 2, memKb: 1800 + i * 30,
      hint: i < passed ? '' : '答案与期望输出不一致'
    }));
    return Object.assign({}, base, {
      isOwn: base.username === student.username,
      canHelp: false,
      inCurrentPeriod: true,
      code: codes[id] || '',
      points,
      sampleResults: [{ id: '1', verdict: 'AC', timeMs: 4, memKb: 1700 }],
      exPoints: [],
      subtaskResults: [],
      summary: Object.assign({}, base.summary, { hint: base.score === 100 ? '全部测试点通过。' : '部分测试点未通过，请检查数据范围与类型。' })
    });
  }

  function rankData() {
    const probs = Object.values(problemDefs).map((p, i) => ({ id: p.id, title: p.title, star: i < 2 }));
    return {
      session: 0,
      sessions: [{ id: 0, name: '春季训练 · 第 1 期' }, { id: 1, name: '体验期' }],
      problems: probs,
      homeworkCols: [{ id: 1, title: '复杂度基础' }],
      rows: [
        { rank: 1, username: 'sample_user', fullname: '示例用户', total: 400, homeworks: { 1: { score: 100 } }, problems: { 1000: { score: 100, tries: 1, ac: true }, 1001: { score: 100, tries: 1, ac: true }, 1002: { score: 100, tries: 2, ac: true }, 1003: { score: 100, tries: 2, ac: true } } },
        { rank: 2, username: student.username, fullname: student.fullname, total: 260, homeworks: { 1: { score: 100 } }, problems: { 1000: { score: 100, tries: 1, ac: true }, 1001: { score: 60, tries: 2, ac: false }, 1002: { score: 0, tries: 0, ac: false }, 1003: { score: 0, tries: 0, ac: false } } },
        { rank: 3, username: 'learner_02', fullname: '学习者乙', total: 150, homeworks: { 1: { score: 50 } }, problems: { 1000: { score: 100, tries: 2, ac: true }, 1002: { score: 50, tries: 3, ac: false } } }
      ]
    };
  }

  function contestData() {
    const startAt = NOW - 45 * 60 * 1000;
    const endAt = NOW + 75 * 60 * 1000;
    return {
      now: NOW,
      status: 'running',
      contest: { title: 'Demo 入门挑战赛', mode: 'ioi', startAt, endAt, penaltyMinutes: 20 },
      freeze: { minutes: 15, frozen: false, startAt: endAt - 15 * 60 * 1000 },
      problems: Object.values(problemDefs).slice(0, 3).map((p) => ({ id: p.id, title: p.title })),
      rows: [
        { rank: 1, username: 'sample_user', fullname: '示例用户', total: 280, cells: { 1000: { score: 100, attempts: 1 }, 1001: { score: 100, attempts: 1 }, 1002: { score: 80, attempts: 2 } } },
        { rank: 2, username: student.username, fullname: student.fullname, total: 160, cells: { 1000: { score: 100, attempts: 1 }, 1001: { score: 60, attempts: 2 } } },
        { rank: 3, username: 'learner_02', fullname: '学习者乙', total: 100, cells: { 1000: { score: 100, attempts: 2 } } }
      ]
    };
  }

  function examList() {
    return { exams: [{ id: 1, name: '基础输入输出模拟测验', status: 'ended', published: true, startAt: NOW - 3 * 86400000, endAt: NOW - 3 * 86400000 + 7200000, publishAt: NOW - 2 * 86400000, problemCount: 3 }] };
  }

  function examDetail() {
    return {
      status: 'ended',
      published: true,
      exam: { id: 1, name: '基础输入输出模拟测验', startAt: NOW - 3 * 86400000, endAt: NOW - 3 * 86400000 + 7200000, publishAt: NOW - 2 * 86400000, hideVerdict: true },
      problems: Object.values(problemDefs).slice(0, 3),
      my: { 1000: { examScore: 100, corrScore: 100 }, 1001: { examScore: 60, corrScore: 100 }, 1002: { examScore: 0, corrScore: 50 } }
    };
  }

  function normalize(input) {
    const raw = typeof input === 'string' ? input : input.url;
    const url = new URL(raw, location.href);
    const apiIndex = url.pathname.indexOf('/api/');
    if (apiIndex >= 0) url.pathname = url.pathname.slice(apiIndex);
    const filesIndex = url.pathname.indexOf('/files/');
    if (apiIndex < 0 && filesIndex >= 0) url.pathname = url.pathname.slice(filesIndex);
    return url;
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = function demoFetch(input, init = {}) {
    const url = normalize(input);
    const path = url.pathname;
    const method = String(init.method || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();

    if (method !== 'GET') {
      if (['/api/log', '/api/problem/view', '/api/notifications/read', '/api/messages/read', '/api/homework/read'].includes(path)) return json({ ok: true, demo: true });
      return json({ error: '静态 Demo 不执行判题，也不会保存或修改任何数据。' }, 405);
    }

    if (path === '/api/auth/me') return json({ user: student, mustChangePassword: false, allowTestOutputDownload: false, aiReviewEnabled: false });
    if (path === '/api/notice') return json({ text: '学生视角静态 Demo：所有内容均为原创演示数据，不会执行代码或保存操作。', createdAt: 20260818 });
    if (path === '/api/notifications/unread') return json({ count: 0, items: [] });
    if (path === '/api/messages') return json({ list: [] });
    if (path === '/api/problems') return json({ problems: Object.values(problemDefs) });
    if (path === '/api/problem') return json(getProblem(Number(url.searchParams.get('id') || 1000)));
    if (path === '/api/warnings') return json({ list: [{ id: 1, username: 'sample_user', fullname: '示例用户', text: '注意使用 64 位整数保存答案。', sampleIn: '', sampleOut: '', visible: true, createdAt: NOW - 86400000 }], mine: [] });
    if (path === '/api/status') return json(statusList(url));
    if (/^\/api\/submission\/\d+$/.test(path)) return json(submissionDetail(Number(path.split('/').pop())));
    if (/^\/api\/code\/\d+$/.test(path)) return text(codes[Number(path.split('/').pop())] || '// Demo code unavailable\n');
    if (/^\/api\/sample\/\d+$/.test(path)) return json({ id: '1', input: '3 5\n', expected: '8\n', actual: '8\n', verdict: 'AC' });
    if (path === '/api/rank') return json(rankData());
    if (path === '/api/myproblems') return json({ problems: [
      { id: 1001, title: '多个整数求和', tags: ['入门', '循环'], bestScore: 60, verdict: 'WA', tries: 2, lastAt: NOW - 55 * 60000, lastSubId: 1023, ac: false, judgeable: true },
      { id: 1000, title: 'A + B', tags: ['入门', '输入输出'], bestScore: 100, verdict: 'AC', tries: 1, lastAt: NOW - 18 * 60000, lastSubId: 1024, ac: true, judgeable: true }
    ] });
    if (path === '/api/contest' || path === '/api/contest/rank') return json(contestData());
    if (path === '/api/homeworks') return json({
      session: 0,
      sessions: [{ id: 0, name: '春季训练 · 第 1 期' }, { id: 1, name: '体验期' }],
      programmingJobs: Object.values(problemDefs).slice(0, 3).map((p, i) => Object.assign({}, p, { star: i < 2, bestScore: i === 0 ? 100 : (i === 1 ? 60 : 0), tries: i === 0 ? 1 : (i === 1 ? 2 : 0) })),
      homeworks: [{ id: 1, title: '复杂度与数据类型', questionCount: 2, publishedAt: NOW - 2 * 86400000, startAt: 0, hidden: false, star: true }]
    });
    if (path === '/api/homework') return json({
      id: 1,
      title: '复杂度与数据类型',
      started: true,
      startAt: 0,
      submittedAt: NOW - 86400000,
      gradeStatus: 'graded',
      score: 100,
      comment: '回答清晰，继续保持。',
      commentHtml: '回答清晰，继续保持。',
      commentRead: true,
      announcement: '本作业用于体验文本作业页面。',
      announcementHtml: '<p>本作业用于体验文本作业页面。</p>',
      allowViewOthers: true,
      questions: ['为什么求和结果通常使用 64 位整数？', '请说明 O(n) 与 O(1) 算法的主要区别。'],
      questionsHtml: ['为什么求和结果通常使用 <code>64 位整数</code>？', '请说明 <code>O(n)</code> 与 <code>O(1)</code> 算法的主要区别。'],
      myAnswer: ['避免多个数相加后超出 32 位整数范围。', 'O(n) 的操作次数随输入规模线性增长，O(1) 基本不随输入规模变化。']
    });
    if (path === '/api/homework/others') return json({ answers: [{ username: 'sample_user', fullname: '示例用户', answerHtml: ['<p>使用 <code>long long</code> 防止溢出。</p>', '<p>一个线性增长，一个保持常数级。</p>'], submittedAt: NOW - 2 * 86400000 }] });
    if (path === '/api/exams') return json(examList());
    if (path === '/api/exam') return json(examDetail());
    if (path === '/api/clar') return json({ contestActive: true, list: [
      { id: 1, username: 'sample_user', fullname: '示例用户', problemId: 1002, text: '区间端点是否都包含在求和范围内？', createdAt: NOW - 30 * 60000, reply: '是，题目中的区间为闭区间 [l,r]。', replyBy: '教师', repliedAt: NOW - 25 * 60000, public: true },
      { id: 2, username: student.username, fullname: student.fullname, problemId: 1001, text: '输入中的整数是否可能为负数？', createdAt: NOW - 12 * 60000, reply: '', public: false }
    ] });
    if (path === '/api/files') return json({ files: [{ id: 1, name: 'Demo 使用说明.md', ext: '.md', size: 860, uploadedAt: NOW - 86400000, hidden: false }, { id: 2, name: 'A+B 参考代码.cpp', ext: '.cpp', size: 180, uploadedAt: NOW - 7200000, hidden: false }] });
    if (path === '/api/file/view') {
      const id = Number(url.searchParams.get('id') || 1);
      return json(id === 2
        ? { id, name: 'A+B 参考代码.cpp', ext: '.cpp', html: '<h2>A+B 参考代码</h2><pre>#include &lt;iostream&gt;\nusing namespace std;\nint main(){ long long a,b; cin&gt;&gt;a&gt;&gt;b; cout&lt;&lt;a+b&lt;&lt;"\\n"; }</pre>' }
        : { id, name: 'Demo 使用说明.md', ext: '.md', html: '<h1>学生端 Demo</h1><p>这是 TGBOJ 的静态学生视角演示。</p><ul><li>所有题目、账号和记录均为原创演示数据。</li><li>代码不会发送至服务器，也不会实际执行。</li><li>保存、下载和写入类操作已禁用。</li></ul>' });
    }
    if (path === '/api/judge-info') return json({ languages: ['C11', 'GNU C++14 / 17 / 20', 'Python 3'], compileFlags: '-O2 -DONLINE_JUDGE -lm', compileTimeoutSec: 30, timeLimitSec: 1, memLimitMb: 256, outputLimitMb: 64, maxParallel: 4, maxPerUser: 2 });
    if (path === '/api/my/code/export') return json({ error: '静态 Demo 不提供代码导出。' }, 405);
    if (/^\/files\/\d+\/download$/.test(path)) return json({ error: '静态 Demo 不提供附件下载。' }, 405);

    if (path.startsWith('/api/')) return json({ error: '该功能在静态 Demo 中不可用。' }, 404);
    return realFetch(input, init);
  };

  window.gateChangePw = function () { alert('静态 Demo 不支持修改密码。'); };
  window.gateLogout = function () { alert('静态 Demo 默认保持学生视角，无需登录或退出。'); };
  window.gateBugReport = function () { alert('静态 Demo 不会保存问题反馈。'); };

  function markReadOnlyControls(root) {
    if (!root || !root.querySelectorAll) return;
    const selectors = [
      '#submitBtn', '#saveBio', '#exportBtn', '#qSend', '#uploadBtn',
      'button[onclick*="openWarnEdit"]', 'button[onclick*="toggleWarn"]',
      'button[onclick*="requestHelp"]', 'button[onclick*="gateChangePw"]'
    ];
    root.querySelectorAll(selectors.join(',')).forEach((el) => {
      el.disabled = true;
      el.title = '静态 Demo 不执行判题或保存数据';
      if (!el.dataset.demoLocked) {
        el.dataset.demoLocked = '1';
        el.textContent = '🔒 ' + el.textContent.replace(/^🔒\s*/, '');
      }
    });
    root.querySelectorAll('.theme-btn, a[onclick*="gateChangePw"], a[onclick*="gateLogout"]').forEach((el) => {
      el.style.display = 'none';
    });
  }

  function addDemoBanner() {
    window.gateChangePw = function () { alert('静态 Demo 不支持修改密码。'); };
    window.gateLogout = function () { alert('静态 Demo 默认保持学生视角，无需登录或退出。'); };
    window.gateBugReport = function () { alert('静态 Demo 不会保存问题反馈。'); };
    if (document.getElementById('demo-mode-banner')) return;
    const bar = document.createElement('div');
    bar.id = 'demo-mode-banner';
    bar.style.cssText = 'position:relative;z-index:9997;padding:7px 14px;background:#0f172a;color:#e2e8f0;font-size:12px;display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap;border-bottom:1px solid #334155;';
    bar.innerHTML = '<b style="color:#67e8a5;">学生视角 · 静态 Demo</b><span>无需登录，不执行代码，不保存数据</span><a href="exam.html" style="color:#93c5fd;">模考</a><a href="clar.html" style="color:#93c5fd;">比赛澄清</a><a href="../showcase.html" style="color:#93c5fd;">项目展示页</a>';
    document.body.insertBefore(bar, document.body.firstChild);
    markReadOnlyControls(document);
    if (typeof MutationObserver !== 'undefined') {
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node.nodeType === 1) markReadOnlyControls(node.parentNode || node);
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    }
  }

  document.addEventListener('DOMContentLoaded', addDemoBanner);
  document.addEventListener('click', (event) => {
    const link = event.target.closest && event.target.closest('a[href]');
    if (!link) return;
    const href = link.getAttribute('href') || '';
    if (/^files\/\d+\/download/.test(href)) {
      event.preventDefault();
      alert('静态 Demo 不提供附件下载。');
    }
  }, true);
})();
