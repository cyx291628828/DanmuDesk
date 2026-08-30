/**
 * ============================================================================
 * danmuSender.ts — 弹幕发送模块（页面注入 + CDP 按键 · v3，实测可用）
 * ============================================================================
 *
 * 【方案】
 *   抖音 Web 端发弹幕没有可直接调用的公开 API，采用「签名窗口页面注入」：
 *   把签名窗口导航到目标直播间 → 向页面评论框（字节 editor-kit 富文本编辑器）
 *   写入内容 → 触发回车。与真人操作一致，风控最友好。
 *
 * 【触发回车的关键】（2026-08-30 实测定案，勿轻易改动）
 *   评论框是受控富文本编辑器，对"回车"的触发方式极其挑剔：
 *   ❌ executeJavaScript 派发合成 KeyboardEvent —— 只写文本不发送（旧版假成功根因）
 *   ❌ webContents.sendInputEvent keyDown Return —— 缺少 keypress 环节，编辑器不响应
 *   ✅ CDP Input.dispatchKeyEvent（keyDown 带 text:'\r'）—— Puppeteer 同款，
 *      完整还原 keydown+keypress，实测真实发出（聊天区出现消息、输入框清空）
 *   成功判据：输入框被清空（失败时文本会留在框里）。
 *
 * 【流程】
 *   登录校验 → 签名窗口切到目标房间（waitForChatReady 等评论框真实渲染）→
 *   填入内容（execCommand insertText）→ CDP Enter → 验证清空 → 逐级兜底
 *
 * 【可靠性设计】
 *   - 所有发送（手动 + 定时、跨房间）过同一串行队列，强制 ≥3s 冷却，防风控
 *   - 页面就绪由 preload 页面内上报（不受挂起导航冻结影响），主进程在页面加载
 *     期间绝不做 stop()（会杀死 SPA 挂载）
 *   - 定时任务存内存（会话级）：应用重启后不自动续发，避免意外群发
 * ============================================================================
 */
import { CLog } from './core/logUtil';
import {
  checkLoginStatus,
  clearLoginSession,
  ensureSignerOnRoom,
  execInSignerPage,
  getLoggedInUserInfo,
  getSignerWebContents,
  waitForChatReady,
} from './signBridge';

/** 发送结果 */
export interface SendResult {
  ok: boolean;
  msg: string;
}

const SEND_COOLDOWN_MS = 3000; // 两次发送最小间隔（防风控；队列串行 + 此冷却）
const SEND_VERIFY_MS = 4000; // 回车后等待发送请求的窗口
const INPUT_MAX_LEN = 100; // 内容长度上限（抖音弹幕实际限制更短，超长会被服务端拒绝）

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- 注入脚本（源自 send-probe3.js 实测可用的查找/注入逻辑） ----------

/** 评论输入框查找（contenteditable / textarea / 非搜索 input，取可见的） */
const FIND_INPUT_FN = `function __findInput(){
  var all = Array.prototype.slice.call(document.querySelectorAll('div[contenteditable]:not([contenteditable="false"]), textarea, input[type="text"]'));
  var candidates = all.filter(function(e){
    var ph = (e.getAttribute('data-placeholder')||e.getAttribute('placeholder')||e.getAttribute('aria-label')||'');
    return !(e.tagName === 'INPUT' && ph.indexOf('\\u641c\\u7d22') >= 0);
  });
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i].offsetWidth || candidates[i].offsetHeight) return candidates[i];
  }
  return candidates[0] || null;
}`;

const JS_FOCUS_INPUT = `(function(){ try { var i = ${FIND_INPUT_FN}(); if (i) { i.focus(); return true; } return false; } catch(e){ return false; } })()`;

/** 读取评论框状态：found/tag/content（剥离空白与零宽字符）/focused */
const JS_INPUT_STATE = `(function(){ try {
  var i = ${FIND_INPUT_FN}();
  if (!i) return { found: false, gone: true };
  return {
    found: true,
    gone: false,
    tag: i.tagName,
    content: (i.textContent || i.value || '').replace(/[\\s\\u200b]/g, ''),
    focused: document.activeElement === i
  };
} catch(e){ return { found: false, gone: false, err: String(e) }; } })()`;

/** 填入内容：清空 → execCommand insertText → input 事件（写入失败时 value 直写兜底） */
const jsFill = (text: string) => `(function(){
  try {
    var input = ${FIND_INPUT_FN}();
    if (!input) return { stage: 'no-input' };
    input.focus();
    input.innerHTML = '';
    try { document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); } catch(_){}
    try { var rg = document.createRange(); rg.selectNodeContents(input); rg.collapse(false);
      var sl = window.getSelection(); sl.removeAllRanges(); sl.addRange(rg); } catch(_){}
    try { document.execCommand('insertText', false, ${JSON.stringify(text)}); } catch(_){}
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    var after = (input.textContent || input.value || '');
    if (!after.replace(/\\s/g, '')) {
      try { input.value = ${JSON.stringify(text)}; } catch(_){}
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      after = (input.textContent || input.value || '');
    }
    return { stage: after.replace(/\\s/g, '') ? 'filled' : 'empty', len: after.replace(/\\s/g, '').length };
  } catch(e){ return { stage: 'err', err: String(e) }; }
})()`;

/** 合成 Enter（keydown/keypress/keyup） */
const JS_ENTER = `(function(){
  try {
    var input = ${FIND_INPUT_FN}();
    if (!input) return { stage: 'no-input' };
    input.focus();
    var before = (input.textContent || input.value || '').replace(/\\s/g, '');
    if (!before) return { stage: 'empty' };
    ['keydown','keypress','keyup'].forEach(function(k){
      input.dispatchEvent(new KeyboardEvent(k, { key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true }));
    });
    return { stage: 'entered' };
  } catch(e){ return { stage: 'err', err: String(e) }; }
})()`;

/** 点击可见的「发送」按钮（兜底） */
const JS_CLICK_SEND = `(function(){
  try {
    var btns = Array.prototype.slice.call(document.querySelectorAll('button, [role="button"]'));
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var t = (b.textContent||'').trim();
      var al = b.getAttribute('aria-label')||'';
      var title = b.getAttribute('title')||'';
      if ((t === '\\u53d1\\u9001' || al === '\\u53d1\\u9001' || title === '\\u53d1\\u9001') && !b.disabled && (b.offsetWidth||b.offsetHeight)) {
        b.click();
        return { stage: 'clicked' };
      }
    }
    return { stage: 'no-btn' };
  } catch(e){ return { stage: 'err', err: String(e) }; }
})()`;

/** 抓取页面 toast 提示文本（发送被拒时的官方原因，如「发言频率过快」） */
const JS_PAGE_TOAST = `(function(){
  try {
    var els = document.querySelectorAll('[class*="toast" i], [class*="Toast" i], [class*="tip-" i], [class*="Tip" i]');
    var out = [];
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].textContent || '').trim();
      if (t && t.length < 60 && (els[i].offsetWidth || els[i].offsetHeight) && out.indexOf(t) < 0) out.push(t);
    }
    return out.slice(0, 3).join(' | ');
  } catch(e){ return ''; }
})()`;

// ---------- 发送队列 ----------

let queue: Promise<SendResult> = Promise.resolve({ ok: true, msg: '' });
let lastSendAt = 0;

let loginExpiredCb: (() => void) | null = null;
/** 注册「登录态已失效」回调（主进程启动时注入，用于通知渲染层刷新登录 UI） */
export function onLoginExpired(cb: () => void): void {
  loginExpiredCb = cb;
}

/** 发送弹幕（自动排队串行执行） */
export function sendDanmu(roomId: string, content: string): Promise<SendResult> {
  const task = queue.then(() => doSend(roomId, content));
  queue = task.then(() => {}, () => {});
  return task;
}

async function doSend(roomId: string, content: string): Promise<SendResult> {
  const text = String(content || '').trim();
  if (!text) return { ok: false, msg: '弹幕内容为空' };
  if (text.length > INPUT_MAX_LEN) return { ok: false, msg: `弹幕过长（上限 ${INPUT_MAX_LEN} 字）` };
  // 冷却：距上次发送不足间隔则等待（同队列保证不并发）
  const wait = lastSendAt + SEND_COOLDOWN_MS - Date.now();
  if (wait > 0) await sleep(wait);
  try {
    const { loggedIn } = await checkLoginStatus();
    if (!loggedIn) return { ok: false, msg: '发送弹幕需要先登录抖音账号（右上角登录）' };

    let forcedReload = false;
    let last: SendResult & { stage?: string } = { ok: false, msg: '发送失败' };
    for (let attempt = 1; attempt <= 2; attempt++) {
      await ensureSignerOnRoom(roomId, forcedReload);
      const r = await attemptSend(text);
      if (r.ok) {
        lastSendAt = Date.now();
        CLog.info(`[sender] 弹幕已发送 room=${roomId} len=${text.length}`);
        return { ok: true, msg: '发送成功' };
      }
      last = r;
      // 两种可自愈的失败，强制重载签名页面后重试一次（重载会重建会话/登录态/编辑器）：
      //   no-input   —— 页面无评论框：登录态或页面状态失效（账号在其他设备活动后常见）
      //   unverified —— 回车后未清空：服务端静默拒绝了发送，多半也是会话/凭证过期
      const retryable = r.stage === 'no-input' || r.stage === 'unverified';
      if (!retryable || forcedReload) break;
      forcedReload = true;
      CLog.warn(`[sender] 发送未成功(${r.stage})，疑似页面/登录态过期，强制重载签名页面后重试`);
    }

    // 重载重试后仍打不开评论框：用官方接口校验登录态是否真的失效
    // （cookie 还在但服务端已判定过期 → 页面永远加载不出评论框，用户界面却显示已登录）
    if (last.stage === 'no-input') {
      const info = await getLoggedInUserInfo().catch(() => undefined);
      if (info?.expired) {
        await clearLoginSession();
        loginExpiredCb?.();
        CLog.warn('[sender] 登录态已失效（接口判定未登录），已清除并通知界面');
        return { ok: false, msg: '抖音登录已失效（账号可能在其他设备重新登录），请右上角重新登录' };
      }
      return {
        ok: false,
        msg: '发送失败：页面未登录或评论框未渲染（已自动重载仍失败，请确认右上角登录状态与直播间是否可发言）',
      };
    }
    return { ok: false, msg: last.msg || '发送失败' };
  } catch (e: any) {
    CLog.warn(`[sender] 发送异常 room=${roomId}:`, e?.message || e);
    return { ok: false, msg: e?.message || '发送异常' };
  }
}

/** 单次注入尝试（等页面就绪 → 填入 → CDP Enter → 逐级兜底 → 以输入框清空为准） */
async function attemptSend(text: string): Promise<{ ok: boolean; msg: string; stage: string }> {
  const t0 = Date.now();
  // 1) 等页面评论框真实渲染完成（preload 页面内上报；输入框只在「已登录且
  //    页面完全渲染」后出现，未登录时 preload 超时后上报 hasInput:false）
  const pageReady = await waitForChatReady(40000);
  const tReady = Date.now();
  if (!pageReady) {
    return {
      ok: false,
      msg: '页面未登录或评论框未渲染（请确认右上角已登录抖音，且直播间未禁言）',
      stage: 'no-input',
    };
  }

  // 2) 调试器挂载与填入并行（挂载有几十~几百 ms 开销，提前发起隐藏延迟）。
  //    jsFill 内部已 focus 输入框，无需再单独调一次聚焦
  const attachP = cdpEnsureAttached();
  const fill = await execInSignerPage(jsFill(text), 3000);
  const tFill = Date.now();
  await attachP;
  if (fill.hang) return { ok: false, msg: '页面无响应，请重试', stage: 'hang' };
  if (fill.err) return { ok: false, msg: '页面执行失败：' + fill.err, stage: 'exec-err' };
  const fillState = fill.ok as { stage?: string } | undefined;
  if (!fillState || fillState.stage !== 'filled') {
    if (fillState?.stage === 'no-input') return { ok: false, msg: '未找到弹幕输入框', stage: 'no-input' };
    return { ok: false, msg: '弹幕内容写入失败', stage: 'fill-fail' };
  }

  // 3) CDP Enter（实测可触发真实发送，见模块头注释）
  const ok = await cdpPressEnter();
  if (ok) {
    if (await verifyBoxCleared()) {
      CLog.info(
        `[sender][timing] 页面就绪=${tReady - t0}ms 填入=${tFill - tReady}ms 回车+验证=${Date.now() - tFill}ms`
      );
      return { ok: true, msg: '发送成功', stage: 'sent' };
    }
  }

  // 4) 兜底一：sendInputEvent char '\r'（字符级回车，部分编辑器认它）
  const wc = getSignerWebContents();
  if (wc) {
    try {
      wc.sendInputEvent({ type: 'char', keyCode: '\r' });
    } catch {}
    if (await verifyBoxCleared()) return { ok: true, msg: '发送成功', stage: 'sent' };

    // 5) 兜底二：重填 + sendInputEvent keyDown Return
    await execInSignerPage(jsFill(text), 2500);
    await execInSignerPage(JS_FOCUS_INPUT, 2000);
    try {
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    } catch {}
    if (await verifyBoxCleared()) return { ok: true, msg: '发送成功', stage: 'sent' };

    // 6) 兜底三：重填 + 合成 Enter 事件
    await execInSignerPage(jsFill(text), 2500);
    await execInSignerPage(JS_ENTER, 2500);
    if (await verifyBoxCleared()) return { ok: true, msg: '发送成功', stage: 'sent' };

    // 7) 兜底四：点击「发送」按钮
    const click = await execInSignerPage(JS_CLICK_SEND, 2500);
    if (click.ok?.stage === 'clicked') {
      if (await verifyBoxCleared()) return { ok: true, msg: '发送成功', stage: 'sent' };
    }
  }

  // 8) 全部触发方式无效：以输入框残留内容区分失败原因，并抓取页面上的提示
  //    文本（抖音拒绝发言时会弹 toast，如「发言频率过快」「需要关注主播」）
  const st = await execInSignerPage(JS_INPUT_STATE, 2000);
  const stillHasText = !!(st.ok && st.ok.found && st.ok.content);
  const pageToast = await execInSignerPage(JS_PAGE_TOAST, 1500).catch(() => null);
  const hint = typeof pageToast?.ok === 'string' && pageToast.ok ? `（页面提示：${pageToast.ok}）` : '';
  return {
    ok: false,
    msg: stillHasText
      ? `发送失败：${hint || '所有触发方式均未生效（页面结构可能已更新）'}`
      : `发送失败：${hint || '直播间可能限制发言或需要粉丝团权限'}`,
    stage: 'unverified',
  };
}

/**
 * 确保 CDP 调试器已附加（幂等）。附加后保持挂载不反复挂/卸——
 * 每次 attach/detach 各是一次有开销的往返；页面销毁时 Chromium 会自动解除，
 * 下次发送时这里会重新附加。
 */
async function cdpEnsureAttached(): Promise<boolean> {
  const wc = getSignerWebContents();
  if (!wc) return false;
  try {
    await wc.debugger.attach('1.3');
  } catch {
    /* 已附加则直接复用 */
  }
  return true;
}

/**
 * CDP 按键注入（实测可触发 editor-kit 真实发送的唯一隐藏窗口方案）：
 * Input.dispatchKeyEvent 的 keyDown 带 text:'\r' 会同时生成 keydown+keypress，
 * 与 OS 级回车等价；sendInputEvent 与合成 KeyboardEvent 都缺 keypress 所以无效。
 */
async function cdpPressEnter(): Promise<boolean> {
  const wc = getSignerWebContents();
  if (!wc) return false;
  try {
    await cdpEnsureAttached();
    const KEY_EVENTS = [
      { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' },
      { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
    ];
    for (const ev of KEY_EVENTS) {
      await Promise.race([
        wc.debugger.sendCommand('Input.dispatchKeyEvent', ev as any),
        sleep(2000),
      ]);
    }
    return true;
  } catch (e: any) {
    CLog.warn('[sender] CDP Enter 异常: ' + (e?.message || e));
    return false;
  }
}

/**
 * 发送验证：输入框被清空（成功发送后编辑器会清空内容；失败时文本残留）。
 * 输入框消失（gone）视为异常而非成功。首轮立即检查（发送快时省一轮等待），
 * 之后 200ms 一次。
 */
async function verifyBoxCleared(): Promise<boolean> {
  const deadline = Date.now() + SEND_VERIFY_MS;
  let first = true;
  while (Date.now() < deadline) {
    const st = await execInSignerPage(JS_INPUT_STATE, 2000);
    if (st.ok && st.ok.found && st.ok.gone === false) {
      if (!st.ok.content) return true; // 已清空 → 发送成功
    }
    if (first) {
      first = false;
      continue; // 立即再查一次（清空很快时不用等 250ms）
    }
    await sleep(200);
  }
  return false;
}

// ---------- 定时任务（多条，按任务 ID 管理，可单独编辑/删除） ----------

interface SendSchedule {
  id: string;
  roomId: string;
  content: string;
  intervalSec: number;
  timer: NodeJS.Timeout | null;
}

/** 任务列表（key=任务 ID；同一房间允许并存多条任务） */
const schedules = new Map<string, SendSchedule>();
let taskSeq = 0;

export type ScheduleResultCb = (taskId: string, roomId: string, r: SendResult, content: string) => void;

let onResultCb: ScheduleResultCb | null = null;
/** 注册定时任务发送结果回调（主进程启动时调用一次，转发给渲染进程） */
export function onScheduleResult(cb: ScheduleResultCb): void {
  onResultCb = cb;
}

function validateScheduleInput(content: string, intervalSec: number): { text: string; itv: number; err?: string } {
  const text = String(content || '').trim();
  if (!text) return { text: '', itv: 0, err: '弹幕内容为空' };
  if (text.length > INPUT_MAX_LEN) return { text: '', itv: 0, err: `弹幕过长（上限 ${INPUT_MAX_LEN} 字）` };
  const itv = Math.floor(Number(intervalSec) || 0);
  if (itv < 5 || itv > 3600) return { text: '', itv: 0, err: '发送间隔需在 5~3600 秒之间' };
  return { text, itv };
}

function startTaskTimer(s: SendSchedule): void {
  if (s.timer) clearTimeout(s.timer);
  const tick = async () => {
    if (schedules.get(s.id) !== s) return; // 已被删除/替换
    const r = await sendDanmu(s.roomId, s.content);
    onResultCb?.(s.id, s.roomId, r, s.content);
    if (!r.ok) CLog.warn(`[sender] 定时任务发送失败 id=${s.id} room=${s.roomId}: ${r.msg}`);
    if (schedules.get(s.id) === s) s.timer = setTimeout(tick, s.intervalSec * 1000);
  };
  s.timer = setTimeout(tick, s.intervalSec * 1000); // 到达第一个间隔才发送（即时发走上方即时发送框）
}

/**
 * 添加定时任务（添加后到达第一个间隔时开始发送）
 * @param intervalSec 间隔秒数（5~3600）
 */
export function addSchedule(roomId: string, content: string, intervalSec: number): SendResult & { id?: string } {
  const rid = String(roomId || '').trim();
  if (!rid) return { ok: false, msg: '房间号无效' };
  const v = validateScheduleInput(content, intervalSec);
  if (v.err) return { ok: false, msg: v.err };
  const id = `t${++taskSeq}_${Date.now().toString(36)}`;
  const s: SendSchedule = { id, roomId: rid, content: v.text, intervalSec: v.itv, timer: null };
  schedules.set(id, s);
  startTaskTimer(s);
  CLog.info(`[sender] 定时任务已添加 id=${id} room=${rid} 间隔=${v.itv}s 内容="${v.text.slice(0, 30)}"`);
  return { ok: true, msg: '定时任务已添加', id };
}

/** 编辑定时任务（改内容/间隔；间隔变更后按新间隔重新计时） */
export function updateSchedule(id: string, content: string, intervalSec: number): SendResult {
  const s = schedules.get(id);
  if (!s) return { ok: false, msg: '任务不存在或已停止' };
  const v = validateScheduleInput(content, intervalSec);
  if (v.err) return { ok: false, msg: v.err };
  const intervalChanged = v.itv !== s.intervalSec;
  s.content = v.text;
  s.intervalSec = v.itv;
  if (intervalChanged) startTaskTimer(s); // 按新间隔重新计时（内容变更不打断本次倒计时）
  CLog.info(`[sender] 定时任务已更新 id=${id} 间隔=${v.itv}s 内容="${v.text.slice(0, 30)}"`);
  return { ok: true, msg: '定时任务已更新' };
}

/** 删除指定定时任务（幂等） */
export function removeSchedule(id: string): SendResult {
  const s = schedules.get(id);
  if (!s) return { ok: false, msg: '任务不存在或已停止' };
  if (s.timer) clearTimeout(s.timer);
  schedules.delete(id);
  CLog.info(`[sender] 定时任务已删除 id=${id} room=${s.roomId}`);
  return { ok: true, msg: '定时任务已删除' };
}

/** 删除指定房间的全部定时任务（房间断开时调用；返回被删任务 ID 列表） */
export function removeSchedulesByRoom(roomId: string): string[] {
  const removed: string[] = [];
  for (const s of [...schedules.values()]) {
    if (s.roomId === roomId) {
      if (s.timer) clearTimeout(s.timer);
      schedules.delete(s.id);
      removed.push(s.id);
    }
  }
  if (removed.length) CLog.info(`[sender] 房间 ${roomId} 断开，已移除 ${removed.length} 个定时任务`);
  return removed;
}

/** 任务列表（渲染进程展示用） */
export interface ScheduleTaskInfo {
  id: string;
  roomId: string;
  content: string;
  intervalSec: number;
}

export function listSchedules(): ScheduleTaskInfo[] {
  return [...schedules.values()].map((s) => ({
    id: s.id,
    roomId: s.roomId,
    content: s.content,
    intervalSec: s.intervalSec,
  }));
}

/** 停止全部定时任务（应用退出时调用） */
export function stopAllSchedules(): void {
  for (const s of [...schedules.values()]) {
    if (s.timer) clearTimeout(s.timer);
  }
  schedules.clear();
}
