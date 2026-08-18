// common.js — 公共工具 + 分页组件（题目列表 / 评测状态共用）
// 依赖：页面内联脚本定义 renderPage()，以及元素 #pager #pageBtns #pageInfo #pageSizeSel #jumpMode #jumpVal
(function () {
  window.TGBOJ = window.TGBOJ || {};
  var T = window.TGBOJ;
  T.rowPrefix = T.rowPrefix || 'p'; // 跳转定位的行 id 前缀（题目='p'，提交='s'）

  window.esc = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  window.$ = function (id) { return document.getElementById(id); };

  // 分页状态（全局，供页面内联脚本 renderPage 与分页函数共同访问）
  window.PAGE = 1;
  window.PAGE_SIZE = 10;
  window.lastList = [];

  // 从 URL 恢复页码/每页数（?page=&size=），刷新/分享保持
  window.initPager = function () {
    var sp = new URLSearchParams(location.search);
    var p = parseInt(sp.get('page'), 10);
    if (Number.isInteger(p) && p > 0) window.PAGE = p;
    var s = parseInt(sp.get('size'), 10);
    if ([10, 20, 50, 100].indexOf(s) !== -1) window.PAGE_SIZE = s;
    var sel = document.getElementById('pageSizeSel');
    if (sel) sel.value = String(window.PAGE_SIZE);
  };

  window.goPage = function (delta) {
    var pages = window.totalCount != null ? Math.max(1, Math.ceil(window.totalCount / window.PAGE_SIZE)) : Math.max(1, Math.ceil(window.lastList.length / window.PAGE_SIZE));
    window.PAGE = Math.min(pages, Math.max(1, window.PAGE + delta));
    window.renderPage();
    window.syncUrl();
  };

  // 页码跳跃：首尾页 + 当前页 x±2^k（k 整数）；显示不下时折叠为省略号；渲染后检测溢出自动收紧
  window.renderPager = function (pages) {
    var box = document.getElementById('pageBtns');
    if (!box) return;
    var P = window.PAGE;
    var pagerEl = document.getElementById('pager');
    var availW = (pagerEl && pagerEl.clientWidth ? pagerEl.clientWidth : (window.innerWidth || 1000) - 40) - 480;
    var maxBtns = Math.max(4, Math.floor(availW / 36));
    var allKs = [];
    for (var k = 0; k < 28; k++) {
      var d = 1 << k;
      if (P - d >= 1 || P + d <= pages) allKs.push(k);
      if (d > pages) break;
    }
    var build = function (Kfit) {
      box.innerHTML = '';
      var midSet = new Set([P]);
      for (var k = 0; k <= Kfit; k++) { midSet.add(P - (1 << k)); midSet.add(P + (1 << k)); }
      var mid = Array.from(midSet).filter(function (n) { return n > 1 && n < pages; }).sort(function (a, b) { return a - b; });
      var leftFold = allKs.some(function (k) { return k > Kfit && P - (1 << k) > 1; });
      var rightFold = allKs.some(function (k) { return k > Kfit && P + (1 << k) < pages; });
      var addBtn = function (n) {
        var b = document.createElement('button');
        b.className = 'secondary';
        b.textContent = String(n);
        b.style.cssText = 'padding:3px 10px; font-size:12px;' + (n === P ? ' background:var(--accent); color:#fff; border-color:var(--accent);' : '');
        b.onclick = function () { window.jumpPage(n); };
        box.appendChild(b);
      };
      var addEll = function () {
        var el = document.createElement('span');
        el.className = 'sub';
        el.textContent = '…';
        box.appendChild(el);
      };
      addBtn(1);
      if (leftFold) addEll();
      for (var i = 0; i < mid.length; i++) addBtn(mid[i]);
      if (rightFold) addEll();
      if (pages > 1) addBtn(pages);
    };
    var Kfit = allKs.length - 1;
    if (2 * allKs.length + 2 > maxBtns) Kfit = Math.max(0, Math.floor((maxBtns - 4) / 2));
    for (var attempt = 0; attempt < 3; attempt++) {
      build(Kfit);
      if (box.scrollWidth <= box.clientWidth + 2 || Kfit <= 0) break;
      Kfit--;
    }
  };

  window.jumpPage = function (n) {
    var pages = window.totalCount != null ? Math.max(1, Math.ceil(window.totalCount / window.PAGE_SIZE)) : Math.max(1, Math.ceil(window.lastList.length / window.PAGE_SIZE));
    window.PAGE = Math.min(pages, Math.max(1, n));
    window.renderPage();
    window.syncUrl();
  };

  // 跳转：支持按页码或按编号定位
  window.doJump = function () {
    var mode = document.getElementById('jumpMode').value;
    var v = parseInt(document.getElementById('jumpVal').value, 10);
    if (!Number.isInteger(v) || v < 1) { alert('请输入正整数'); return; }
    if (mode === 'page') { window.jumpPage(v); return; }
    // 服务端分页页面可提供 jumpById：由服务端定位该编号所在页
    if (window.jumpById) { window.jumpById(v); return; }
    var idx = window.lastList.findIndex(function (x) { return x.id === v; });
    if (idx === -1) { alert('未找到编号 ' + v); return; }
    window.jumpPage(Math.floor(idx / window.PAGE_SIZE) + 1);
    setTimeout(function () {
      var el = document.getElementById(T.rowPrefix + v);
      if (el) {
        el.scrollIntoView({ block: 'center' });
        el.style.background = 'rgba(59,130,246,.18)';
        setTimeout(function () { el.style.background = ''; }, 2000);
      }
    }, 50);
  };

  // 页码/每页数写入 URL（?page=&size=），刷新/分享保持
  window.syncUrl = function () {
    var sp = new URLSearchParams(location.search);
    sp.set('page', String(window.PAGE));
    sp.set('size', String(window.PAGE_SIZE));
    history.replaceState(null, '', location.pathname + '?' + sp.toString());
  };

  window.setPageSize = function (n) {
    window.PAGE_SIZE = parseInt(n, 10) || 10;
    window.PAGE = 1;
    window.renderPage();
    window.syncUrl();
  };

  window.addEventListener('resize', function () {
    var pages = window.totalCount != null ? Math.max(1, Math.ceil(window.totalCount / window.PAGE_SIZE)) : Math.max(1, Math.ceil(window.lastList.length / window.PAGE_SIZE));
    if (pages > 1) window.renderPager(pages);
  });

  // 评测状态渲染（评测状态页 / 管理后台共用）
  window.testCountMap = {}; // problemId -> 正式测试点数（页面从 /api/status 的 problems 建立）
  window.statusHtml = function (s) {
    var sm = s.summary;
    if (s.aiBlocked) return '<span class="v-err">已拦截</span>';
    if (s.aiPending) {
      var isAdm = window.ME && (window.ME.role === 'admin' || window.ME.role === 'superadmin') && localStorage.getItem('tgboj_mode') !== 'user';
      return '<span class="v-run">' + (isAdm ? '安全检测中' : '等待中') + '</span>';
    }
    if (s.status === 'queued') return '<span class="v-run">排队中</span>';
    if (s.status === 'judging') return '<span class="v-run">评测中… ' + (s.judgedCount || 0) + 'index.html' + (window.testCountMap[s.problemId] || 0) + '</span>';
    if (s.verdictHidden) return '<span class="v-run">已评测 · 成绩暂不公布</span>';
    if (!sm) return '<span class="v-err">未知</span>';
    if (sm.verdict === 'AC') return '<span class="v-ac">AC</span>' + (sm.firstError ? ' <span class="sub">' + window.esc(sm.firstError) + '</span>' : '');
    if (sm.verdict === 'CE') return '<span class="v-err">CE</span>';
    if (sm.verdict === 'SE') return '<span class="v-err">SE</span>';
    // 子任务部分分题：display 为得分（如 70），显示为「70」；按点均分题显示 x/y
    var display = sm.display;
    if (sm.score != null && sm.score >= 0 && sm.verdict !== 'AC' && String(display) === String(sm.score)) {
      display = sm.score + '分';
    }
    return '<span class="v-bad">' + window.esc(display) + '</span> <span class="sub">' + window.esc(sm.firstError) + '</span>';
  };
})();
