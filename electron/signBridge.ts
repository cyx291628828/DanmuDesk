// signBridge.ts — 签名桥（真实页面方案）
// 原理：抖音 webmssdk.es5.js 的 frontierSign 是 JSVMP（虚拟机保护）算法，
// 强依赖真实浏览器环境（document.referrer、envcode 浏览器=1 / Node=129 环境检测），
// 纯 Node 复刻成本极高，必须走真实页面执行。
//
// 方案（已由 wss_hybrid_test.js 三层验证）：
//   1) 隐藏 BrowserWindow 加载真实抖音直播间页面 https://live.douyin.com/{roomId}
//      → 页面在真实环境中自动注入 window.byted_acrawler.frontierSign
//      · 页面粘性复用：任何直播间页面都能提供签名环境，换房间不重载页面
//      · 屏蔽 media 资源请求：不需要真的播放直播，省掉视频解码的内存/CPU 大头
//   2) 会话 Cookie（ttwid / UIFID_TEMP / x-web-secsdk-uid / odin_tt / csrf_session_id 等
//      19+ 项，~2156 字符）由持久 partition 保存 —— WSS 握手必需，Node 简单 GET 收集的
//      Cookie 不够
//   3) executeJavaScript 调用真实 frontierSign 得到 16 字符 X-Bogus（signature 参数）
//   4) getSessionCookieString() 导出窗口会话 Cookie 供主进程 im/fetch 与 WSS 握手使用
//
// 【挂起导航自愈】（2026-08-30 探针实测，详见 docs/优化工作文档.md）
//   抖音页面在 DOMContentLoaded 后会立刻发起 1~2 个同文档（in-place）导航，该导航
//   在部分环境下永远挂起：Chromium 冻结 executeJavaScript、load 事件永不触发 ——
//   这是此前「loadURL 超时 45s → 连接失败」「签名窗口渲染进程被 kill」的根因。
//   自愈手段：preload 页面内上报就绪信号（不依赖 executeJavaScript）+ 调用超时后
//   webContents.stop() 终止挂起导航再重试（实测 stop 后签名立即恢复正常）。
import { app, BrowserWindow, session, ipcMain } from 'electron';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { setFrontierSignerAsync, type SignerImpl } from './core/signer';
import { CLog } from './core/logUtil';

/**
 * 持久化 partition 名（签名窗口专属会话）
 *  - 'persist:' 前缀表示该会话 Cookie 会持久化到磁盘，应用重启后依然有效，
 *    可避免每次冷启动都要重新加载页面收集 Cookie
 *  - 与主窗口隔离：签名窗口的 Cookie/存储不会污染主窗口，反之亦然
 */
const SIGN_PARTITION = 'persist:danmusign';
const SIGN_HOST = 'https://live.douyin.com'; // 签名/取 Cookie 的固定域名
const SIGN_TIMEOUT = 30000; // 单次页面加载超时（失败会自动重试一次）
const SIGN_ATTEMPTS = 2; // 页面加载失败自动重试次数（日志统计：失败后再试基本都能在 2~6s 内成功）
const POLL_INTERVAL = 250; // executeJavaScript 兜底轮询间隔
const SIGN_CALL_TIMEOUT = 4000; // 单次 frontierSign 调用超时（正常 <100ms）
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

let signWin: BrowserWindow | null = null;
let initPromise: Promise<void> | null = null;
/** 签名窗口当前加载的直播间房间号（用于渲染进程被回收后的后台重建） */
let lastSignRoomId: string | null = null;
/** 后台自动重建的连续失败计数（防崩溃死循环：超过 3 次停止自动重建） */
let rebuildFailCount = 0;
let rebuildTimer: NodeJS.Timeout | null = null;

// ---- 挂起导航自愈：preload 页面内就绪信号 ----
// sign-preload.js 与页面共享主世界（contextIsolation:false + 沙箱 preload），
// ---- 页面内就绪信号（sign-preload.js 上报，不依赖 executeJavaScript，不受挂起导航冻结影响） ----
// 1. signer:acrawler-ready —— 签名 SDK 就绪（签名用）
// 2. signer:chat-ready     —— 评论输入框渲染完成（发送用，同时代表「页面渲染完成+登录有效」）
// 【关键教训】收到信号后绝不能立即 webContents.stop()：信号到达时主文档往往还在
// 加载，过早 stop 会杀掉文档加载，SPA 的评论框模块永远不挂载（「页面无评论输入框」根因）
let acrawlerBeaconFired = false;
let beaconListenerInstalled = false;

/** 最近一次「评论框就绪」信号（at=0 表示当前页面尚未上报） */
let chatReadySignal = { at: 0, hasInput: false };

function resetPageSignals() {
  acrawlerBeaconFired = false;
  chatReadySignal = { at: 0, hasInput: false };
}

function installBeaconListener() {
  if (beaconListenerInstalled) return; // 幂等：窗口重建会多次走 initSigner，不能重复注册
  beaconListenerInstalled = true;
  ipcMain.on('signer:acrawler-ready', () => {
    acrawlerBeaconFired = true;
    CLog.info('[signBridge] 页面内上报 acrawler 就绪（preload beacon）');
    // 注意：此处绝不 stop() —— 见上方「关键教训」
  });
  ipcMain.on('signer:chat-ready', (_e, payload: any) => {
    chatReadySignal = { at: Date.now(), hasInput: !!(payload && payload.hasInput) };
    CLog.info(`[signBridge] 页面内上报评论框就绪: hasInput=${chatReadySignal.hasInput}`);
  });
}

/**
 * 终止签名窗口当前挂起的导航（同文档导航挂起会冻结 executeJavaScript）。
 * 实测 stop() 后 executeJavaScript 立即恢复，frontierSign 可正常调用。
 * 【只允许用于冻结恢复】页面已完全渲染后 executeJavaScript 挂起时调用；
 * 页面加载初期调用会把文档加载杀掉（评论框永不挂载）。
 */
function stopPendingNavigation() {
  if (signWin && !signWin.isDestroyed()) {
    try { signWin.webContents.stop(); } catch {}
  }
}

/** 签名窗口当前停留的直播间房间号（发送弹幕用） */
export function getSignerRoomId(): string | null {
  return lastSignRoomId;
}

/**
 * 签名窗口始终静音（不再需要直播间声音）
 *  - 签名窗口加载真实抖音直播间页面用于 frontierSign 签名与 Cookie 收集
 *  - 页面会自动播放直播音视频流，但我们不需要声音，始终静音
 *  - 静音只关音频输出，不影响页面 JS / frontierSign 签名 / Cookie 收集
 */
const signWinMuted = true;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 初始化签名桥（幂等：初始化已在途则复用；失败/销毁后允许重建）
 * @param roomId 加载哪个直播间页面（任意在播房间均可，页面仅提供签名环境）
 */
export function initSigner(roomId: string): void {
  if (initPromise) return;
  installBeaconListener();
  lastSignRoomId = roomId;
  resetPageSignals();
  initPromise = (async () => {
    try {
      destroyWin();
      const debugMode = process.env.DEBUG_SIGN === '1';
      signWin = new BrowserWindow({
        show: debugMode, // 调试模式下显示窗口
        width: 1280,
        height: 800,
        webPreferences: {
          partition: SIGN_PARTITION,
          // 注意：必须保持 Chromium 沙箱（默认 true）！sandbox:false 会向页面暴露
          // process/require 等 Node 全局特征，抖音 JSVMP 反爬检测到即把设备标记为
          // 自动化环境 → WSS 握手返回 DEVICE_BLOCKED（handshake-msg=DEVICE_BLOCKED, 415）。
          // sign-preload.js 为沙箱兼容 preload（只能用 ipcRenderer 子集），只读不改页面
          sandbox: true,
          preload: path.join(__dirname, 'sign-preload.js'),
          nodeIntegration: false,
          contextIsolation: false, // executeJavaScript / preload 需访问主世界
          backgroundThrottling: false,
          javascript: true,
        },
      });
      signWin.webContents.setBackgroundThrottling(false);
      // 调试模式下打开开发者工具
      if (debugMode) {
        signWin.webContents.openDevTools({ mode: 'detach' });
      }
      // 屏蔽直播流媒体（media 资源）：隐藏窗口只需要页面的 JS 环境
      // （frontierSign + Cookie），不需要真的播放直播。视频流解码是隐藏窗口
      // 内存/CPU 大头，也是「签名窗口渲染进程被系统 killed」的诱因之一；屏蔽后
      // 页面加载更快、内存更省，且不影响 SDK 注入与签名/发送（异常时可回退：删除本段）
      // 注意：onBeforeRequest 同一 session 只保留最后一个监听器，勿在别处重复注册
      signWin.webContents.session.webRequest.onBeforeRequest(
        { urls: ['*://*/*'] },
        (details, callback) => {
          if (details.resourceType === 'media') callback({ cancel: true });
          else callback({});
        }
      );
      // 音频静音（媒体已被上面拦截，双保险）：不影响页面 JS / frontierSign / Cookie
      signWin.webContents.setAudioMuted(signWinMuted);
      // 禁止页面打开新窗口/外链
      signWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      signWin.webContents.on('render-process-gone', (_e, details) => {
        CLog.warn('[signBridge] 签名窗口渲染进程退出:', details.reason);
        destroyWin();
        initPromise = null; // 允许下次重建
        scheduleSignerRebuild();
      });

      // 加载真实抖音直播间页面；失败（超时/网络抖动）自动重试一次
      // —— 日志统计里页面加载偶发 45s 超时导致连接失败，手动重试都能成功，
      //    把这个重试做进初始化里，「连不上」的概率大幅下降
      let lastErr: Error | null = null;
      for (let attempt = 1; attempt <= SIGN_ATTEMPTS; attempt++) {
        const url = `${SIGN_HOST}/${encodeURIComponent(roomId)}`;
        CLog.info(`[signBridge] 加载签名页面(第${attempt}/${SIGN_ATTEMPTS}次): ${url}`);
        const loaded = await Promise.race([
          signWin
            .loadURL(url, { userAgent: UA })
            .then(() => 'ok')
            .catch((e: any) => 'err:' + ((e && e.message) || e)),
          sleep(SIGN_TIMEOUT).then(() => 'timeout'),
        ]);
        CLog.info('[signBridge] loadURL:', loaded);
        // 注意：loadURL 报错（含被我们 stop 掉的 ABORTED）不作为失败依据 ——
        // SDK 是全局脚本，只要 byted_acrawler.frontierSign 可调用即可
        const ready = await waitForAcrawler();
        if (ready) {
          lastErr = null;
          break;
        }
        lastErr = new Error('window.byted_acrawler.frontierSign 未就绪（页面加载失败或被风控）');
      }
      if (lastErr) throw lastErr;
      rebuildFailCount = 0;
      // 注意：就绪后不要 stop()——页面还要继续加载（发送弹幕需要完整渲染的页面），
      // 签名调用若被挂起导航冻结，impl 内部的超时+stop 自愈会处理

      // 注入签名实现：executeJavaScript 执行真实 frontierSign
      // 带超时自愈：调用若被挂起导航冻结（页面随时可能再次发起导航），
      // stop() 终止导航后重试（探针实测 stop 后立即恢复）
      const impl: SignerImpl = async (params) => {
        if (!signWin || signWin.isDestroyed()) {
          initPromise = null;
          throw new Error('签名窗口已销毁，请重试连接');
        }
        const js = `(function(){ try { var r = window.byted_acrawler.frontierSign(${JSON.stringify(params)}); return { ok: true, r: r }; } catch (e) { return { ok: false, err: String((e && e.message) || e) }; } })()`;
        let lastErr2: Error | null = null;
        for (let i = 0; i < 3; i++) {
          if (!signWin || signWin.isDestroyed()) throw new Error('签名窗口已销毁，请重试连接');
          const res = await Promise.race([
            signWin.webContents
              .executeJavaScript(js)
              .catch((e: any) => ({ ok: false, err: 'exec:' + ((e && e.message) || e) })),
            sleep(SIGN_CALL_TIMEOUT).then(() => 'hang' as const),
          ]);
          if (res !== 'hang') {
            if (res && res.ok && typeof res.r?.['X-Bogus'] === 'string' && res.r['X-Bogus']) {
              return res.r;
            }
            throw new Error('frontierSign 返回异常: ' + JSON.stringify(res).slice(0, 200));
          }
          lastErr2 = new Error(`frontierSign 调用挂起（已 stop 恢复重试 ${i + 1}/2）`);
          CLog.warn(`[signBridge] ${lastErr2.message}`);
          stopPendingNavigation();
          await sleep(300);
        }
        throw lastErr2 || new Error('frontierSign 调用失败');
      };
      setFrontierSignerAsync(Promise.resolve(impl));
      CLog.info('[signBridge] 签名桥就绪（真实页面方案）');
    } catch (err) {
      destroyWin();
      throw err;
    }
  })();
  // 初始化失败时允许重建（不吞掉原始 rejection，await 方仍能收到错误）
  initPromise.catch(() => {
    initPromise = null;
    rebuildFailCount++;
  });
}

/**
 * 签名窗口渲染进程被系统回收（killed）后的后台自动重建
 *  - 没有它，下次连接要现场等 3~12s 整页加载（高峰期更久）
 *  - 重建是 fire-and-forget：失败不打扰用户，下次连接时再走正常初始化
 *  - 连续失败 3 次停止自动重建，防崩溃死循环
 */
function scheduleSignerRebuild() {
  if (rebuildTimer || !lastSignRoomId) return;
  if (rebuildFailCount >= 3) {
    CLog.warn('[signBridge] 签名窗口连续重建失败，停止后台自动重建（下次连接时再试）');
    return;
  }
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    if (signWin || initPromise) return;
    CLog.info('[signBridge] 后台重建签名窗口 ...');
    initSigner(lastSignRoomId);
  }, 2000);
}

/**
 * 等待 window.byted_acrawler.frontierSign 就绪（双通道 + 挂起自愈）
 *
 * 通道 1（首选）：preload 页面内就绪信号（acrawlerBeaconFired）—— 不依赖
 *   executeJavaScript，不受挂起导航影响，实测 1.5s 内检出。
 * 通道 2（兜底）：executeJavaScript 轮询 —— 每次调用限时 2s，若被挂起导航
 *   冻结（调用永不返回）则 webContents.stop() 终止导航后重试。
 */
async function waitForAcrawler(): Promise<boolean> {
  const deadline = Date.now() + SIGN_TIMEOUT;
  while (Date.now() < deadline) {
    if (acrawlerBeaconFired) return true;
    if (!signWin || signWin.isDestroyed()) return false;
    const r = await Promise.race([
      signWin.webContents
        .executeJavaScript(`!!(window.byted_acrawler && typeof window.byted_acrawler.frontierSign === 'function')`)
        .catch(() => null),
      sleep(2000).then(() => 'hang' as const),
    ]);
    if (r === true) return true;
    if (r === 'hang') {
      // executeJavaScript 被挂起的同文档导航冻结：终止导航恢复执行能力
      CLog.warn('[signBridge] executeJavaScript 被挂起导航冻结，stop() 恢复');
      stopPendingNavigation();
      await sleep(300);
      continue;
    }
    await sleep(POLL_INTERVAL);
  }
  return !!acrawlerBeaconFired;
}

/**
 * 获取签名窗口会话的 Cookie 字符串
 *  - 主进程 im/fetch 与 WSS 握手均需携带（与签名同源同会话，最可靠）
 * @returns "name1=value1; name2=value2; ..."（空会话时返回 ''）
 */
export async function getSessionCookieString(): Promise<string> {
  try {
    const ses = session.fromPartition(SIGN_PARTITION);
    const cookies = await ses.cookies.get({ url: SIGN_HOST });
    const list = cookies.filter((c) => c.value).map((c) => `${c.name}=${c.value}`);
    return list.join('; ');
  } catch (err) {
    CLog.warn('[signBridge] 读取会话 Cookie 失败:', err);
    return '';
  }
}

/** 是否已就绪 */
export function isSignerReady(): boolean {
  return !!signWin && !signWin.isDestroyed();
}

/**
 * 确保签名桥就绪（可 await）
 *
 * 【页面粘性复用】签名桥只需要「任意一个抖音直播间页面」提供 frontierSign 环境
 * 与会话 Cookie —— 签名参数由主进程传入、HTTP/WSS 请求也不经过该页面，因此页面
 * 停在哪个房间完全无关紧要。此前每次连接新房间都整页重载（3~12s，高峰期更久），
 * 是「连接慢」的主要来源之一；现在只在窗口不存在时初始化一次，之后全部秒级复用。
 */
export async function ensureSignerReady(roomId: string): Promise<void> {
  if (!signWin || signWin.isDestroyed()) {
    initSigner(roomId);
  }
  if (initPromise) {
    await initPromise;
  }
}

// ---- 发送弹幕用的按需导航 ----
// 页面评论框属于具体房间页面，发送前需确保页面停在目标房间。
// 与签名路径（ensureSignerReady，粘性复用）互不影响：导航只由发送触发，
// 且页面停留房间对签名无任何影响。

/** 导航串行链：手动发送/多个定时任务并发时排队执行，避免同一 webContents 上
 *  多个 loadURL 互相打断（页面停在中间态） */
let navChain: Promise<void> = Promise.resolve();

/**
 * 确保签名窗口页面停留在指定直播间（发送弹幕前置条件）
 *  - 窗口不存在 → 正常初始化（页面直接落在目标房间）
 *  - 已在目标房间且不强制 → 立即返回（定时重复发送的常见路径，零开销）
 *  - 在其他房间 / force=true → 排队导航过去（整页加载，成功即就绪）
 * @param force 强制重载（页面登录态失效时用）
 */
export function ensureSignerOnRoom(roomId: string, force = false): Promise<void> {
  const task = navChain.then(() => doEnsureSignerOnRoom(roomId, force));
  // 吞掉单个任务错误，保证后续排队任务不被阻塞（错误由调用方 await task 收到）
  navChain = task.then(() => {}, () => {});
  return task;
}

async function doEnsureSignerOnRoom(roomId: string, force = false): Promise<void> {
  if (!signWin || signWin.isDestroyed()) {
    // 窗口不存在 → 初始化（页面直接加载目标房间），等待其完整渲染（含评论框）
    initSigner(roomId);
    if (initPromise) await initPromise;
    await waitChatReadySignal(40000);
    return;
  }
  if (lastSignRoomId === roomId && !force) return; // 已在目标房间
  CLog.info(`[signBridge] 发送弹幕：切换签名页面到房间 ${roomId}（原 ${lastSignRoomId}${force ? '，强制重载' : ''}）`);
  resetPageSignals();
  const url = `${SIGN_HOST}/${encodeURIComponent(roomId)}`;
  const loaded = await Promise.race([
    signWin
      .loadURL(url, { userAgent: UA })
      .then(() => 'ok')
      .catch((e: any) => 'err:' + ((e && e.message) || e)),
    sleep(SIGN_TIMEOUT).then(() => 'timeout'),
  ]);
  CLog.info('[signBridge] 发送导航 loadURL:', loaded);
  // 只等页面内信标（签名就绪 + 评论框就绪），全程不 executeJavaScript、不 stop()：
  // 信标到达时文档往往仍在加载，任何 stop 都会把 SPA 杀死在半路（评论框永不挂载）。
  const acDeadline = Date.now() + SIGN_TIMEOUT;
  while (!acrawlerBeaconFired && Date.now() < acDeadline) await sleep(100);
  if (!acrawlerBeaconFired) {
    // 信标缺失（preload 异常等）才退回轮询通道（其内部带冻结恢复）
    const ready = await waitForAcrawler();
    if (!ready) throw new Error('签名页面切换失败：frontierSign 未就绪');
  }
  lastSignRoomId = roomId;
  // 等评论框渲染完成（页面内上报，最长 40s；未登录时 preload 会在超时后上报 hasInput:false）
  await waitChatReadySignal(40000);
}

/**
 * 等待当前页面的「评论框就绪」信号（signer:chat-ready）
 * @returns hasInput=true 评论框已渲染（可发送）；false=超时未出现（未登录/加载失败）
 */
async function waitChatReadySignal(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (chatReadySignal.at > 0) return chatReadySignal.hasInput;
    await sleep(150);
  }
  CLog.warn('[signBridge] 等待评论框就绪信号超时');
  return false;
}

/**
 * 等待签名窗口页面「渲染完成且已登录」（发送弹幕前置条件，可 await）
 *  - 数据源是页面内部上报的 chat-ready 信标，不受挂起导航冻结影响
 */
export async function waitForChatReady(timeoutMs = 40000): Promise<boolean> {
  // 若当前页面已上报过则直接返回；否则在剩余窗口内等新信号
  if (chatReadySignal.at > 0) return chatReadySignal.hasInput;
  return waitChatReadySignal(timeoutMs);
}

/**
 * 在签名窗口页面执行 JS（挂起导航冻结时 stop() 自愈）
 * @returns { ok: 执行返回值 } | { hang: true } | { err: 错误信息 }
 */
export async function execInSignerPage(
  js: string,
  timeoutMs = 2500
): Promise<{ ok?: any; hang?: boolean; err?: string }> {
  if (!signWin || signWin.isDestroyed()) return { err: '签名窗口不存在' };
  const r = await Promise.race([
    signWin.webContents.executeJavaScript(js).then(
      (v: any) => ({ ok: v }),
      (e: any) => ({ err: String((e && e.message) || e) })
    ),
    sleep(timeoutMs).then(() => ({ hang: true })),
  ]);
  if (r.hang) {
    CLog.warn('[signBridge] executeJavaScript 挂起，stop() 恢复');
    stopPendingNavigation();
  }
  return r;
}

/** 签名窗口 webContents（发送弹幕的真实键盘事件兜底用） */
export function getSignerWebContents(): Electron.WebContents | null {
  return signWin && !signWin.isDestroyed() ? signWin.webContents : null;
}

/**
 * 打开登录窗口（用户点击「登录抖音」时调用）
 *
 * 原理：
 *   - 创建一个可见的 BrowserWindow，使用与签名桥相同的持久化分区
 *     (persist:danmusign)，加载抖音登录页面
 *   - 用户在窗口中完成扫码/账号登录后，sessionid 等登录 Cookie 会自动
 *     持久化到该分区，后续 WSS 握手携带的 getSessionCookieString() 即包含
 *     登录态 Cookie → 抖音服务端据此推送礼物消息（WebcastGiftMessage）
 *
 * 背景知识（2026-04 验证）：
 *   - 抖音已更新推送策略：礼物消息只下发给已登录的连接
 *   - 未登录连接可正常收到弹幕/进场/点赞/关注，但收不到礼物
 *   - GitHub Issues saermart/DouyinLiveWebFetcher #160-#162 多人确认
 *
 * @param onClose 窗口关闭后的回调（通知 UI 刷新登录状态）
 */
let loginWin: BrowserWindow | null = null;
/** 登录窗口 Cookie 轮询定时器（检测扫码/账密登录成功后自动关闭窗口） */
let loginPollTimer: NodeJS.Timeout | null = null;

/**
 * 登录用户信息（登录成功后从 /dylive/webcast/user/me/ 接口获取）
 * - 用于 UI 显示登录账号的头像/昵称/粉丝数/关注数
 */
export interface LoggedInUserInfo {
  nickname?: string;
  avatar?: string;
  followerCount?: number | string;
  followingCount?: number | string;
  secUid?: string;
  displayId?: string;
  signature?: string;
}
export function openLoginWindow(onClose?: () => void): void {
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.focus();
    return;
  }
  CLog.info('[signBridge] 打开登录窗口');
  loginWin = new BrowserWindow({
    show: true,
    width: 980,
    height: 680,
    title: '登录抖音账号',
    webPreferences: {
      partition: SIGN_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  loginWin.webContents.setBackgroundThrottling(false);
  loginWin.webContents.on('render-process-gone', (_e, details) => {
    CLog.warn('[signBridge] 登录窗口渲染进程退出:', details.reason);
  });

  // 登录 URL 候选（2026-08 实测）：
  // - sso.douyin.com/login?service=... 是**唯一**真正显示登录页（验证码登录/密码登录）的 URL
  // - www.douyin.com/login 是 passport API，直接返回 JSON 错误（error_code=3 缺少参数），不是页面
  // - live.douyin.com/login 会重定向到随机直播间页面（表现为"已关闭的直播间"）
  // 登录成功（Cookie 轮询或跳转回 service）后 sessionid 设在 .douyin.com 域，分区内可检测
  const LOGIN_URLS = [
    'https://sso.douyin.com/login?service=https://live.douyin.com',
  ];
  let loginUrlIdx = 0;
  let redirectCount = 0;
  const MAX_REDIRECTS = 5;

  const loadLoginPage = () => {
    const url = LOGIN_URLS[loginUrlIdx] || LOGIN_URLS[LOGIN_URLS.length - 1];
    loginWin?.loadURL(url, { userAgent: UA }).catch((e: any) => {
      CLog.warn('[signBridge] 登录页面加载失败:', e?.message || e, 'url=', url);
    });
  };

  loadLoginPage();

  // 轮询检测登录状态（扫码登录通常不改变 URL，靠 Cookie 检测登录成功）
  loginPollTimer = setInterval(async () => {
    if (!loginWin || loginWin.isDestroyed()) {
      if (loginPollTimer) { clearInterval(loginPollTimer); loginPollTimer = null; }
      return;
    }
    try {
      const { loggedIn } = await checkLoginStatus();
      if (loggedIn) {
        if (loginPollTimer) { clearInterval(loginPollTimer); loginPollTimer = null; }
        CLog.info('[signBridge] 检测到登录成功（Cookie 轮询），关闭登录窗口');
        closeLoginWindow();
      }
    } catch (_) {}
  }, 2000);

  // 拦截导航：登录页可能被重定向到非登录页（如直播间页面）
  // - 导航到非登录页 → 检查是否已登录
  //   - 已登录 → 关闭窗口
  //   - 未登录 → 尝试下一个登录 URL（最多 MAX_REDIRECTS 次，防止无限循环）
  loginWin.webContents.on('did-navigate', async (_e, navUrl: string) => {
    const isLoginPage = navUrl.includes('/login') || navUrl.includes('sso.douyin.com');
    if (isLoginPage) return; // 在登录页，正常等待用户操作
    try {
      const { loggedIn } = await checkLoginStatus();
      if (loggedIn) {
        if (loginPollTimer) { clearInterval(loginPollTimer); loginPollTimer = null; }
        CLog.info('[signBridge] 检测到登录成功（页面跳转），关闭登录窗口');
        closeLoginWindow();
      } else {
        // 未登录但被重定向到非登录页 → 重新加载登录 URL（重试计数防死循环）
        redirectCount++;
        if (redirectCount <= MAX_REDIRECTS) {
          loginUrlIdx = (loginUrlIdx + 1) % LOGIN_URLS.length;
          CLog.info(`[signBridge] 登录页被重定向(${redirectCount}/${MAX_REDIRECTS})，尝试: ${LOGIN_URLS[loginUrlIdx].slice(0, 60)}`);
          loadLoginPage();
        } else {
          CLog.warn('[signBridge] 登录页重定向次数超限，不再自动重载。用户可手动在页面上登录。');
        }
      }
    } catch (_) {}
  });

  // 兜底：页面加载完成后检查内容是否为 JSON 错误（passport API 返回
  // {"error_code":3,"description":"缺少参数"}，URL 含 /login 会被 did-navigate
  // 误判为登录页而永不重试，这里直接检测内容并重新加载）
  loginWin.webContents.on('did-finish-load', async () => {
    if (!loginWin || loginWin.isDestroyed()) return;
    try {
      const text: string = await loginWin.webContents.executeJavaScript(
        '(document.body && document.body.innerText || "").trim().slice(0, 80)'
      );
      if (text.startsWith('{') && text.includes('error_code')) {
        redirectCount++;
        if (redirectCount <= MAX_REDIRECTS) {
          CLog.warn(`[signBridge] 登录页返回 JSON 错误（passport API: ${text.slice(0, 60)}），重新加载登录页 (${redirectCount}/${MAX_REDIRECTS})`);
          loginWin.webContents.loadURL(LOGIN_URLS[0], { userAgent: UA }).catch(() => {});
        }
      }
    } catch (_) {}
  });

  loginWin.on('closed', () => {
    loginWin = null;
    if (loginPollTimer) { clearInterval(loginPollTimer); loginPollTimer = null; }
    onClose?.();
  });

  // 拦截新窗口打开（防止登录跳转弹新窗口脱离分区）
  loginWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

/** 关闭登录窗口（幂等） */
function closeLoginWindow(): void {
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.close();
  }
  loginWin = null;
}

/**
 * 检查登录状态（通过检查持久化分区中是否有 sessionid Cookie）
 *  - sessionid 是抖音登录后的核心会话 Cookie
 *  - 有 sessionid → 已登录 → WSS 可收到礼物消息
 *  - 无 sessionid → 未登录 → WSS 收不到礼物消息
 * @returns { loggedIn: boolean, hasSession: boolean }
 */
export async function checkLoginStatus(): Promise<{ loggedIn: boolean }> {
  try {
    const ses = session.fromPartition(SIGN_PARTITION);
    const cookies = await ses.cookies.get({ url: SIGN_HOST });
    const hasSession = cookies.some(
      (c) => c.name === 'sessionid' && c.value && c.value.length > 10
    );
    if (!hasSession) {
      // 登录态丢失（抖音页面风控偶发清除 sessionid）：尝试从备份恢复后重查一次
      const restored = await restoreLoginCookies();
      if (restored) {
        CLog.info('[signBridge] 检测到登录 Cookie 丢失，已从备份恢复');
        return checkLoginStatus();
      }
    }
    return { loggedIn: hasSession };
  } catch (err) {
    CLog.warn('[signBridge] 检查登录状态失败:', err);
    return { loggedIn: false };
  }
}

/**
 * 获取当前登录用户信息（从 /webcast/user/me/ 接口）
 *  - 使用签名桥分区的 Cookie（包含 sessionid 登录态）发起请求
 *  - 使用 node:https 直连（与 request.ts 一致，net.fetch 的 Cookie 是 forbidden header）
 *  - 端点注意（2026-08 实测）：/webcast/user/me/ 是真实端点（无 cookie 返回
 *    status_code=20003 "User doesn't login"）；带 dylive 前缀的
 *    /dylive/webcast/user/me/ 已 404，勿再使用
 *  - 返回昵称/头像/粉丝数/关注数等，供 UI 显示
 * @returns 用户信息；未登录或获取失败返回 undefined
 */
/**
 * getLoggedInUserInfo 的结果
 *  - info: 用户信息（成功获取时）
 *  - expired: true 表示接口明确判定"未登录"（status_code=20003），登录态确定失效
 *    只有这种情况才允许自动清除登录 Cookie；网络错误/其他错误 expired=false，
 *    调用方不得清 Cookie（防误伤刚登录成功但接口瞬断的场景）
 */
export interface UserInfoResult {
  info?: LoggedInUserInfo;
  expired: boolean;
}

export async function getLoggedInUserInfo(): Promise<UserInfoResult | undefined> {
  try {
    const cookieStr = await getSessionCookieString();
    if (!cookieStr || !cookieStr.includes('sessionid')) return undefined;

    const params = new URLSearchParams({
      aid: '6383', app_name: 'douyin_web', device_platform: 'web',
      cookie_enabled: 'true', browser_language: 'zh-CN', browser_name: 'Mozilla',
      browser_platform: 'Win32', browser_online: 'true',
      enter_from: 'web_live', language: 'zh-CN', live_id: '1',
      os_name: 'Windows', os_version: '10',
      screen_height: '1080', screen_width: '1920',
    });
    const apiUrl = `https://live.douyin.com/webcast/user/me/?${params.toString()}`;

    const result = await new Promise<any>((resolve) => {
      const u = new URL(apiUrl);
      const r = https.request({
        method: 'GET',
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        headers: {
          'User-Agent': UA,
          'Referer': 'https://live.douyin.com/',
          'Cookie': cookieStr,
        },
        timeout: 10000,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            resolve(null);
          }
        });
      });
      r.on('error', () => resolve(null));
      r.on('timeout', () => { r.destroy(); resolve(null); });
      r.end();
    });

    // 网络失败/非 JSON 响应：不判定过期（可能是瞬断），调用方保留登录态
    if (!result) {
      CLog.warn('[signBridge] 获取用户信息失败: 响应为空（网络错误/超时）');
      return { expired: false };
    }
    // 接口明确判定未登录 -> 登录态确定失效
    if (result.status_code === 20003 || result.data?.message === "User doesn't login") {
      CLog.warn(`[signBridge] 获取用户信息: 接口判定未登录（status_code=${result.status_code}），登录态已失效`);
      return { expired: true };
    }
    if (result.status_code !== 0 || !result.data) {
      CLog.warn('[signBridge] 获取用户信息失败: status_code=' + (result?.status_code ?? 'null'));
      return { expired: false };
    }

    // 兼容多种返回结构：data 直挂用户字段 / data.user / data.user_profile
    const d = result.data;
    const usr = d.user || d.user_profile || d;
    const avatar: string =
      usr.avatar_medium?.url_list?.[0] ||
      usr.avatar_thumb?.url_list?.[0] ||
      usr.avatar_large?.url_list?.[0] || '';
    const info: LoggedInUserInfo = {
      nickname: usr.nickname || usr.base_info?.nickname || '',
      avatar,
      followerCount: usr.follow_info?.follower_count,
      followingCount: usr.follow_info?.following_count,
      secUid: usr.sec_uid || '',
      displayId: usr.display_id || usr.short_id || '',
      signature: usr.signature || '',
    };
    if (!info.nickname && !info.avatar) {
      // 结构不认识：记录原始键名便于排查，但不判定过期
      CLog.warn('[signBridge] 用户信息结构异常，data keys=' + Object.keys(d).join(','));
      return { expired: false };
    }
    CLog.info(`[signBridge] 获取登录用户信息成功: nick=${info.nickname} 粉丝=${info.followerCount ?? '-'} 关注=${info.followingCount ?? '-'}`);
    // 登录态确认有效 → 备份登录 Cookie（防页面风控清除后无法发弹幕）
    backupLoginCookies().catch(() => {});
    return { info, expired: false };
  } catch (err) {
    CLog.warn('[signBridge] 获取用户信息异常:', err);
    return { expired: false };
  }
}

/** 登录相关 Cookie 名（备份/恢复/清除共用；保留 ttwid 等访客 Cookie 供签名使用） */
const LOGIN_COOKIE_NAMES = new Set([
  'sessionid', 'sessionid_ss', 'sid_tt', 'uid_tt', 'uid_tt_ss',
  'sid_guard', 'passport_csrf_token', 'passport_csrf_token_default',
  'sso_uid_tt', 'sso_uid_tt_ss', 'passport_auth_status',
]);

/** 登录 Cookie 备份文件（userData 下）：防抖音页面风控把 sessionid 清掉后无法发弹幕 */
const loginCookieBackupFile = () => path.join(app.getPath('userData'), 'sign-login-cookies.json');

/** 备份当前登录 Cookie 到磁盘（登录成功 / 查询到登录态时调用，覆盖旧备份） */
async function backupLoginCookies(): Promise<void> {
  try {
    const ses = session.fromPartition(SIGN_PARTITION);
    const cookies = await ses.cookies.get({ url: SIGN_HOST });
    const login = cookies
      .filter((c) => LOGIN_COOKIE_NAMES.has(c.name) && c.value)
      .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }));
    if (!login.length) return;
    fs.writeFileSync(loginCookieBackupFile(), JSON.stringify(login));
    CLog.info(`[signBridge] 登录 Cookie 已备份（${login.length} 项: ${login.map((c) => c.name).join(',')}）`);
  } catch (err) {
    CLog.warn('[signBridge] 登录 Cookie 备份失败:', err);
  }
}

/** 从磁盘备份恢复登录 Cookie（sessionid 被页面风控清除后自愈） */
async function restoreLoginCookies(): Promise<boolean> {
  const file = loginCookieBackupFile();
  if (!fs.existsSync(file)) return false;
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(arr) || !arr.length) return false;
    const ses = session.fromPartition(SIGN_PARTITION);
    for (const c of arr) {
      if (!c || !c.name || !c.value) continue;
      await ses.cookies
        .set({
          url: SIGN_HOST,
          name: c.name,
          value: c.value,
          domain: c.domain || '.douyin.com',
          path: c.path || '/',
        })
        .catch(() => {});
    }
    return true;
  } catch (err) {
    CLog.warn('[signBridge] 登录 Cookie 恢复失败:', err);
    return false;
  }
}

/**
 * 清除登录态（退出登录）
 *  - 只清除登录相关 Cookie（sessionid/sid_tt/uid_tt 等），保留 ttwid 等访客 Cookie
 *  - 清除后 WSS 连接不再携带登录态，礼物消息不再下发
 *  - 同时删除备份文件，避免退出登录后又被自动恢复
 */
export async function clearLoginSession(): Promise<void> {
  try {
    const ses = session.fromPartition(SIGN_PARTITION);
    const cookies = await ses.cookies.get({ url: SIGN_HOST });
    let removed = 0;
    for (const c of cookies) {
      if (LOGIN_COOKIE_NAMES.has(c.name)) {
        await ses.cookies.remove(SIGN_HOST, c.name).catch(() => {});
        removed++;
      }
    }
    try {
      fs.rmSync(loginCookieBackupFile(), { force: true });
    } catch {}
    CLog.info(`[signBridge] 登录态已清除（移除 ${removed} 个登录 Cookie，已删除备份）`);
  } catch (err) {
    CLog.warn('[signBridge] 清除登录态失败:', err);
  }
}


/** 销毁签名桥（应用退出时） */
export function disposeSigner(): void {
  if (rebuildTimer) {
    clearTimeout(rebuildTimer);
    rebuildTimer = null;
  }
  lastSignRoomId = null;
  destroyWin();
  ipcMain.removeAllListeners('signer:acrawler-ready');
  ipcMain.removeAllListeners('signer:chat-ready');
  beaconListenerInstalled = false;
  resetPageSignals();
  if (loginPollTimer) { clearInterval(loginPollTimer); loginPollTimer = null; }
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.destroy();
  }
  loginWin = null;
  initPromise = null;
}

/** 销毁签名窗口（幂等：未创建/已销毁时静默跳过） */
function destroyWin() {
  if (signWin && !signWin.isDestroyed()) {
    signWin.destroy();
  }
  signWin = null;
}
