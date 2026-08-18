// gate.js — 登录门禁：题目可公开浏览；交题/使用功能时未登录则弹出登录（支持注册、记住我、改密码）
(function () {
  // 页面可设置 window.GATE_REQUIRED = false 表示浏览无需登录（题目列表/题目页）
  var REQUIRED = (typeof window.GATE_REQUIRED === 'undefined') ? true : window.GATE_REQUIRED;
  var state = { user: null, gateShown: false, theme: localStorage.getItem('tgboj_theme') || 'light' };

  function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function showGate(cb) {
    if (state.gateShown) { state.gateCb = cb || null; return; }
    state.gateShown = true;
    state.gateCb = cb || null;
    var mask = document.createElement('div');
    mask.className = 'gate-mask';
    mask.id = 'gate-mask';
    mask.innerHTML =
      '<div class="gate-card">' +
      '<span class="gate-close" onclick="gateClose()" title="关闭">×</span>' +
      '<h2>登录 TGBOJ</h2>' +
      '<div id="gate-login">' +
      '<label>用户名</label><input id="g-user" placeholder="用户名" autocomplete="username">' +
      '<label>密码</label><input id="g-pass" type="password" placeholder="密码" autocomplete="current-password">' +
      '<label style="display:flex; align-items:center; gap:6px; font-weight:400; margin-top:10px;">' +
      '<input type="checkbox" id="g-remember" checked style="width:auto; flex:none;"> 保持登录</label>' +
      '<button id="g-login-btn">登录</button>' +
      '<div class="gate-err" id="g-err"></div>' +
      '<a class="gate-link" onclick="gateShowReg()">没有账号？注册</a>' +
      '</div>' +
      '<div id="gate-reg" style="display:none">' +
      '<label>用户名（字母开头，2-16 位字母/数字/下划线）</label><input id="g-ruser" placeholder="用户名" autocomplete="off">' +
      '<label>姓名（实名才能过审）</label><input id="g-rfull" placeholder="真实姓名" autocomplete="off">' +
      '<label>密码（至少 7 位）</label><input id="g-rpass" type="password" placeholder="密码" autocomplete="new-password">' +
      '<button id="g-reg-btn">注册</button>' +
      '<div class="gate-err" id="g-reg-err"></div>' +
      '<a class="gate-link" onclick="gateShowLogin()">返回登录</a>' +
      '</div>' +
      '</div>';
    document.body.appendChild(mask);
    var err = mask.querySelector('#g-err');
    var rerr = mask.querySelector('#g-reg-err');
    mask.querySelector('#g-login-btn').addEventListener('click', doLogin);
    mask.querySelector('#g-reg-btn').addEventListener('click', doReg);
    mask.querySelector('#g-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    mask.querySelector('#g-rpass').addEventListener('keydown', function (e) { if (e.key === 'Enter') doReg(); });
    setTimeout(function () { mask.querySelector('#g-user').focus(); }, 50);

    async function doLogin() {
      err.textContent = '';
      var r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: mask.querySelector('#g-user').value, password: mask.querySelector('#g-pass').value, remember: mask.querySelector('#g-remember').checked }) });
      var d = await r.json();
      if (!r.ok) { err.textContent = d.error || '登录失败'; return; }
      if (d.mustChangePassword) {
        state.user = d.user;
        closeGate();
        window.gateShowForcedChange(d.user, mask.querySelector('#g-pass').value);
        return;
      }
      var cb = state.gateCb;
      state.user = d.user;
      closeGate();
      renderUser(d.user);
      if (cb) cb();
      window.dispatchEvent(new CustomEvent('tgboj:auth'));
    }
    async function doReg() {
      rerr.textContent = '';
      var r = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: mask.querySelector('#g-ruser').value, fullname: mask.querySelector('#g-rfull').value, password: mask.querySelector('#g-rpass').value }) });
      var d = await r.json();
      if (!r.ok) { rerr.textContent = d.error || '注册失败'; return; }
      rerr.textContent = '✓ 注册成功，请等待管理员审核后登录';
      mask.querySelector('#g-ruser').value = ''; mask.querySelector('#g-rpass').value = '';
      setTimeout(function () { gateShowLogin(); }, 1500);
    }
  }
  function closeGate() {
    var m = document.getElementById('gate-mask');
    if (m) m.remove();
    state.gateShown = false;
    state.gateCb = null;
  }
  // 仅通过叉叉关闭；点周围空白不关闭
  window.gateClose = function () { closeGate(); };
  window.gateShowLogin = function () {
    var m = document.getElementById('gate-mask');
    if (!m) return;
    m.querySelector('#gate-login').style.display = '';
    m.querySelector('#gate-reg').style.display = 'none';
    m.querySelector('#g-err').textContent = '';
    m.querySelector('h2').textContent = '登录 TGBOJ';
  };
  window.gateShowReg = function () {
    var m = document.getElementById('gate-mask');
    if (!m) return;
    m.querySelector('#gate-login').style.display = 'none';
    m.querySelector('#gate-reg').style.display = '';
    m.querySelector('#g-reg-err').textContent = '';
    m.querySelector('h2').textContent = '注册 TGBOJ';
  };
  // 未登录时弹出登录；登录成功回调 cb（用于交题等）
  window.gateEnsureLogin = function (cb) {
    if (state.user) { if (cb) cb(); return; }
    showGate(cb);
  };
  window.gateLogin = function () { showGate(null); };

  function renderUser(u) {
    window.ME = u || null; // 全站可读的当前用户（与 tgboj:auth 事件配套）
    gateApplyTheme();
    var header = document.querySelector('header');
    if (!header) return;
    var oldBar = document.querySelector('.userbar');
    if (oldBar) oldBar.remove(); // 移除登录前的「登录/注册」按钮
    var isAdmin = u.role === 'admin' || u.role === 'superadmin';
    // 管理员模式：导航加「管理」入口
    if (isAdmin && currentMode() === 'admin') {
      var nav = header.querySelector('nav');
      if (nav && !nav.querySelector('a[href="/admin.html"]')) {
        var a = document.createElement('a');
        a.href = '/admin.html';
        a.textContent = '管理';
        nav.appendChild(a);
      }
    }
    var bar = document.createElement('div');
    bar.className = 'userbar';
    var isAdminRole = u.role === 'admin' || u.role === 'superadmin';
    var displayName = isAdminRole ? (u.adminLabel || '教师') : u.username;
    var roleTag = '';
    var modeItem = isAdmin ? '<a href="#" onclick="event.preventDefault();gateToggleMode();">' +
      (currentMode() === 'admin' ? '👁 切换为普通用户界面' : '🛠 切换为管理员界面') + '</a>' : '';
    var themeItem = '<a href="#" onclick="event.preventDefault();gateToggleTheme();">' +
      (state.theme === 'dark' ? '☀️ 浅色模式' : '🌙 深色模式') + '</a>';
    bar.innerHTML = '<button class="theme-btn" onclick="gateBugReport()" title="问题反馈" style="margin-right:6px; position:relative;">🐞</button>' +
      '<div class="user-menu">' +
      '<button class="user-menu-btn" onclick="gateMenuToggle(event)">👤 ' + esc(displayName) +
      (roleTag ? ' <span class="user-role">' + roleTag + '</span>' : '') + ' <span class="arrow">▾</span></button>' +
      '<div class="user-menu-drop" id="user-drop">' +
      themeItem +
      modeItem +
      '<a href="/me.html">👤 个人中心</a>' +
      '<a href="/clar.html">❓ 比赛澄清</a>' +
      '<a href="#" onclick="event.preventDefault();gateMenuClose();gateChangePw();">修改密码</a>' +
      '<a href="#" onclick="event.preventDefault();gateLogout();">退出登录</a>' +
      '</div></div>';
    header.appendChild(bar);
    // 学生端：轮询未读反馈 → 右上角红点
    if (!isAdminRole) {
      pollNotif();
      if (!window.__notifTimer) { window.__notifTimer = true; setInterval(pollNotif, 30000); }
    } else {
      // 管理员端：轮询未处理 Bug 反馈 → 🐞 按钮角标
      pollBugDot();
      if (!window.__bugTimer) { window.__bugTimer = true; setInterval(pollBugDot, 30000); }
    }
  }
  // 问题反馈：学生打开反馈弹窗；管理员跳转管理页反馈页签
  window.gateBugReport = function () {
    var u = window.ME;
    if (u && (u.role === 'admin' || u.role === 'superadmin')) { location.href = '/admin.html#bugs'; return; }
    if (!u) { showGate(null); return; }
    if (document.getElementById('bug-mask')) return;
    var mask = document.createElement('div');
    mask.id = 'bug-mask';
    mask.style.cssText = 'position:fixed; inset:0; background:rgba(15,23,42,.45); z-index:9999; display:flex; align-items:center; justify-content:center; padding:16px;';
    mask.innerHTML = '<div style="background:var(--card,#fff); color:inherit; border:1px solid var(--line,#e2e8f0); border-radius:12px; padding:20px; width:100%; max-width:480px; box-shadow:0 10px 30px rgba(0,0,0,.18);">' +
      '<h3 style="margin:0 0 4px;">🐞 问题反馈</h3>' +
      '<p class="sub" style="margin:0 0 10px; font-size:13px; color:#64748b;">遇到的异常、显示问题或建议都可以写在这里，会直接发送给教师。</p>' +
      '<textarea id="bug-text" rows="5" maxlength="1000" placeholder="请描述你遇到的问题（会自动附上当前页面地址）" style="width:100%; box-sizing:border-box; min-height:110px;"></textarea>' +
      '<div id="bug-tip" class="sub" style="min-height:18px; font-size:13px; margin-top:6px;"></div>' +
      '<div style="display:flex; gap:8px; justify-content:flex-end; margin-top:8px;">' +
      '<button class="secondary" onclick="gateBugClose()">取消</button>' +
      '<button onclick="gateBugSubmit()">发送给教师</button>' +
      '</div></div>';
    mask.addEventListener('click', function (e) { if (e.target === mask) gateBugClose(); });
    document.body.appendChild(mask);
    var ta = document.getElementById('bug-text');
    if (ta) ta.focus();
  };
  window.gateBugClose = function () {
    var m = document.getElementById('bug-mask');
    if (m) m.remove();
  };
  // 教师私信入口（全站通用）：status/rank 等页面点击学生名 → 发消息。仅管理员可用。
  window.gateMsgCompose = function (username, fullname) {
    var u = window.ME;
    if (!u || (u.role !== 'admin' && u.role !== 'superadmin')) return;
    if (document.getElementById('msgc-mask')) return;
    var mask = document.createElement('div');
    mask.id = 'msgc-mask';
    mask.style.cssText = 'position:fixed; inset:0; background:rgba(15,23,42,.45); z-index:10000; display:flex; align-items:center; justify-content:center; padding:16px;';
    mask.innerHTML = '<div style="background:var(--card,#fff); color:inherit; border:1px solid var(--line,#e2e8f0); border-radius:12px; padding:20px; width:100%; max-width:480px; box-shadow:0 10px 30px rgba(0,0,0,.18);">' +
      '<h3 style="margin:0 0 4px;">✉️ 发消息给 ' + esc(fullname || username) + '</h3>' +
      '<p style="margin:0 0 10px; font-size:12px; color:#64748b;">支持 <code>#提交编号</code> 引用提交（学生端可点击跳转）与 http(s) 链接；最多 2000 字。</p>' +
      '<textarea id="msgc-text" rows="5" maxlength="2000" placeholder="请输入消息内容…" style="width:100%; box-sizing:border-box; min-height:110px;"></textarea>' +
      '<div id="msgc-tip" style="min-height:18px; font-size:13px; margin-top:6px; color:#ef4444;"></div>' +
      '<div style="display:flex; gap:8px; justify-content:flex-end; margin-top:8px;">' +
      '<button class="secondary" onclick="gateMsgComposeClose()">取消</button>' +
      '<button onclick="gateMsgSend(\'' + String(username).replace(/'/g, "\\'") + '\')">发送</button>' +
      '</div><div id="msgc-hist" style="margin-top:10px;"></div></div>';
    mask.addEventListener('click', function (e) { if (e.target === mask) gateMsgComposeClose(); });
    document.body.appendChild(mask);
    var ta = document.getElementById('msgc-text');
    if (ta) ta.focus();
    // 最近发送记录
    fetch('/api/admin/messages?toUsername=' + encodeURIComponent(username)).then(function (r) { return r.json(); }).then(function (d) {
      var box = document.getElementById('msgc-hist');
      if (!box) return;
      var list = ((d && d.list) || []).slice(0, 5);
      box.innerHTML = list.length
        ? '<div style="border-top:1px solid rgba(128,128,128,.2); padding-top:8px; font-size:12px; color:#94a3b8;">最近发送：</div>' + list.map(function (m) {
            return '<div style="padding:4px 0; font-size:12px; color:#94a3b8; border-bottom:1px dashed rgba(128,128,128,.15);">' + fmtNotifTime(m.createdAt) + ' · ' + esc(String(m.text).slice(0, 60)) + (String(m.text).length > 60 ? '…' : '') + (m.read ? '（已读）' : '') + '</div>';
          }).join('')
        : '';
    }).catch(function () { /* 忽略 */ });
  };
  window.gateMsgComposeClose = function () {
    var m = document.getElementById('msgc-mask');
    if (m) m.remove();
  };
  window.gateMsgSend = function (username) {
    var ta = document.getElementById('msgc-text');
    var tip = document.getElementById('msgc-tip');
    var text = ta ? ta.value.trim() : '';
    if (!text) { if (tip) tip.textContent = '请填写消息内容'; return; }
    if (tip) { tip.style.color = '#64748b'; tip.textContent = '发送中…'; }
    fetch('/api/admin/message', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toUsername: username, text: text }),
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); }).then(function (res) {
      if (!res.ok) { if (tip) { tip.style.color = '#ef4444'; tip.textContent = res.d.error || '发送失败'; } return; }
      gateMsgComposeClose();
      gateToast('✓ 消息已发送');
    }).catch(function () { if (tip) { tip.style.color = '#ef4444'; tip.textContent = '网络错误，请稍后再试'; } });
  };
  window.gateBugSubmit = function () {
    var ta = document.getElementById('bug-text');
    var tip = document.getElementById('bug-tip');
    var text = ta ? ta.value.trim() : '';
    if (!text) { if (tip) tip.textContent = '请填写反馈内容'; return; }
    if (tip) tip.textContent = '发送中…';
    fetch('/api/bugreport', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, page: location.pathname + location.search }),
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); }).then(function (res) {
      if (!res.ok) { if (tip) tip.textContent = res.d.error || '发送失败'; return; }
      gateBugClose();
      gateToast('✓ 已发送，感谢反馈！');
    }).catch(function () { if (tip) tip.textContent = '网络错误，请稍后再试'; });
  };
  function gateToast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed; left:50%; top:70px; transform:translateX(-50%); background:#16a34a; color:#fff; padding:8px 18px; border-radius:20px; font-size:14px; z-index:10000; box-shadow:0 4px 14px rgba(0,0,0,.2);';
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.remove(); }, 2200);
  }
  function pollBugDot() {
    fetch('/api/admin/bugreports/count').then(function (r) { return r.json(); }).then(function (d) {
      var btn = document.querySelector('.userbar .theme-btn');
      if (!btn) return;
      var el = document.getElementById('bug-dot-el');
      if (d && d.openCount > 0) {
        if (!el) {
          el = document.createElement('span');
          el.id = 'bug-dot-el';
          el.textContent = String(d.openCount);
          el.title = d.openCount + ' 条未处理反馈，点击查看';
          el.style.cssText = 'position:absolute; top:-6px; right:-6px; background:#ef4444; color:#fff; border-radius:10px; padding:0 5px; font-size:11px; line-height:16px; min-width:16px; text-align:center;';
          btn.appendChild(el);
        } else el.textContent = String(d.openCount);
      } else if (el) { el.remove(); }
    }).catch(function () { /* 忽略 */ });
  }
  function pollNotif() {
    fetch('/api/notifications/unread').then(function (r) { return r.json(); }).then(function (d) {
      var btn = document.querySelector('.user-menu-btn');
      if (!btn) return;
      var el = document.getElementById('notif-dot-el');
      if (d && d.count > 0) {
        if (!el) {
          el = document.createElement('span');
          el.id = 'notif-dot-el';
          el.title = d.count + ' 条未读反馈，点击查看';
          el.onclick = function (e) { e.stopPropagation(); gotoUnread(); };
          btn.appendChild(el);
        }
      } else if (el) { el.remove(); }
    }).catch(function () { /* 忽略 */ });
  }
  function gotoUnread() { toggleNotifPanel(); }
  // 未读反馈面板：弹出完整列表，支持逐条「查看」「标为已读」与「全部已读」
  function fmtNotifTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function notifRead(body) {
    return fetch('/api/notifications/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(function () { /* 忽略 */ });
  }
  function closeNotifPanel() {
    var p = document.getElementById('notif-panel');
    if (p) p.remove();
  }
  function toggleNotifPanel() {
    if (document.getElementById('notif-panel')) { closeNotifPanel(); return; }
    fetch('/api/notifications/unread').then(function (r) { return r.json(); }).then(function (d) {
      var items = (d && d.items) || [];
      var panel = document.createElement('div');
      panel.id = 'notif-panel';
      panel.style.cssText = 'position:fixed; top:56px; right:12px; width:340px; max-width:92vw; max-height:60vh; overflow:auto; background:var(--card,#fff); color:inherit; border:1px solid var(--line,#e2e8f0); border-radius:12px; box-shadow:0 10px 30px rgba(0,0,0,.18); z-index:9998; padding:10px 12px;';
      var html = '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px;">' +
        '<b style="font-size:14px;">未读反馈（<span id="notif-count">' + items.length + '</span>）</b>' +
        (items.length ? '<a href="#" id="notif-read-all" style="font-size:12px;">全部已读</a>' : '') + '</div>';
      if (!items.length) html += '<div class="sub" style="padding:10px 0; font-size:13px; color:#94a3b8;">没有未读反馈</div>';
      items.forEach(function (it, i) {
        var isP = it.type === 'problem';
        var isM = it.type === 'msg';
        var icon = isP ? '📢' : (isM ? '✉️' : '💬');
        var title = isP ? it.title : (isM ? ('教师消息 · ' + (it.fromName || '教师')) : ('作业评语：' + it.title));
        var snippet = isM ? String(it.text || '').split('\n')[0] : (isP ? it.text : '');
        html += '<div data-row="' + i + '" style="display:flex; align-items:center; gap:8px; padding:8px 2px; border-top:1px solid rgba(128,128,128,.15);">' +
          '<span style="flex:none;">' + icon + '</span>' +
          '<div style="flex:1; min-width:0;">' +
            '<div style="font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc(title) + '</div>' +
            (snippet ? '<div style="font-size:12px; color:#64748b; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc(snippet) + '</div>' : '') +
            '<div style="font-size:11px; color:#94a3b8;">' + fmtNotifTime(it.submittedAt || it.createdAt) + '</div>' +
          '</div>' +
          '<button class="secondary" data-view="' + i + '" style="flex:none; padding:3px 8px; font-size:12px;">查看</button>' +
          '<button class="secondary" data-dismiss="' + i + '" title="标为已读（从列表移除）" style="flex:none; padding:3px 8px; font-size:12px;">×</button>' +
        '</div>';
      });
      html += '<div style="text-align:center; padding-top:8px; border-top:1px solid rgba(128,128,128,.15); margin-top:4px;"><a href="#" id="notif-history" style="font-size:12px;">📨 历史消息</a></div>';
      panel.innerHTML = html;
      document.body.appendChild(panel);
      var readAll = document.getElementById('notif-read-all');
      if (readAll) readAll.onclick = function (e) {
        e.preventDefault();
        notifRead({ all: true }).then(function () { closeNotifPanel(); pollNotif(); });
      };
      panel.querySelectorAll('[data-view]').forEach(function (b) {
        b.onclick = function () {
          var it = items[+b.getAttribute('data-view')];
          if (!it) return;
          if (it.type === 'problem') {
            notifRead({ type: 'problem', problemId: it.problemId }).then(function () { location.href = '/problem.html?id=' + it.problemId; });
          } else if (it.type === 'msg') {
            notifRead({ type: 'msg', messageId: it.messageId }).then(function () { closeNotifPanel(); pollNotif(); openMsgModal(it); });
          } else {
            location.href = '/homework.html?id=' + it.homeworkId; // 详情页自动标记评语已读
          }
        };
      });
      panel.querySelectorAll('[data-dismiss]').forEach(function (b) {
        b.onclick = function () {
          var i = +b.getAttribute('data-dismiss');
          var it = items[i];
          if (!it) return;
          var body = it.type === 'problem' ? { type: 'problem', problemId: it.problemId }
            : (it.type === 'msg' ? { type: 'msg', messageId: it.messageId } : { type: 'hw', homeworkId: it.homeworkId });
          notifRead(body).then(function () {
            var row = panel.querySelector('[data-row="' + i + '"]');
            if (row) row.remove();
            var cnt = document.getElementById('notif-count');
            if (cnt) cnt.textContent = String(Math.max(0, parseInt(cnt.textContent, 10) - 1));
            pollNotif();
          });
        };
      });
      var hist = document.getElementById('notif-history');
      if (hist) hist.onclick = function (e) { e.preventDefault(); showMsgHistory(); };
    }).catch(function () { /* 忽略 */ });
  }
  // 点击面板外区域关闭
  document.addEventListener('click', function (e) {
    var p = document.getElementById('notif-panel');
    if (p && !p.contains(e.target) && e.target.id !== 'notif-dot-el') closeNotifPanel();
  });
  // 消息文本渲染：转义后 #提交编号 → 提交链接，http(s) URL → 外链，换行 → <br>
  function linkifyMsg(text) {
    var h = esc(text);
    h = h.replace(/(^|[\s，。；：、(（])#(\d{1,7})\b/gm, '$1<a href="/status.html?find=$2" style="color:var(--accent,#3b82f6);">#$2</a>');
    h = h.replace(/(https?:\/\/[^\s<>"']+)/g, '<a href="$1" target="_blank" rel="noopener" style="color:var(--accent,#3b82f6);">$1</a>');
    return h.replace(/\n/g, '<br>');
  }
  // 教师消息详情弹窗
  function openMsgModal(m) {
    closeMsgModal();
    var mask = document.createElement('div');
    mask.id = 'msg-mask';
    mask.style.cssText = 'position:fixed; inset:0; background:rgba(15,23,42,.45); z-index:10001; display:flex; align-items:center; justify-content:center; padding:16px;';
    mask.innerHTML = '<div style="background:var(--card,#fff); color:inherit; border:1px solid var(--line,#e2e8f0); border-radius:12px; padding:20px; width:100%; max-width:520px; box-shadow:0 10px 30px rgba(0,0,0,.18);">' +
      '<h3 style="margin:0 0 4px;">✉️ 教师消息</h3>' +
      '<div style="font-size:12px; color:#94a3b8; margin-bottom:10px;">' + esc(m.fromName || '教师') + ' · ' + fmtNotifTime(m.createdAt) + '</div>' +
      '<div style="font-size:14px; line-height:1.7; max-height:50vh; overflow:auto; word-break:break-word;">' + linkifyMsg(m.text) + '</div>' +
      '<div style="display:flex; gap:8px; justify-content:flex-end; margin-top:14px;"><button onclick="closeMsgModal()">知道了</button></div></div>';
    mask.addEventListener('click', function (e) { if (e.target === mask) closeMsgModal(); });
    document.body.appendChild(mask);
  }
  window.closeMsgModal = function () {
    var m = document.getElementById('msg-mask');
    if (m) m.remove();
  };
  function closeMsgModal() { window.closeMsgModal(); }
  // 历史消息（面板内切换视图）
  function showMsgHistory() {
    fetch('/api/messages').then(function (r) { return r.json(); }).then(function (d) {
      var panel = document.getElementById('notif-panel');
      if (!panel) return;
      var list = (d && d.list) || [];
      var html = '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px;">' +
        '<b style="font-size:14px;">📨 历史消息（' + list.length + '）</b>' +
        '<a href="#" id="notif-back" style="font-size:12px;">← 返回未读</a></div>';
      if (!list.length) html += '<div style="padding:10px 0; font-size:13px; color:#94a3b8;">还没有收到教师消息</div>';
      list.forEach(function (m, i) {
        html += '<div data-mrow="' + i + '" style="display:flex; align-items:center; gap:8px; padding:8px 2px; border-top:1px solid rgba(128,128,128,.15); cursor:pointer;' + (m.read ? ' opacity:.65;' : '') + '">' +
          '<span style="flex:none;">✉️</span>' +
          '<div style="flex:1; min-width:0;">' +
            '<div style="font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc(m.fromName || '教师') + (m.read ? '' : ' <span style="color:#ef4444;">●</span>') + '</div>' +
            '<div style="font-size:12px; color:#64748b; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc(String(m.text || '').split('\n')[0]) + '</div>' +
            '<div style="font-size:11px; color:#94a3b8;">' + fmtNotifTime(m.createdAt) + '</div>' +
          '</div></div>';
      });
      panel.innerHTML = html;
      var back = document.getElementById('notif-back');
      if (back) back.onclick = function (e) { e.preventDefault(); closeNotifPanel(); toggleNotifPanel(); };
      panel.querySelectorAll('[data-mrow]').forEach(function (row) {
        row.onclick = function () {
          var m = list[+row.getAttribute('data-mrow')];
          if (!m) return;
          if (!m.read) {
            fetch('/api/messages/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: m.id }) }).then(function () { pollNotif(); }).catch(function () { /* 忽略 */ });
          }
          openMsgModal(m);
        };
      });
    }).catch(function () { /* 忽略 */ });
  }
  function renderLoginBtn() {
    gateApplyTheme();
    var header = document.querySelector('header');
    if (header && !document.querySelector('.userbar')) {
      var bar = document.createElement('div');
      bar.className = 'userbar';
      bar.innerHTML = '<button class="theme-btn" onclick="gateToggleTheme()" title="切换主题">' + (state.theme === 'dark' ? '☀️' : '🌙') + '</button>' +
        '<button class="secondary" style="padding:5px 14px; font-size:13px;" onclick="gateLogin()">登录 / 注册</button>';
      header.appendChild(bar);
    }
  }
  // 白/黑主题
  window.gateApplyTheme = function () {
    document.body.classList.toggle('dark', state.theme === 'dark');
  };
  window.gateToggleTheme = function () {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('tgboj_theme', state.theme);
    location.reload();
  };
  // 用户名下拉菜单
  window.gateMenuToggle = function (e) {
    if (e && e.stopPropagation) e.stopPropagation();
    var d = document.getElementById('user-drop');
    if (d) d.classList.toggle('open');
  };
  window.gateMenuClose = function () {
    var d = document.getElementById('user-drop');
    if (d) d.classList.remove('open');
  };
  if (!window.__gateMenuDocListener) {
    window.__gateMenuDocListener = true;
    document.addEventListener('click', function () { gateMenuClose(); });
  }
  // 显示模式（仅管理员）：admin = 管理员界面（默认）；user = 普通用户界面
  function currentMode() { return localStorage.getItem('tgboj_mode') === 'user' ? 'user' : 'admin'; }
  window.gateIsAdminMode = function () {
    var u = state.user;
    return !!(u && (u.role === 'admin' || u.role === 'superadmin') && currentMode() === 'admin');
  };
  window.gateToggleMode = function () {
    localStorage.setItem('tgboj_mode', currentMode() === 'admin' ? 'user' : 'admin');
    location.reload();
  };
  window.gateLogout = async function () {
    await fetch('/api/auth/logout', { method: 'POST' });
    location.reload();
  };
  // 修改密码弹窗
  window.gateChangePw = function () {
    var mask = document.createElement('div');
    mask.className = 'gate-mask';
    mask.id = 'pw-mask';
    mask.innerHTML = '<div class="gate-card">' +
      '<span class="gate-close" onclick="document.getElementById(\'pw-mask\').remove()" title="关闭">×</span>' +
      '<h2>🔒 修改密码</h2>' +
      '<label>原密码</label><input id="pw-old" type="password" placeholder="原密码">' +
      '<label>新密码（至少 6 位）</label><input id="pw-new" type="password" placeholder="新密码">' +
      '<label>确认新密码</label><input id="pw-new2" type="password" placeholder="再次输入新密码">' +
      '<button id="pw-btn">确认修改</button>' +
      '<div class="gate-err" id="pw-err"></div>' +
      '<a class="gate-link" onclick="document.getElementById(\'pw-mask\').remove()">取消</a>' +
      '</div>';
    document.body.appendChild(mask);
    mask.querySelector('#pw-btn').addEventListener('click', async function () {
      var err = mask.querySelector('#pw-err');
      err.textContent = '';
      var np = mask.querySelector('#pw-new').value;
      if (np !== mask.querySelector('#pw-new2').value) { err.textContent = '两次输入的新密码不一致'; return; }
      var r = await fetch('/api/auth/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword: mask.querySelector('#pw-old').value, newPassword: np }) });
      var d = await r.json();
      if (!r.ok) { err.textContent = d.error || '修改失败'; return; }
      mask.remove();
      alert('密码已修改');
    });
  };

  // 旧口令强制改密：登录成功但口令仍是旧格式（mustChangePassword），或页面加载时检测到强制改密窗口。
  // 只有改密成功才能继续使用系统；唯一出口是「退出登录」。
  window.gateShowForcedChange = function (user, prefilledOldPw) {
    if (document.getElementById('forced-mask')) return;
    var mask = document.createElement('div');
    mask.className = 'gate-mask';
    mask.id = 'forced-mask';
    mask.innerHTML = '<div class="gate-card">' +
      '<h2>🔒 账号安全升级</h2>' +
      '<div class="gate-err" style="color:#92400e; margin-bottom:10px;">系统后端更新，为了账号安全，必须改密才能继续使用</div>' +
      '<label>原密码</label><input id="fc-old" type="password" placeholder="原密码" autocomplete="current-password">' +
      '<label>新密码（至少 7 位）</label><input id="fc-new" type="password" placeholder="新密码" autocomplete="new-password">' +
      '<label>确认新密码</label><input id="fc-new2" type="password" placeholder="再次输入新密码" autocomplete="new-password">' +
      '<button id="fc-btn">确认修改</button>' +
      '<div class="gate-err" id="fc-err"></div>' +
      '<a class="gate-link" onclick="gateLogout()">退出登录</a>' +
      '</div>';
    document.body.appendChild(mask);
    if (prefilledOldPw) mask.querySelector('#fc-old').value = prefilledOldPw;
    var doIt = async function () {
      var err = mask.querySelector('#fc-err');
      err.textContent = '';
      var np = mask.querySelector('#fc-new').value;
      if (np.length < 7) { err.textContent = '新密码至少 7 位'; return; }
      if (np !== mask.querySelector('#fc-new2').value) { err.textContent = '两次输入的新密码不一致'; return; }
      var r = await fetch('/api/auth/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword: mask.querySelector('#fc-old').value, newPassword: np }) });
      var d = await r.json();
      if (!r.ok) { err.textContent = d.error || '修改失败'; return; }
      mask.remove();
      alert('密码已修改，可以继续使用了');
      location.reload();
    };
    mask.querySelector('#fc-btn').addEventListener('click', doIt);
    mask.querySelector('#fc-new2').addEventListener('keydown', function (e) { if (e.key === 'Enter') doIt(); });
    setTimeout(function () { mask.querySelector('#fc-old').focus(); }, 50);
  };

  // 上报交互日志（登录用户；fire-and-forget）
  window.gateLog = function (action, detail) {
    try {
      fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action || 'interact', page: location.pathname + location.search, detail: detail || '' }) });
    } catch (e) { /* 静默 */ }
  };
  // 导航栏「作业/排行榜」点击 → 沿用当前期次：把 localStorage 里的期次追加到目标 URL（?session=N），
  // 使作业/排行榜两页切换时保持同一期次；无记忆则回默认当前期。
  function bindNavSessionCarry() {
    var links = document.querySelectorAll('nav a[href]');
    for (var i = 0; i < links.length; i++) {
      (function (a) {
        var path = (a.getAttribute('href') || '').split('?')[0];
        if (path === '/homework.html' || path === '/rank.html') {
          a.addEventListener('click', function () {
            var sess = null;
            try { sess = localStorage.getItem('tgboj_hw_session'); } catch (e) { /* ignore */ }
            var n = parseInt(sess, 10);
            a.setAttribute('href', n > 0 ? (path + '?session=' + n) : path);
          });
        }
      })(links[i]);
    }
  }
  // 注入默认导航 header（若页面未手写；各页统一，改导航只需改这里）
  function ensureHeader() {
    if (document.querySelector('header')) return;
    var header = document.createElement('header');
    header.innerHTML = '<span class="logo">⚡ TGBOJ</span>' +
      '<nav>' +
      '<a href="/">首页</a>' +
      '<a href="/problems.html">题目列表</a>' +
      '<a href="/homework.html">作业</a>' +
      '<a href="/status.html">评测状态</a>' +
      '<a href="/wrong.html">错题本</a>' +
      '<a href="/rank.html">排行榜</a>' +
      '<a href="/contest.html">比赛</a>' +
      '<a href="/files.html">附件</a>' +
      '<a href="/about.html">说明</a>' +
      '</nav>';
    document.body.insertBefore(header, document.body.firstChild);
  }
  // 全站公告横幅（首页/任意页顶部，可关闭；同一公告本次会话只显示一次）
  async function loadGlobalNotice() {
    try {
      var nd = await (await fetch('/api/notice')).json();
      if (!nd || !nd.text) return;
      if (sessionStorage.getItem('tgboj_notice_ts') === String(nd.createdAt)) return;
      var bar = document.createElement('div');
      bar.style.cssText = 'background:#fef3c7; color:#92400e; padding:8px 16px; font-size:13px; border-bottom:1px solid #fcd34d; display:flex; gap:10px; align-items:center;';
      var span = document.createElement('span');
      span.style.cssText = 'flex:1; white-space:pre-wrap;';
      span.textContent = nd.text;
      var btn = document.createElement('button');
      btn.textContent = '✕';
      btn.style.cssText = 'border:none; background:none; cursor:pointer; font-size:14px; color:#92400e;';
      btn.onclick = function () { sessionStorage.setItem('tgboj_notice_ts', String(nd.createdAt)); bar.remove(); };
      bar.appendChild(span); bar.appendChild(btn);
      document.body.insertBefore(bar, document.body.firstChild);
    } catch (e) { /* ignore */ }
  }
  async function init() {
    gateApplyTheme();
    ensureHeader();
    bindNavSessionCarry();
    loadGlobalNotice();
    var d;
    try { d = await (await fetch('/api/auth/me')).json(); } catch (e) { return; }
    if (d.user) {
      state.user = d.user;
      if (d.mustChangePassword) { renderUser(d.user); window.gateShowForcedChange(d.user, null); return; }
      renderUser(d.user);
      setTimeout(function () { window.dispatchEvent(new CustomEvent('tgboj:auth')); }, 0);
      // 自动记录页面访问
      setTimeout(function () { window.gateLog('page_view', location.pathname + location.search); }, 200);
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') window.gateLog('page_leave', location.pathname);
      });
    }
    else if (REQUIRED) showGate(null);
    else renderLoginBtn();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

// 复制文本：点击手势内同步优先 execCommand（HTTP 局域网与各浏览器最可靠）；
// 同步失败再试 Clipboard API（HTTPS），最后才弹窗手动复制
function copyText(txt, done) {
  const finish = function () { if (typeof done === 'function') done(); };
  if (legacyCopy(txt)) { finish(); return; }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(finish).catch(function () { prompt('请手动复制：', txt); });
  } else prompt('请手动复制：', txt);
}
function legacyCopy(txt) {
  var ta = document.createElement('textarea');
  ta.value = txt;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  var ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  return ok;
}
