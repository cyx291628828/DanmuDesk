// DanmuDesk 渲染进程逻辑
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const els = {
    roomInput: $('roomInput'),
    historyPanel: $('historyPanel'),
    historyList: $('historyList'),
    historyClear: $('historyClear'),
    connectBtn: $('connectBtn'),
    roomInfo: $('roomInfo'),
    messages: $('messages'),
    clearBtn: $('clearBtn'),
    pauseBtn: $('pauseBtn'),
    toast: $('toast'),
    roomList: $('roomList'),
    // 左侧底部发送坞
    sendDock: $('sendDock'),
    sendTarget: $('sendTarget'),
    sendInput: $('sendInput'),
    sendBtn: $('sendBtn'),
    schedOpenBtn: $('schedOpenBtn'),
    // 授权
    licenseChip: $('licenseChip'),
    licenseModal: $('licenseModal'),
    licenseModalClose: $('licenseModalClose'),
    licenseStatusText: $('licenseStatusText'),
    licenseMachine: $('licenseMachine'),
    licenseCopyMachine: $('licenseCopyMachine'),
    licenseKeyInput: $('licenseKeyInput'),
    licenseActivateBtn: $('licenseActivateBtn'),
    licenseResult: $('licenseResult'),
    // 定时弹幕弹窗
    schedModal: $('schedModal'),
    schedModalTitle: $('schedModalTitle'),
    schedModalClose: $('schedModalClose'),
    modalSchedContent: $('modalSchedContent'),
    modalSchedInterval: $('modalSchedInterval'),
    modalSchedAdd: $('modalSchedAdd'),
    modalSchedList: $('modalSchedList'),
    userTrigger: $('userTrigger'),
    userIconFallback: $('userIconFallback'),
    loginAvatar: $('loginAvatar'),
    userPopover: $('userPopover'),
    guestView: $('guestView'),
    userView: $('userView'),
    loginBtn: $('loginBtn'),
    logoutBtn: $('logoutBtn'),
    popoverAvatar: $('popoverAvatar'),
    popoverAvatarFallback: $('popoverAvatarFallback'),
    popoverName: $('popoverName'),
    popoverDisplayId: $('popoverDisplayId'),
    popoverFans: $('popoverFans'),
    popoverFollowing: $('popoverFollowing'),
  };

  // 消息类型元数据（标签+颜色）
  const FILTER_TYPES = [
    { key: 'chat', label: '弹幕' },
    { key: 'gift', label: '礼物' },
    { key: 'enter', label: '进场' },
    { key: 'like', label: '点赞' },
    { key: 'follow', label: '关注' },
    { key: 'sys', label: '系统' },
  ];

  // 多房间状态
  const rooms = new Map(); // roomId -> { messages, stats, filters, anchorInfo, status, onlineCount, uptimeTimer, startTs, paused, forwardState }
  let activeRoomId = null;
  const MAX_MSGS = 500;
  let paused = false;

  // ---- 房间号解析 ----
  function parseRoomId(input) {
    const s = (input || '').trim();
    if (!s) return null;
    const m = s.match(/(?:live\.douyin\.com\/|douyin\.com\/)?(\d{4,})/);
    if (m) return m[1];
    if (/^\d{4,}$/.test(s)) return s;
    return null;
  }

  // ---- 数字美化 ----
  function formatCount(n) {
    const v = Number(n);
    if (!isFinite(v) || v <= 0) return '-';
    if (v >= 100000000) return (v / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
    if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + '万';
    return String(v);
  }

  // ---- 历史时间显示：今天→HH:mm，昨天→昨天 HH:mm，今年→MM-DD HH:mm，往年→完整日期 ----
  function formatHistoryTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.toDateString() === now.toDateString()) return hm;
    const yst = new Date(now);
    yst.setDate(now.getDate() - 1);
    if (d.toDateString() === yst.toDateString()) return `昨天 ${hm}`;
    if (d.getFullYear() === now.getFullYear()) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // ---- 直播间手风琴管理（右侧） ----
  function createRoomItem(roomId) {
    const existing = document.querySelector(`.room-item[data-room="${roomId}"]`);
    if (existing) {
      expandRoom(roomId);
      return;
    }
    const room = rooms.get(roomId);
    if (!room) return;
    const item = document.createElement('div');
    item.className = 'room-item open';
    item.dataset.room = roomId;

    // 头部
    const head = document.createElement('div');
    head.className = 'room-head';
    head.title = '点击展开/收起';
    head.addEventListener('click', () => {
      if (item.classList.contains('open')) item.classList.remove('open');
      else expandRoom(roomId);
    });
    const avatar = document.createElement('img');
    avatar.className = 'room-avatar';
    avatar.alt = '';
    avatar.referrerPolicy = 'no-referrer';
    avatar.src = room.anchorInfo.avatar || '';
    avatar.hidden = !room.anchorInfo.avatar;
    avatar.onerror = () => { avatar.hidden = true; fb.hidden = false; };
    const fb = document.createElement('span');
    fb.className = 'room-avatar-fallback';
    fb.textContent = (room.anchorInfo.nickname || '?').trim().charAt(0);
    fb.hidden = !!room.anchorInfo.avatar;
    head.appendChild(avatar);
    head.appendChild(fb);
    const info = document.createElement('div');
    info.className = 'room-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'room-name';
    nameEl.textContent = room.anchorInfo.nickname || `直播间 ${roomId}`;
    nameEl.title = roomId;
    const metaEl = document.createElement('div');
    metaEl.className = 'room-meta';
    metaEl.textContent = `关注 ${formatCount(room.anchorInfo.followingCount)} · 粉丝 ${formatCount(room.anchorInfo.followerCount)}`;
    const titleEl = document.createElement('div');
    titleEl.className = 'room-title';
    titleEl.textContent = room.anchorInfo.liveTitle || '';
    info.appendChild(nameEl);
    info.appendChild(metaEl);
    info.appendChild(titleEl);
    head.appendChild(info);
    const arrow = document.createElement('span');
    arrow.className = 'room-arrow';
    arrow.textContent = '▾';
    head.appendChild(arrow);
    const close = document.createElement('button');
    close.className = 'room-close';
    close.title = '断开该直播间';
    close.textContent = '×';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`确定断开直播间 ${roomId} 吗？`)) return;
      window.danmu.disconnect(roomId).then((res) => {
        if (res && res.ok) removeRoomItem(roomId);
      });
    });
    head.appendChild(close);
    item.appendChild(head);

    // 展开区
    const body = document.createElement('div');
    body.className = 'room-body';

    // 统计
    const stats = document.createElement('div');
    stats.className = 'room-stats';
    const statKeys = [
      ['online', '在线人数', true],
      ['chat', '弹幕', false],
      ['gift', '礼物', false],
      ['enter', '进场', false],
      ['like', '点赞', false],
      ['follow', '关注', false],
      ['likes', '本场总赞', false],
      ['uptime', '连接时长', false],
    ];
    statKeys.forEach(([k, label, online]) => {
      const s = document.createElement('div');
      s.className = 'room-stat';
      const lb = document.createElement('span');
      lb.className = 'rs-label';
      lb.textContent = label;
      const vl = document.createElement('span');
      vl.className = 'rs-value' + (online ? ' online' : '');
      vl.dataset.k = k;
      vl.textContent = k === 'online' ? '-' : k === 'uptime' ? '00:00' : '0';
      s.appendChild(lb);
      s.appendChild(vl);
      stats.appendChild(s);
    });
    body.appendChild(stats);

    // 消息类型过滤（每房间独立）
    const filterTitle = document.createElement('div');
    filterTitle.className = 'room-section-title';
    filterTitle.textContent = '消息类型';
    body.appendChild(filterTitle);
    const filterWrap = document.createElement('div');
    filterWrap.className = 'room-filters';
    FILTER_TYPES.forEach(({ key, label }) => {
      const lbl = document.createElement('label');
      lbl.className = 'room-filter';
      lbl.dataset.filter = key;
      const inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.checked = room.filters[key] !== false;
      inp.addEventListener('change', () => {
        room.filters[key] = inp.checked;
        // 即时过滤当前显示的消息
        if (activeRoomId === roomId) {
          els.messages.querySelectorAll('.msg').forEach((row) => {
            const type = row.classList[1];
            if (type === key) row.style.display = inp.checked ? '' : 'none';
          });
        }
        // 同步主进程（决定日志/转发）
        window.danmu.setFilters(roomId, room.filters);
      });
      lbl.appendChild(inp);
      const span = document.createElement('span');
      span.textContent = label;
      lbl.appendChild(span);
      filterWrap.appendChild(lbl);
    });
    body.appendChild(filterWrap);

    // 消息转发（每房间独立 WS）
    const fwdTitle = document.createElement('div');
    fwdTitle.className = 'room-section-title';
    fwdTitle.textContent = '消息转发';
    body.appendChild(fwdTitle);
    const fwdWrap = document.createElement('div');
    fwdWrap.className = 'room-forward';

    // 第一行：URL 输入 + 连接/断开按钮 + 状态标签
    const fwdRow = document.createElement('div');
    fwdRow.className = 'room-forward-row';
    const fwdUrl = document.createElement('input');
    fwdUrl.type = 'text';
    fwdUrl.className = 'forward-url';
    fwdUrl.placeholder = 'ws://127.0.0.1:8080';
    fwdUrl.spellcheck = false;
    fwdUrl.value = room.forwardUrl || '';
    fwdRow.appendChild(fwdUrl);
    const fwdBtn = document.createElement('button');
    fwdBtn.className = 'room-forward-btn connect';
    fwdBtn.textContent = '连接';
    fwdBtn.addEventListener('click', () => {
      const url = fwdUrl.value.trim();
      if (fwdBtn.classList.contains('connect')) {
        // 连接
        if (!url) { showToast('请填写 WS 地址'); return; }
        window.danmu.forwardConnect(roomId, url);
      } else {
        // 断开
        window.danmu.forwardDisconnect(roomId);
      }
    });
    fwdRow.appendChild(fwdBtn);
    const fwdState = document.createElement('span');
    fwdState.className = 'forward-state-tag';
    fwdState.textContent = '未连接';
    fwdRow.appendChild(fwdState);
    fwdWrap.appendChild(fwdRow);

    body.appendChild(fwdWrap);

    item.appendChild(body);

    els.roomList.insertBefore(item, els.roomList.firstChild);
    expandRoom(roomId);

    // 初始化：同步过滤到主进程
    window.danmu.setFilters(roomId, room.filters);
    // 初始化：读取持久化的转发配置
    window.danmu.forwardGet(roomId).then((res) => {
      if (res && res.ok) {
        if (res.url) fwdUrl.value = res.url;
        room.forwardUrl = res.url || '';
        // 新会话 WS 未连接，按钮=连接，开关禁用
        fwdBtn.textContent = '连接';
        fwdBtn.classList.add('connect');
        fwdBtn.classList.remove('disconnect');
        fwdBtn.disabled = false;
        fwdState.textContent = '未连接';
        fwdState.style.color = '#5d6472';
      }
    });
  }

  function removeRoomItem(roomId) {
    const item = document.querySelector(`.room-item[data-room="${roomId}"]`);
    if (item) item.remove();
    rooms.delete(roomId);
    if (activeRoomId === roomId) {
      const next = [...rooms.keys()][0];
      if (next) expandRoom(next);
      else showEmptyState();
    }
  }

  function expandRoom(roomId) {
    activeRoomId = roomId;
    document.querySelectorAll('.room-item').forEach(it => {
      it.classList.toggle('open', it.dataset.room === roomId);
    });
    const room = rooms.get(roomId);
    if (room) {
      renderRoomPanel(room);
      restoreMessages(room);
    }
    closeSchedModal(); // 切换直播间后弹窗内容会跟着变，直接关闭避免误解
    refreshSendDock();
  }

  function showEmptyState() {
    activeRoomId = null;
    els.roomInfo.textContent = '未连接直播间';
    els.messages.innerHTML = '<div class="empty-tip">输入房间号，点击「新增连接」开始接收弹幕</div>';
    refreshSendDock();
  }

  function renderRoomPanel(room) {
    const item = document.querySelector(`.room-item[data-room="${room.roomId}"]`);
    if (!item) return;
    const nameEl = item.querySelector('.room-name');
    if (nameEl) nameEl.textContent = room.anchorInfo.nickname || `直播间 ${room.roomId}`;
    const metaEl = item.querySelector('.room-meta');
    if (metaEl) metaEl.textContent = `关注 ${formatCount(room.anchorInfo.followingCount)} · 粉丝 ${formatCount(room.anchorInfo.followerCount)}`;
    const titleEl = item.querySelector('.room-title');
    if (titleEl) titleEl.textContent = room.anchorInfo.liveTitle || '';
    const statMap = {
      online: room.onlineCount != null ? room.onlineCount : '-',
      chat: room.stats.chat || 0,
      gift: room.stats.gift || 0,
      enter: room.stats.enter || 0,
      like: room.stats.like || 0,
      follow: room.stats.follow || 0,
      likes: room.anchorInfo.likeCount != null ? formatCount(room.anchorInfo.likeCount) : '-',
    };
    Object.entries(statMap).forEach(([k, v]) => {
      const el = item.querySelector(`.rs-value[data-k="${k}"]`);
      if (el) el.textContent = v;
    });
    const av = item.querySelector('.room-avatar');
    const fb = item.querySelector('.room-avatar-fallback');
    if (av && room.anchorInfo.avatar) {
      if (av.src !== room.anchorInfo.avatar) av.src = room.anchorInfo.avatar;
      av.hidden = false; if (fb) fb.hidden = true;
    } else if (av) {
      av.hidden = true; if (fb) {
        fb.hidden = false;
        fb.textContent = (room.anchorInfo.nickname || '?').trim().charAt(0) || '?';
      }
    }
    if (room.startTime && item.classList.contains('open')) {
      startUptime(room.startTime);
    }
  }

  function restoreMessages(room) {
    els.messages.innerHTML = '';
    if (room.messages && room.messages.length > 0) {
      room.messages.slice(-MAX_MSGS).forEach(msg => appendMessage(msg));
    } else {
      els.messages.innerHTML = '<div class="empty-tip">等待弹幕...</div>';
    }
  }

  const TYPE_META = {
    chat:   { label: '弹幕', color: '#7fb4ff' },
    gift:   { label: '礼物', color: '#ffb74d' },
    enter:  { label: '进场', color: '#2ecc71' },
    like:   { label: '点赞', color: '#ff7ab8' },
    follow: { label: '关注', color: '#9d7bff' },
    sys:    { label: '系统', color: '#9aa1b0' },
  };

  // 秒级时间戳 → HH:MM:SS（消息行时间显示；无/非法时用当前时间）
  function formatMsgTime(sec) {
    let n = Number(sec);
    if (!sec || !isFinite(n) || n <= 0) n = Date.now();
    if (n < 1e12) n *= 1000;
    const d = new Date(n);
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function renderMessage(msg) {
    // 按房间独立过滤
    const room = rooms.get(msg.roomId);
    if (room && room.filters[msg.type] === false) return;
    if (msg.type === 'sys' && !msg.user && !(msg.content || '').trim()) return;

    const row = document.createElement('div');
    row.className = `msg ${msg.type}`;

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = TYPE_META[msg.type]?.label || msg.type;
    row.appendChild(badge);

    // 消息时间（弹幕自身发送时间，只显示时分秒）
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = formatMsgTime(msg.time);
    time.title = '消息时间';
    row.appendChild(time);

    if (msg.user?.avatar) {
      const avatar = document.createElement('img');
      avatar.className = 'avatar';
      avatar.src = msg.user.avatar;
      avatar.alt = '';
      avatar.loading = 'lazy';
      avatar.referrerPolicy = 'no-referrer';
      avatar.title = msg.user.nickname || '观众头像';
      avatar.onerror = () => {
        const fb = document.createElement('span');
        fb.className = 'avatar-fallback';
        fb.textContent = (msg.user?.nickname || '?').trim().charAt(0);
        fb.title = avatar.title;
        avatar.replaceWith(fb);
      };
      row.appendChild(avatar);
    }

    const uname = document.createElement('span');
    uname.className = 'uname';
    uname.textContent = msg.user?.nickname || (msg.type === 'sys' ? '' : '未知用户');
    {
      const u = msg.user || {};
      const tips = [`UID: ${u.id || '-'}`];
      if (u.displayId) tips.push(`抖音号: ${u.displayId}`);
      if (u.followerCount !== undefined) tips.push(`粉丝: ${u.followerCount}`);
      if (u.followingCount !== undefined) tips.push(`关注: ${u.followingCount}`);
      if (u.payLevel !== undefined) tips.push(`消费等级: ${u.payLevel}`);
      if (u.fansClubName) tips.push(`粉丝团: ${u.fansClubName} Lv.${u.fansClubLevel ?? '-'}`);
      if (u.gender === 1) tips.push('男');
      if (u.gender === 2) tips.push('女');
      uname.title = tips.join(' ｜ ');
    }
    row.appendChild(uname);

    const uInfo = msg.user || {};
    if (uInfo.payLevel !== undefined) {
      const plv = document.createElement('span');
      plv.className = 'u-tag pay';
      plv.textContent = `Lv.${uInfo.payLevel}`;
      plv.title = '消费等级（财富等级）';
      row.appendChild(plv);
    }
    if (uInfo.fansClubName || uInfo.fansClubLevel !== undefined) {
      const club = document.createElement('span');
      club.className = 'u-tag club';
      club.textContent = uInfo.fansClubName
        ? (uInfo.fansClubLevel !== undefined ? `${uInfo.fansClubName}·${uInfo.fansClubLevel}` : uInfo.fansClubName)
        : `粉丝团 Lv.${uInfo.fansClubLevel}`;
      club.title = `粉丝团：${uInfo.fansClubName || '未知'} Lv.${uInfo.fansClubLevel ?? '-'}`;
      row.appendChild(club);
    }
    if (uInfo.followerCount !== undefined && Number(uInfo.followerCount) > 0) {
      const fans = document.createElement('span');
      fans.className = 'u-tag fans';
      fans.textContent = `粉丝 ${uInfo.followerCount}`;
      fans.title = '粉丝数';
      row.appendChild(fans);
    }

    const content = document.createElement('span');
    content.className = 'content';
    if (msg.type === 'gift') {
      const giftName = document.createElement('span');
      giftName.className = 'gift-name';
      giftName.textContent = msg.giftName || '礼物';
      content.appendChild(document.createTextNode('送出 '));
      content.appendChild(giftName);
      content.appendChild(document.createTextNode(` × ${msg.giftCount ?? 1}`));
      if (msg.repeatCount > 1) content.appendChild(document.createTextNode(`（连击 ${msg.repeatCount}）`));
    } else if (msg.type === 'enter') {
      content.textContent = '进入直播间';
    } else if (msg.type === 'like') {
      const cnt = msg.likeCount ?? 1;
      const total = msg.likeTotal !== undefined ? `（总赞 ${msg.likeTotal}）` : '';
      content.textContent = `点赞 ×${cnt}${total}`;
    } else if (msg.type === 'follow') {
      content.textContent = '关注了主播';
    } else if (msg.type === 'sys') {
      content.textContent = msg.content || '';
    } else {
      content.textContent = msg.content || '';
    }
    row.appendChild(content);
    return row;
  }

  function appendMessage(msg) {
    const row = renderMessage(msg);
    if (!row) return;

    const prev = els.messages.lastElementChild;
    const sameBatch = prev && prev.classList.contains('msg') && msg.batch && prev.dataset.batch === String(msg.batch);

    if (prev && prev.classList.contains('empty-tip')) prev.remove();

    if (sameBatch && prev.dataset.type === msg.type && msg.user && prev.dataset.uid === String(msg.user.id)) {
      const cnt = prev.dataset.cnt ? parseInt(prev.dataset.cnt) + 1 : 2;
      prev.dataset.cnt = cnt;
      let cntEl = prev.querySelector('.content .batch-cnt');
      if (!cntEl) {
        cntEl = document.createElement('span');
        cntEl.className = 'batch-cnt';
        cntEl.style.cssText = 'color:#5d6472;font-size:11px;margin-left:6px;';
        prev.querySelector('.content').appendChild(cntEl);
      }
      cntEl.textContent = `(${cnt})`;
    } else {
      row.dataset.type = msg.type;
      row.dataset.uid = msg.user?.id ?? '';
      row.dataset.batch = msg.batch ?? '';
      els.messages.appendChild(row);
    }

    while (els.messages.children.length > MAX_MSGS) {
      els.messages.removeChild(els.messages.firstElementChild);
    }

    if (!paused) els.messages.scrollTop = els.messages.scrollHeight;
  }

  function addStat(type, roomId) {
    const rid = roomId || activeRoomId;
    if (!rid) return;
    const room = rooms.get(rid);
    if (room && room.stats[type] !== undefined) {
      room.stats[type]++;
      const item = document.querySelector(`.room-item[data-room="${rid}"]`);
      if (item) {
        const el = item.querySelector(`.rs-value[data-k="${type}"]`);
        if (el) el.textContent = room.stats[type];
      }
    }
  }

  function updateAnchorCard(extra) {
    if (!extra) return;
    const rid = extra.roomId || activeRoomId;
    const room = rid ? rooms.get(rid) : null;
    if (!room) return;
    const name = extra.anchorName || extra.nickname || '';
    const avatar = extra.anchorAvatar || extra.avatar || '';
    if (name || avatar) {
      if (name) room.anchorInfo.nickname = name;
      if (avatar) room.anchorInfo.avatar = avatar;
      if (extra.liveTitle) room.anchorInfo.liveTitle = extra.liveTitle;
      const follower = extra.anchorFollowerCount !== undefined ? extra.anchorFollowerCount : extra.followerCount;
      const following = extra.anchorFollowingCount !== undefined ? extra.anchorFollowingCount : extra.followingCount;
      const likes = extra.anchorLikeCount !== undefined ? extra.anchorLikeCount : extra.likeCount;
      if (follower !== undefined && follower !== null && follower !== '') room.anchorInfo.followerCount = follower;
      if (following !== undefined && following !== null && following !== '') room.anchorInfo.followingCount = following;
      if (likes !== undefined && likes !== null && likes !== '') room.anchorInfo.likeCount = likes;
      renderRoomPanel(room);
      refreshSendDock(); // 主播名到达后更新发送坞的「发送到：xxx」标签
    }
  }

  // ---- 状态更新 ----
  let connectingRoomId = null;
  function setStatus(state, text, extra) {
    if (state === 'connecting' && extra?.roomId) {
      connectingRoomId = extra.roomId;
      els.connectBtn.classList.add('connecting');
      els.connectBtn.textContent = '断开连接';
      els.connectBtn.disabled = false;
      els.connectBtn.title = `正在连接 ${extra.roomId}... 点击取消`;
    } else {
      connectingRoomId = null;
      els.connectBtn.classList.remove('connecting', 'connected', 'error');
      if (state === 'error') els.connectBtn.classList.add('error');
      els.connectBtn.textContent = '新增连接';
      els.connectBtn.disabled = false;
      els.connectBtn.title = '输入房间号添加新直播间';
    }
    els.connectBtn.title = text || els.connectBtn.title;
    if (state === 'connected' && extra?.roomId) {
      const room = rooms.get(extra.roomId);
      if (room) {
        room.status = 'connected';
        if (extra.anchorName) room.anchorInfo.nickname = extra.anchorName;
        if (extra.liveTitle) room.anchorInfo.liveTitle = extra.liveTitle;
        if (extra.anchorAvatar) room.anchorInfo.avatar = extra.anchorAvatar;
      }
      updateAnchorCard(extra);
      if (activeRoomId === extra.roomId) {
        els.roomInfo.textContent = extra.anchorName ? `${extra.anchorName} (${extra.roomId})` : `直播间 ${extra.roomId}`;
      }
    }
  }

  function showToast(text, ms = 6000) {
    els.toast.textContent = text;
    els.toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => els.toast.classList.remove('show'), ms);
  }

  // ---- 转发状态更新（按房间路由到对应 UI） ----
  function updateForwardUI(roomId, state, msg) {
    const item = document.querySelector(`.room-item[data-room="${roomId}"]`);
    if (!item) return;
    const stateTag = item.querySelector('.forward-state-tag');
    const btn = item.querySelector('.room-forward-btn');
    const toggle = item.querySelector('.forward-enable');
    const map = {
      disconnected: ['未连接', '#5d6472'],
      connecting: ['连接中...', '#ffd28a'],
      connected: ['已连接', '#2ecc71'],
      error: ['连接失败', '#ff3b5c'],
    };
    const hit = map[state] || ['-', '#5d6472'];
    if (stateTag) {
      stateTag.textContent = hit[0] + (msg && state !== 'connected' ? `：${msg}` : '');
      stateTag.style.color = hit[1];
    }
    if (btn) {
      if (state === 'connected') {
        btn.textContent = '断开';
        btn.classList.remove('connect');
        btn.classList.add('disconnect');
        btn.disabled = false;
        if (toggle) toggle.disabled = false;
      } else if (state === 'connecting') {
        btn.textContent = '连接中';
        btn.classList.remove('disconnect');
        btn.classList.add('connect');
        btn.disabled = true;
        if (toggle) { toggle.disabled = true; toggle.checked = false; }
      } else {
        btn.textContent = '连接';
        btn.classList.remove('disconnect');
        btn.classList.add('connect');
        btn.disabled = false;
        if (toggle) { toggle.disabled = true; toggle.checked = false; }
      }
    }
  }

  // ---- IPC 绑定 ----
  window.danmu.onStatus((s) => {
    if (s.state === 'room-invalid') {
      if (s.msg) showToast(s.msg, 6000);
      return;
    }
    setStatus(s.state, s.msg || '', s);
    if (s.roomId) {
      const room = rooms.get(s.roomId);
      if (room) {
        room.status = s.state;
        if (s.onlineCount !== undefined && s.onlineCount !== null) {
          room.onlineCount = s.onlineCount;
          const item = document.querySelector(`.room-item[data-room="${s.roomId}"]`);
          if (item) {
            const el = item.querySelector('.rs-value[data-k="online"]');
            if (el) el.textContent = s.onlineCount;
          }
        }
      }
    }
    if ((s.state === 'disconnected' || s.state === 'error') && s.roomId && rooms.has(s.roomId)) {
      const r = rooms.get(s.roomId);
      if (r && r.autoRemoved !== true) {
        r.autoRemoved = true;
        removeRoomItem(s.roomId);
        if (s.msg) showToast(`[${s.roomId}] ${s.msg}`, 5000);
      }
    }
  });

  window.danmu.onMessage((m) => {
    const room = rooms.get(m.roomId);
    if (!room) return;
    room.messages.push(m);
    if (room.messages.length > MAX_MSGS) room.messages.splice(0, room.messages.length - MAX_MSGS);
    addStat(m.type, m.roomId);
    if (m.type === 'like' && m.likeTotal !== undefined && m.likeTotal !== null) {
      room.anchorInfo.likeCount = m.likeTotal;
      const item = document.querySelector(`.room-item[data-room="${m.roomId}"]`);
      if (item) {
        const el = item.querySelector('.rs-value[data-k="likes"]');
        if (el) el.textContent = formatCount(m.likeTotal);
      }
    }
    if (activeRoomId === m.roomId) {
      appendMessage(m);
    }
  });

  window.danmu.onAnchor((a) => {
    if (a && a.roomId) {
      const room = rooms.get(a.roomId);
      if (room) {
        room.anchorInfo = { ...room.anchorInfo, ...a };
        renderRoomPanel(room);
      }
    }
  });

  window.danmu.onError((err) => {
    showToast('错误：' + (err?.msg || JSON.stringify(err)));
  });

  window.danmu.onForwardStatus((s) => {
    if (!s.roomId) return;
    updateForwardUI(s.roomId, s.state, s.msg);
  });

  // 发送结果推送（定时任务的异步发送结果走这里；手动发送结果由调用处直接 toast）
  window.danmu.onSendStatus((s) => {
    if (!s.taskId) return;
    if (s.state === 'sent' && s.scheduled) {
      showToast(`定时任务发送成功：${String(s.content || '').slice(0, 15)}`, 2000);
    } else if (s.state === 'send-failed') {
      showToast(`定时任务发送失败：${s.msg || '未知原因'}`, 4500);
    }
  });

  // 任务列表被主进程变更（房间断开移除任务等）→ 刷新列表
  window.danmu.onScheduleChanged(() => {
    refreshSchedList();
  });

  // ---- 操作 ----
  // 用户主动取消连接的标记：取消后 connect 返回的 {ok:false} 不再重复弹错误 toast
  let connectCancelRequested = false;
  function doConnect() {
    const roomId = parseRoomId(els.roomInput.value);
    if (!roomId) {
      showToast('请输入有效的房间号或直播间链接');
      return;
    }
    if (rooms.has(roomId)) {
      showToast(`直播间 ${roomId} 已在监听中`, 3000);
      expandRoom(roomId);
      els.roomInput.value = '';
      return;
    }
    connectCancelRequested = false;
    els.roomInput.value = '';
    window.danmu.connect(roomId).then((res) => {
      if (res && !res.ok) {
        // 用户主动取消的场景已在取消时提示过「已取消连接」，不再重复报错
        if (!connectCancelRequested) showToast(res.msg || '连接失败');
        connectCancelRequested = false;
      } else {
        const room = {
          roomId,
          messages: [],
          stats: { chat: 0, gift: 0, enter: 0, like: 0, follow: 0 },
          filters: { chat: true, gift: true, enter: true, like: true, follow: true, sys: true },
          anchorInfo: { nickname: '', avatar: '', liveTitle: '' },
          status: 'connecting',
          onlineCount: null,
          startTime: Date.now(),
          forwardUrl: '',
          forwardState: 'disconnected',
        };
        rooms.set(roomId, room);
        createRoomItem(roomId);
      }
    });
  }

  els.connectBtn.addEventListener('click', () => {
    if (connectingRoomId) {
      connectCancelRequested = true;
      window.danmu.disconnect(connectingRoomId).then((res) => {
        if (res && res.ok) {
          connectingRoomId = null;
          els.connectBtn.classList.remove('connecting', 'error');
          els.connectBtn.textContent = '新增连接';
          els.connectBtn.title = '输入房间号添加新直播间';
          showToast('已取消连接', 2000);
        }
      });
      return;
    }
    doConnect();
  });
  els.roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doConnect(); });

  els.clearBtn.addEventListener('click', () => {
    els.messages.innerHTML = '';
    const tip = document.createElement('div');
    tip.className = 'empty-tip';
    tip.textContent = '等待弹幕...';
    els.messages.appendChild(tip);
    const room = rooms.get(activeRoomId);
    if (room) room.messages = [];
  });

  els.pauseBtn.addEventListener('click', () => {
    paused = !paused;
    els.pauseBtn.textContent = paused ? '继续滚动' : '暂停滚动';
    els.pauseBtn.style.color = paused ? '#ffd28a' : '';
    if (!paused) els.messages.scrollTop = els.messages.scrollHeight;
  });

  // ---- 抖音登录 ----
  let currentUserInfo = null;
  // 登录态（发送弹幕/礼物过滤的启用依据；异步刷新前按未登录处理）
  let isLoggedIn = false;

  function showLoginUser(info) {
    currentUserInfo = info || {};
    const avatar = currentUserInfo.avatar || '';
    if (avatar) {
      els.loginAvatar.hidden = false;
      els.loginAvatar.src = avatar;
      els.userIconFallback.hidden = true;
      els.loginAvatar.onerror = () => {
        els.loginAvatar.hidden = true;
        els.userIconFallback.hidden = false;
      };
    } else {
      els.loginAvatar.hidden = true;
      els.userIconFallback.hidden = false;
    }
    els.userView.hidden = false;
    els.guestView.hidden = true;
    els.popoverName.textContent = currentUserInfo.nickname || '-';
    els.popoverName.title = currentUserInfo.nickname || '';
    els.popoverDisplayId.textContent = currentUserInfo.displayId ? `抖音号: ${currentUserInfo.displayId}` : '';
    els.popoverDisplayId.hidden = !currentUserInfo.displayId;
    els.popoverFans.textContent = formatCount(currentUserInfo.followerCount);
    els.popoverFollowing.textContent = formatCount(currentUserInfo.followingCount);
    const pa = currentUserInfo.avatar || '';
    if (pa) {
      els.popoverAvatar.hidden = false;
      els.popoverAvatarFallback.hidden = true;
      els.popoverAvatar.src = pa;
      els.popoverAvatar.onerror = () => {
        els.popoverAvatar.hidden = true;
        els.popoverAvatarFallback.hidden = false;
        els.popoverAvatarFallback.textContent = (currentUserInfo.nickname || '?').trim().charAt(0);
      };
    } else {
      els.popoverAvatar.hidden = true;
      els.popoverAvatarFallback.hidden = false;
      els.popoverAvatarFallback.textContent = (currentUserInfo.nickname || '?').trim().charAt(0);
    }
  }

  function hideLoginUser() {
    currentUserInfo = null;
    els.loginAvatar.hidden = true;
    els.loginAvatar.removeAttribute('src');
    els.userIconFallback.hidden = false;
    els.userView.hidden = true;
    els.guestView.hidden = false;
  }

  async function refreshLoginUI() {
    try {
      const res = await window.danmu.checkLogin();
      if (res?.loggedIn) {
        if (res.userInfo) showLoginUser(res.userInfo);
        else showLoginUser({ nickname: '已登录' });
        updateLoginGating(true);
      } else {
        hideLoginUser();
        updateLoginGating(false);
      }
    } catch (_) {}
  }
  refreshLoginUI();

  // 登录门控：礼物过滤勾选框 + 左侧发送坞（未登录一律禁用并提示）
  function updateLoginGating(loggedIn) {
    isLoggedIn = !!loggedIn;
    // 礼物类型过滤框（未登录时收不到礼物消息）
    document.querySelectorAll('.room-filter[data-filter="gift"]').forEach((lbl) => {
      const inp = lbl.querySelector('input');
      if (!inp) return;
      inp.disabled = !loggedIn;
      if (loggedIn) {
        lbl.classList.remove('locked');
        lbl.title = '';
      } else {
        lbl.classList.add('locked');
        lbl.title = '右上角登录抖音后才可接收礼物消息';
      }
    });
    refreshSendDock();
  }

  els.loginBtn.addEventListener('click', async () => {
    els.userPopover.classList.remove('show');
    await window.danmu.login();
  });

  els.logoutBtn.addEventListener('click', async () => {
    if (!confirm('确定退出登录吗？退出后将无法接收礼物消息，需要重新登录。')) return;
    els.userPopover.classList.remove('show');
    await window.danmu.logout();
    showToast('已退出登录', 3000);
  });

  window.danmu.onLoginStatus((s) => {
    if (s?.loggedIn) {
      if (s.userInfo) showLoginUser(s.userInfo);
      else showLoginUser({ nickname: '已登录' });
      updateLoginGating(true);
      showToast('登录成功！现在可以接收礼物消息了', 4000);
    } else {
      hideLoginUser();
      updateLoginGating(false);
    }
  });

  // ---- 左侧底部发送坞（即时发送）+ 定时弹幕弹窗（多条任务，只显当前直播间） ----
  // 即时发送目标 = 当前展开的直播间；定时任务按 ID 管理，任务自带目标房间
  let schedEditingId = null; // 当前处于编辑态的任务 ID
  let schedTasks = [];       // 最近一次拉取的全量任务（用于按钮计数/弹窗渲染）

  function sendTargetRoomId() {
    return activeRoomId && rooms.has(activeRoomId) ? activeRoomId : null;
  }

  function roomDisplayName(rid) {
    const room = rooms.get(rid);
    return room?.anchorInfo?.nickname ? `${room.anchorInfo.nickname}（${rid}）` : `直播间 ${rid}`;
  }

  /** 刷新发送坞：目标标签 + 各控件禁用态 + 「定时弹幕(n)」计数 */
  function refreshSendDock() {
    const rid = sendTargetRoomId();
    const room = rid ? rooms.get(rid) : null;
    const name = room?.anchorInfo?.nickname;
    els.sendTarget.textContent = rid
      ? `发送到：${name ? `${name}（${rid}）` : `直播间 ${rid}`}`
      : '未连接直播间，连接并展开后可发送';
    els.sendTarget.classList.toggle('empty', !rid);
    const canSend = isLoggedIn && !!rid;
    els.sendInput.disabled = !canSend;
    els.sendBtn.disabled = !canSend || els.sendBtn.dataset.sending === '1';
    els.schedOpenBtn.disabled = !canSend;
    const n = schedTasks.filter((t) => t.roomId === rid).length;
    els.schedOpenBtn.textContent = n > 0 ? `定时弹幕(${n})` : '定时弹幕';
    els.schedOpenBtn.title = !isLoggedIn
      ? '登录抖音后可使用'
      : rid
        ? '管理当前直播间的定时弹幕任务'
        : '先连接并展开一个直播间';
    els.sendInput.placeholder = !isLoggedIn
      ? '登录抖音后可发送'
      : rid
        ? '输入弹幕内容，回车或点「发送」'
        : '连接直播间后可发送';
  }

  async function doSendImmediate() {
    const rid = sendTargetRoomId();
    if (!isLoggedIn) { showToast('请先登录抖音（右上角）', 2500); return; }
    if (!rid) { showToast('请先连接并展开一个直播间', 2500); return; }
    const content = els.sendInput.value.trim();
    if (!content) { showToast('请输入弹幕内容', 2500); return; }
    els.sendBtn.dataset.sending = '1';
    els.sendBtn.disabled = true;
    els.sendBtn.textContent = '发送中...';
    try {
      const res = await window.danmu.send(rid, content);
      showToast(res.ok ? '发送成功' : (res.msg || '发送失败'), 3500);
      if (res.ok) els.sendInput.value = '';
    } catch (e) {
      showToast('发送失败：' + (e?.message || '未知错误'), 3500);
    } finally {
      els.sendBtn.dataset.sending = '';
      els.sendBtn.textContent = '发送';
      refreshSendDock();
    }
  }

  /** 拉取全量任务：更新「定时弹幕(n)」计数 + 渲染弹窗内当前房间的任务列表 */
  async function refreshSchedList() {
    try {
      const res = await window.danmu.scheduleList();
      schedTasks = res?.ok ? res.tasks || [] : [];
    } catch (_) { /* 拉取失败保持旧列表 */ }
    if (schedEditingId && !schedTasks.some((t) => t.id === schedEditingId)) schedEditingId = null;
    refreshSendDock();
    renderModalSchedList();
  }

  function renderModalSchedList() {
    const rid = sendTargetRoomId();
    const tasks = schedTasks.filter((t) => t.roomId === rid);
    els.modalSchedList.innerHTML = '';
    if (!tasks.length) {
      const empty = document.createElement('div');
      empty.className = 'sched-empty';
      empty.textContent = '暂无定时弹幕，在上方添加（到第一个间隔时开始发送）';
      els.modalSchedList.appendChild(empty);
      return;
    }
    for (const t of tasks) {
      els.modalSchedList.appendChild(schedEditingId === t.id ? buildSchedEditRow(t) : buildSchedRow(t));
    }
  }

  function buildSchedRow(t) {
    const row = document.createElement('div');
    row.className = 'sched-item';
    const main = document.createElement('div');
    main.className = 'sched-main';
    const line2 = document.createElement('div');
    line2.className = 'sched-line2';
    line2.textContent = `每 ${t.intervalSec}s：${t.content}`;
    line2.title = `每 ${t.intervalSec} 秒发送：${t.content}`;
    main.appendChild(line2);
    row.appendChild(main);
    const edit = document.createElement('button');
    edit.className = 'sched-btn';
    edit.textContent = '编辑';
    edit.addEventListener('click', () => {
      schedEditingId = schedEditingId === t.id ? null : t.id;
      renderModalSchedList();
    });
    row.appendChild(edit);
    const del = document.createElement('button');
    del.className = 'sched-btn danger';
    del.textContent = '删除';
    del.addEventListener('click', async () => {
      const res = await window.danmu.scheduleRemove(t.id);
      showToast(res?.ok ? '定时弹幕已删除' : (res?.msg || '删除失败'), 2500);
      if (schedEditingId === t.id) schedEditingId = null;
      refreshSchedList();
    });
    row.appendChild(del);
    return row;
  }

  function buildSchedEditRow(t) {
    const row = document.createElement('div');
    row.className = 'sched-item editing';
    const wrap = document.createElement('div');
    wrap.className = 'sched-edit';
    const content = document.createElement('input');
    content.type = 'text';
    content.value = t.content;
    content.maxLength = 100;
    content.placeholder = '任务内容';
    const interval = document.createElement('input');
    interval.type = 'number';
    interval.value = t.intervalSec;
    interval.min = '5';
    interval.max = '3600';
    interval.placeholder = '间隔秒';
    const save = document.createElement('button');
    save.className = 'sched-btn primary';
    save.textContent = '保存';
    const cancel = document.createElement('button');
    cancel.className = 'sched-btn';
    cancel.textContent = '取消';
    wrap.appendChild(content);
    wrap.appendChild(interval);
    wrap.appendChild(save);
    wrap.appendChild(cancel);
    row.appendChild(wrap);
    const doSave = async () => {
      const res = await window.danmu.scheduleUpdate(t.id, content.value.trim(), Math.floor(Number(interval.value) || 0));
      if (res?.ok) {
        schedEditingId = null;
        showToast('定时弹幕已更新', 2000);
      } else {
        showToast(res?.msg || '更新失败', 3000);
      }
      refreshSchedList();
    };
    save.addEventListener('click', doSave);
    content.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });
    interval.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });
    cancel.addEventListener('click', () => {
      schedEditingId = null;
      renderModalSchedList();
    });
    return row;
  }

  async function addScheduleTask() {
    const rid = sendTargetRoomId();
    if (!rid) { showToast('请先连接并展开一个直播间', 2500); return; }
    const content = els.modalSchedContent.value.trim();
    if (!content) { showToast('请输入定时弹幕内容', 2500); return; }
    const itv = Math.floor(Number(els.modalSchedInterval.value) || 0);
    if (itv < 5) { showToast('发送间隔至少 5 秒', 2500); return; }
    const res = await window.danmu.scheduleAdd(rid, content, itv);
    if (res?.ok) {
      els.modalSchedContent.value = '';
      els.modalSchedInterval.value = '';
      showToast(`定时弹幕已添加（每 ${itv} 秒，到点自动发送）`, 2500);
    } else {
      showToast(res?.msg || '添加失败', 3000);
    }
    refreshSchedList();
  }

  function openSchedModal() {
    if (els.schedOpenBtn.disabled) return;
    schedEditingId = null;
    els.schedModalTitle.textContent = `定时弹幕 — ${roomDisplayName(sendTargetRoomId() || '')}`;
    els.schedModal.hidden = false;
    refreshSchedList();
    els.modalSchedContent.focus();
  }
  function closeSchedModal() {
    els.schedModal.hidden = true;
    schedEditingId = null;
  }

  els.sendBtn.addEventListener('click', doSendImmediate);
  els.sendInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSendImmediate(); });
  els.schedOpenBtn.addEventListener('click', openSchedModal);
  els.schedModalClose.addEventListener('click', closeSchedModal);
  els.modalSchedAdd.addEventListener('click', addScheduleTask);
  els.modalSchedContent.addEventListener('keydown', (e) => { if (e.key === 'Enter') addScheduleTask(); });
  els.modalSchedInterval.addEventListener('keydown', (e) => { if (e.key === 'Enter') addScheduleTask(); });
  // 点遮罩/Esc 关闭
  els.schedModal.addEventListener('mousedown', (e) => {
    if (e.target === els.schedModal) closeSchedModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.schedModal.hidden) closeSchedModal();
  });
  refreshSchedList();
  refreshSendDock();

  // ---- 授权（状态标识 + 激活弹窗） ----
  function applyLicenseStatus(s) {
    if (!s) return;
    els.licenseChip.textContent = s.mode === 'licensed'
      ? '已授权'
      : s.mode === 'trial'
        ? `试用·剩${s.trialLeft ?? 0}天`
        : s.mode === 'expired' ? '已过期'
          : s.mode === 'tampered' ? '授权异常' : '未激活';
    els.licenseChip.className = 'license-chip ' + (s.ok ? (s.mode === 'licensed' ? 'ok' : 'trial') : 'bad');
    els.licenseChip.title = s.msg || '点击查看授权';
    els.licenseStatusText.textContent = s.msg || '-';
    els.licenseMachine.textContent = s.machine || '-';
    // 试用期/授权异常时标识闪烁提醒
    els.licenseChip.classList.toggle('warn', s.mode === 'trial' && (s.trialLeft ?? 99) <= 1);
  }

  async function refreshLicenseChip() {
    try { applyLicenseStatus(await window.danmu.licenseGetStatus()); } catch (_) {}
  }

  els.licenseChip.addEventListener('click', async () => {
    els.licenseResult.textContent = '';
    els.licenseModal.hidden = false;
    await refreshLicenseChip();
  });
  els.licenseModalClose.addEventListener('click', () => { els.licenseModal.hidden = true; });
  els.licenseModal.addEventListener('mousedown', (e) => {
    if (e.target === els.licenseModal) els.licenseModal.hidden = true;
  });
  els.licenseCopyMachine.addEventListener('click', () => {
    const code = els.licenseMachine.textContent || '';
    navigator.clipboard?.writeText(code).then(
      () => showToast('机器码已复制', 2000),
      () => { els.licenseKeyInput.value = code; showToast('复制失败，机器码已填入授权码框，请手动复制', 4000); }
    );
  });
  els.licenseActivateBtn.addEventListener('click', async () => {
    const key = els.licenseKeyInput.value.trim();
    if (!key) { els.licenseResult.textContent = '请先粘贴授权码'; els.licenseResult.className = 'license-result bad'; return; }
    els.licenseActivateBtn.disabled = true;
    els.licenseActivateBtn.textContent = '校验中...';
    try {
      const res = await window.danmu.licenseActivate(key);
      els.licenseResult.textContent = res.msg;
      els.licenseResult.className = 'license-result ' + (res.ok ? 'ok' : 'bad');
      if (res.ok) {
        showToast('激活成功，感谢支持！', 3000);
        els.licenseKeyInput.value = '';
        await refreshLicenseChip();
      }
    } catch (e) {
      els.licenseResult.textContent = '激活失败：' + (e?.message || '未知错误');
      els.licenseResult.className = 'license-result bad';
    } finally {
      els.licenseActivateBtn.disabled = false;
      els.licenseActivateBtn.textContent = '激活';
    }
  });
  window.danmu.onLicenseStatus((s) => applyLicenseStatus(s));
  refreshLicenseChip();

  // 连接时长
  let uptimeTimer = null;
  let uptimeRoomId = null;
  function startUptime(startTs) {
    stopUptime();
    uptimeRoomId = activeRoomId;
    const tick = () => {
      const sec = Math.floor((Date.now() - startTs) / 1000);
      const mm = String(Math.floor(sec / 60)).padStart(2, '0');
      const ss = String(sec % 60).padStart(2, '0');
      if (!uptimeRoomId) return;
      const item = document.querySelector(`.room-item[data-room="${uptimeRoomId}"]`);
      if (!item) return;
      const el = item.querySelector('.rs-value[data-k="uptime"]');
      if (el) el.textContent = `${mm}:${ss}`;
    };
    tick();
    uptimeTimer = setInterval(tick, 1000);
  }
  function stopUptime() {
    if (uptimeTimer) clearInterval(uptimeTimer);
    uptimeTimer = null;
    uptimeRoomId = null;
  }

  // 初始空提示
  showEmptyState();

  // ---- 输入框历史记录下拉 ----
  // 数据源为主进程持久化的「连接成功」历史（最多 20 条），容器可视约 5 条滚动
  let historyLoading = false;

  function hideHistoryPanel() {
    els.historyPanel.hidden = true;
  }

  async function openHistoryPanel() {
    if (historyLoading) return;
    historyLoading = true;
    let list = [];
    try {
      const res = await window.danmu.getHistory();
      if (res?.ok) list = res.list || [];
    } catch (_) {}
    historyLoading = false;
    els.historyList.innerHTML = '';
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = '暂无历史记录，连接成功的直播间会出现在这里';
      els.historyList.appendChild(empty);
    }
    for (const h of list) {
      const row = document.createElement('div');
      row.className = 'history-item';

      // 头像（无头像用首字符占位）
      const av = document.createElement('img');
      av.className = 'history-avatar';
      av.alt = '';
      av.referrerPolicy = 'no-referrer';
      const fb = document.createElement('span');
      fb.className = 'history-avatar-fallback';
      fb.textContent = (h.nickname || h.roomId || '?').trim().charAt(0) || '?';
      if (h.avatar) {
        av.src = h.avatar;
        av.onerror = () => av.replaceWith(fb);
      } else {
        av.replaceWith(fb);
      }
      row.appendChild(av);

      // 主播名 + 房间号
      const main = document.createElement('div');
      main.className = 'history-main';
      const name = document.createElement('div');
      name.className = 'history-name';
      name.textContent = h.nickname || `直播间 ${h.roomId}`;
      const rid = document.createElement('div');
      rid.className = 'history-room';
      rid.textContent = `房间 ${h.roomId}`;
      main.appendChild(name);
      main.appendChild(rid);
      row.appendChild(main);

      // 最后连接时间
      const time = document.createElement('span');
      time.className = 'history-time';
      time.textContent = formatHistoryTime(h.lastConnectedAt);
      row.appendChild(time);

      // 单条删除（最右侧 ×）
      const del = document.createElement('button');
      del.className = 'history-del';
      del.textContent = '×';
      del.title = '删除这条记录';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        try { await window.danmu.historyRemove(h.roomId); } catch (_) {}
        openHistoryPanel(); // 就地刷新（面板保持展开）
      });
      row.appendChild(del);

      // 点击：填入并直接连接
      row.addEventListener('click', () => {
        hideHistoryPanel();
        els.roomInput.value = h.roomId;
        doConnect();
      });
      els.historyList.appendChild(row);
    }
    els.historyPanel.hidden = false;
  }

  els.roomInput.addEventListener('focus', openHistoryPanel);
  els.roomInput.addEventListener('click', openHistoryPanel);
  els.roomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideHistoryPanel();
  });
  // 点击面板外区域关闭（mousedown 阶段处理，避免与行点击冲突）
  document.addEventListener('mousedown', (e) => {
    if (els.historyPanel.hidden) return;
    if (els.historyPanel.contains(e.target) || e.target === els.roomInput) return;
    hideHistoryPanel();
  });
  els.historyClear.addEventListener('click', async (e) => {
    e.stopPropagation();
    try { await window.danmu.clearHistory(); } catch (_) {}
    openHistoryPanel();
  });
})();
