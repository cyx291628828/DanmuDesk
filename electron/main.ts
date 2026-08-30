// main.ts — DanmuDesk 主进程入口
// 职责：创建主窗口、管理多房间弹幕连接（DyCast WSS）、调度签名桥、消息转发、IPC 通信
import { app, BrowserWindow, ipcMain, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { CLog } from './core/logUtil';
import { DyCast, CastMethod } from './core/dycast';
import { Forwarder } from './forwarder';
import { fetchAnchorProfile } from './core/request';
import {
  disposeSigner,
  ensureSignerReady,
  openLoginWindow,
  checkLoginStatus,
  getLoggedInUserInfo,
  clearLoginSession,
  type LoggedInUserInfo,
} from './signBridge';
import {
  sendDanmu,
  addSchedule,
  updateSchedule,
  removeSchedule,
  removeSchedulesByRoom,
  listSchedules,
  stopAllSchedules,
  onScheduleResult,
  onLoginExpired,
} from './danmuSender';
import {
  getRoomForward,
  setRoomForward,
  addRoomHistory,
  getRoomHistory,
  removeRoomHistoryEntry,
  clearRoomHistory,
} from './settings';
import { initLicense, getLicenseStatus, activateLicense, onLicenseStatusChanged } from './license';

/** 日志目录：开发=项目根/log，打包=userData/log */
function getLogDir(): string {
  const dir = app.isPackaged
    ? path.join(app.getPath('userData'), 'log')
    : path.join(app.getAppPath(), 'log');

  return dir;
}

// 无 GPU 环境（虚拟机/远程桌面/部分沙箱）下禁用硬件加速，避免 GPU 进程崩溃导致应用退出
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('no-sandbox');
// 彻底关闭 GPU 合成器，消除「Failed to create GLES3 context / shared context」噪音（无独显环境用）
app.commandLine.appendSwitch('disable-gpu-compositing');
// 让 GPU 工作跑在主进程内，避免独立 GPU 进程在无显卡环境反复崩溃重启
app.commandLine.appendSwitch('in-process-gpu');
// 强制直连：避免系统/公司代理干扰抖音接口与签名桥页面加载
app.commandLine.appendSwitch('no-proxy-server');

// ---- 单实例锁：防止多开 ----
// 多个实例同时运行会共享 persist:danmusign 分区，Cookie 数据库互相覆盖，
// 导致 sessionid 反复丢失（登录态不稳定、弹幕发不出去、分区文件 IO 锁错误）。
// 后启动的实例直接退出，并把焦点给已运行的实例。
if (!app.requestSingleInstanceLock()) {
  // 在新开的命令窗里给出明确提示（否则窗口闪退无任何输出，像「日志丢了」）
  console.log('[DanmuDesk] 应用已在运行中，本次启动已退出（已把焦点切到已运行的窗口）。');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });
}

let mainWin: BrowserWindow | null = null;

// ---- 多房间管理 ----
interface RoomState {
  cast: DyCast | null;
  cleanup: Array<() => void> | null;
  connectSeq: number;
  anchorInfo: { nickname: string; avatar: string; liveTitle: string; followerCount?: number | string; followingCount?: number | string; likeCount?: number | string };
  msgFilters: Record<string, boolean>;
  stats: { chat: number; gift: number; enter: number; like: number; follow: number };
  /** 每房间独立的消息转发器 */
  forwarder: Forwarder | null;
  /** 自动重连次数（服务端异常踢线后自动重连，open 成功后清零；超限放弃） */
  autoReconnectCount: number;
  /** 连接超时兜底定时器（每房间独立，多房间并发连接互不干扰） */
  connectTimer: NodeJS.Timeout | null;
}
const rooms = new Map<string, RoomState>();

/** 自动重连上限：连续被服务端踢线超过该次数仍未稳定，放弃自动重连并提示 */
const MAX_AUTO_RECONNECT = 3;

/**
 * 整体连接超时（覆盖签名桥页面加载 + 房间页抓取 + im/fetch + WSS 握手全流程）。
 * 签名桥内部已带自动重试（2 次 × 30s），正常连接 1~5s 完成；该兜底只拦截极端卡死。
 */
const CONNECT_TIMEOUT_MS = 150000;

/** 连接代数计数器：每次发起连接都自增（历史实现用 Date.now()，同毫秒并发连接会撞号） */
let connectSeqCounter = 0;
function nextConnectSeq(): number {
  return ++connectSeqCounter;
}

/** 连接被取消/超时时的原因（连接流程收尾时取回，给渲染进程展示准确的失败文案） */
const cancelReasons = new Map<string, string>();

if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY) {
  CLog.warn(`[main] 检测到代理环境变量 HTTP_PROXY=${process.env.HTTP_PROXY} HTTPS_PROXY=${process.env.HTTPS_PROXY}`);
}

// ---- 消息类型映射：dycast 消息 → UI 简化类型 ----
const TYPE_MAP: Record<string, string> = {
  [CastMethod.CHAT]: 'chat',
  [CastMethod.EMOJI_CHAT]: 'chat',
  [CastMethod.GIFT]: 'gift',
  [CastMethod.MEMBER]: 'enter',
  [CastMethod.LIKE]: 'like',
  [CastMethod.SOCIAL]: 'follow',
  [CastMethod.CONTROL]: 'sys',
  [CastMethod.ROOM_STATS]: 'sys',
  [CastMethod.ROOM_USER_SEQ]: 'sys',
  [CastMethod.ROOM_RANK]: 'sys',
};

interface UiMessage {
  type: string;
  /** 消息自身时间（common.createTime 秒级时间戳字符串，缺失时渲染层用本地时间兜底） */
  time?: string;
  /** 观众信息：昵称/头像/粉丝数/关注数/消费等级/粉丝团（尽力携带） */
  user: {
    id?: string;
    displayId?: string;
    nickname?: string;
    avatar?: string;
    avatarMedium?: string;
    avatarLarge?: string;
    gender?: number;
    signature?: string;
    verified?: boolean;
    followingCount?: number | string;
    followerCount?: number | string;
    payLevel?: number | string;
    payGradeName?: string;
    fansClubName?: string;
    fansClubLevel?: number;
  } | null;
  content: string;
  giftName?: string;
  giftId?: string;
  giftCount?: number;
  repeatCount?: number;
  /** 点赞：当前玩家本次点赞数（点赞消息的 count 字段） */
  likeCount?: number;
  /** 点赞：直播间累计总点赞数（点赞消息的 total 字段） */
  likeTotal?: number;
  online?: number | string;
  batch: number;
  /** 所属房间号（多房间支持） */
  roomId?: string;
}

let batchSeq = 0;
const BATCH_MS = 400;

// ---- 连接超时兜底（每房间独立） ----
// connectSeq：连接「代数」，每次发起连接/断开都换新；进行中的异步流程
// （如签名桥加载）完成后对比代数，若已过期则放弃收尾，防止旧连接流程
// 覆盖新连接状态（竞态保护）。

/** 判断房间的连接流程是否仍然有效（未被取消/超时/替换） */
function isRoomSeqAlive(roomId: string, seq: number): boolean {
  return rooms.get(roomId)?.connectSeq === seq;
}

/** 启动指定房间的连接超时兜底：整个连接流程超时 → 自动拆除并提示 */
function startConnectTimer(roomId: string, seq: number) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearConnectTimer(roomId);
  room.connectTimer = setTimeout(() => {
    const r = rooms.get(roomId);
    if (!r || r.connectSeq !== seq) return;
    CLog.warn(`[main] 连接超时（${CONNECT_TIMEOUT_MS / 1000}s 内未连接成功），自动断开 room=${roomId}`);
    teardownRoom(roomId, `连接超时：${CONNECT_TIMEOUT_MS / 1000} 秒内未连接成功，已自动断开，请重试`);
    sendStatus('error', { roomId, msg: `连接超时：${CONNECT_TIMEOUT_MS / 1000} 秒内未连接成功，请重试` });
    sendToRenderer('danmu:error', { msg: `连接超时：${CONNECT_TIMEOUT_MS / 1000} 秒内未连接成功，请重试` });
  }, CONNECT_TIMEOUT_MS);
}

/** 取消指定房间的连接超时定时器（open/close/断开时调用） */
function clearConnectTimer(roomId: string) {
  const room = rooms.get(roomId);
  if (room?.connectTimer) {
    clearTimeout(room.connectTimer);
    room.connectTimer = null;
  }
}

/**
 * 统一拆除指定房间的连接：断开 DyCast、移除监听、通知渲染进程
 * @param roomId 房间号
 * @param reasonMsg 断开原因文案（渲染进程 toast 显示；连接流程收尾时也会取回展示）
 */
function teardownRoom(roomId: string, reasonMsg?: string) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.connectSeq++;
  clearConnectTimer(roomId);
  if (reasonMsg) cancelReasons.set(roomId, reasonMsg);
  // 房间断开即移除该房间的全部定时任务（任务卡片随房间一起消失）
  const removedTasks = removeSchedulesByRoom(roomId);
  if (removedTasks.length) {
    sendToRenderer('danmu:schedule-changed', { roomId, removed: removedTasks });
  }
  if (room.cast) {
    try { room.cast.close(); } catch {}
    room.cast = null;
  }
  if (room.cleanup) {
    room.cleanup.forEach((fn) => fn());
    room.cleanup = null;
  }
  // 断开该房间的转发器
  if (room.forwarder) {
    room.forwarder.dispose();
    room.forwarder = null;
  }
  rooms.delete(roomId);
  if (reasonMsg) sendStatus('disconnected', { roomId, msg: reasonMsg });
}

/**
 * 拆除所有房间连接（应用退出时调用）
 */
function teardownAllRooms() {
  for (const [rid] of rooms) teardownRoom(rid);
}

/**
 * 构建转发消息（主进程收到弹幕时调用）
 *  - 携带：用户完整信息、事件、事件内容、文本消息、礼物字段、点赞次数
 *  - eventContent 描述事件本身（礼物名称数量/点赞数/进场等），text 放弹幕正文
 *  - 字段裁剪：不需要的字段在 forwarder.ts 的 ForwardPayload / 本函数里注释即可
 */
function buildForwardPayload(ui: UiMessage, m: DyMessage, roomId: string): ForwardPayload {
  let eventContent = '';
  switch (ui.type) {
    case 'gift':
      eventContent = `送出 ${ui.giftName || '礼物'} ×${ui.giftCount ?? 1}${ui.repeatCount && ui.repeatCount > 1 ? `（连击 ${ui.repeatCount}）` : ''}`;
      break;
    case 'like':
      eventContent = `点赞 ×${ui.likeCount ?? 1}（直播间总赞 ${ui.likeTotal ?? '-'}）`;
      break;
    case 'enter':
      eventContent = '进入直播间';
      break;
    case 'follow':
      eventContent = '关注了主播';
      break;
    case 'chat':
      eventContent = '发送弹幕';
      break;
    default:
      eventContent = ui.content || '系统消息';
  }
  return {
    event: ui.type,
    eventContent,
    text: ui.type === 'chat' ? ui.content : '',
    // 转发观众信息：完整字段（UID/抖音号/昵称/头像三档/性别/签名/认证/粉丝/关注/等级/粉丝团）
    // 字段裁剪：不需要的字段直接注释掉对应行
    user: {
      id: ui.user?.id || '',
      displayId: ui.user?.displayId || '',
      name: ui.user?.nickname || '',
      avatar: ui.user?.avatar || '',
      avatarMedium: ui.user?.avatarMedium || '',
      avatarLarge: ui.user?.avatarLarge || '',
      gender: ui.user?.gender,
      signature: ui.user?.signature || '',
      verified: ui.user?.verified,
      followingCount: ui.user?.followingCount,
      followerCount: ui.user?.followerCount,
      payLevel: ui.user?.payLevel,
      payGradeName: ui.user?.payGradeName || '',
      fansClubName: ui.user?.fansClubName || '',
      fansClubLevel: ui.user?.fansClubLevel,
    },
    // 礼物消息额外携带：礼物 ID / 名称 / 数量 / 连击次数 / 单价
    giftId: ui.giftId,
    giftName: ui.type === 'gift' ? ui.giftName : undefined,
    giftCount: ui.type === 'gift' ? ui.giftCount : undefined,
    repeatCount: ui.type === 'gift' ? ui.repeatCount : undefined,
    giftPrice: ui.type === 'gift' ? m.gift?.price : undefined,
    // 点赞消息额外携带：玩家本次点赞数
    likeCount: ui.type === 'like' ? ui.likeCount : undefined,
    roomId,
    // 消息唯一 ID
    msgId: m.id,
    ts: Date.now(),
  };
}

/** 秒级时间戳 → HH:MM:SS（消息时间显示用；无/非法时回退当前时间） */
function formatMsgTime(sec?: string | number): string {
  let n = Number(sec);
  if (!sec || !isFinite(n) || n <= 0) n = Date.now();
  if (n < 1e12) n *= 1000; // 秒 → 毫秒
  const d = new Date(n);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 详细日志：把每条消息的用户/事件/内容完整落盘
 *  - 首列 time 为弹幕自身的发送时间（HH:MM:SS，来自 common.createTime；
 *    重连补发的历史消息会显示它们原本的时间，与本地记录时间区分开）
 *  - 观众信息：昵称 + UID + 抖音号 + 头像 URL + 粉丝数/关注数 + 消费等级 + 粉丝团
 *  - 消息信息：完整正文
 *  - 直播间信息：在线人数/总赞等随消息实时更新
 *  （log/app.log 50MB 自动轮转，高频房间也不怕）
 */
function logMessageDetail(ui: UiMessage, m: DyMessage, roomId: string) {
  const u = ui.user;
  const uid = u?.id || m.user?.id || '-';
  const avatar = u?.avatar || m.user?.avatar || '';
  const msgTime = formatMsgTime(m.time);
  let detail = `[msg] ${msgTime} ${ui.type} user=${u?.nickname || '-'} uid=${uid}`;
  if (u?.displayId) detail += ` dy=${u.displayId}`;
  // 头像 URL 完整打印，不做截断（曾有 slice(0,90) 导致日志里的 URL 残缺、无法复现排查）
  if (avatar) detail += ` avatar=${avatar}`;
  // 观众扩展信息（粉丝数/关注数/等级/粉丝团）
  if (u?.followerCount !== undefined) detail += ` 粉丝=${u.followerCount}`;
  if (u?.followingCount !== undefined) detail += ` 关注=${u.followingCount}`;
  if (u?.payLevel !== undefined) detail += ` 消费等级=${u.payLevel}${u.payGradeName ? '(' + u.payGradeName + ')' : ''}`;
  if (u?.fansClubName || u?.fansClubLevel !== undefined) {
    // 实测：服务端常只下发灯牌等级（level），团名（clubName）可能为空
    detail += ` 粉丝团=${u.fansClubName || '灯牌'}${u.fansClubLevel !== undefined ? ` Lv.${u.fansClubLevel}` : ''}`;
  }
  if (u?.verified) detail += ' [认证]';
  if (m.gift) detail += ` gift=${ui.giftName || '-'} giftId=${m.gift.id || '-'} count=${ui.giftCount ?? 1} price=${m.gift.price ?? '-'} 连击=${ui.repeatCount ?? 1}`;
  if (ui.likeTotal !== undefined) detail += ` 玩家赞=${ui.likeCount ?? 1} 总赞=${ui.likeTotal}`;
  if (ui.online !== undefined && ui.online !== null) detail += ` 在线=${ui.online}`;
  if (ui.content) detail += ` 内容=${ui.content.slice(0, 120)}`;
  detail += ` room=${roomId}`;
  CLog.info(detail);
}

/**
 * 将 dycast 的 DyMessage 转换为渲染进程友好的 UiMessage
 *
 * 重点逻辑 —— 礼物连击（repeatEnd）：
 *   抖音礼物消息在连击期间会重复推送，repeatEnd 标记连击阶段：
 *     - repeatEnd === 0 ：连击第一次（连击开始），应显示「x1」
 *     - repeatEnd === 1 ：连击最后一次（或单次礼物），显示最终连击数
 *   UI 侧结合 batch 号 + 同一用户 + 同一礼物可做「连击中实时累计」动画。
 */
function toUiMessage(m: DyMessage): UiMessage {
  const type = TYPE_MAP[m.method || ''] || 'sys';
  // 礼物连击数：repeatEnd=0 表示第一次发送
  let repeatCount = 0;
  if (m.gift && m.gift.repeatEnd !== undefined) {
    repeatCount = m.gift.repeatEnd === 0 ? 1 : m.gift.repeatEnd;
  }
  return {
    type,
    // 消息自身时间（弹幕的 common.createTime；重连补发时显示原发送时间）
    time: m.time,
    // 完整观众信息透传：头像三档 / 粉丝数 / 关注数 / 消费等级 / 粉丝团
    // （dycast 的 CastUser 已尽力提取，这里原样搬给渲染进程与转发器）
    user: m.user
      ? {
          id: m.user.id,
          displayId: m.user.displayId,
          nickname: m.user.name,
          avatar: m.user.avatar,
          avatarMedium: m.user.avatarMedium,
          avatarLarge: m.user.avatarLarge,
          gender: m.user.gender,
          signature: m.user.signature,
          verified: m.user.verified,
          followingCount: m.user.followingCount,
          followerCount: m.user.followerCount,
          payLevel: m.user.payLevel,
          payGradeName: m.user.payGradeName,
          fansClubName: m.user.fansClubName,
          fansClubLevel: m.user.fansClubLevel,
        }
      : null,
    content: m.content || '',
    giftName: m.gift?.name,
    giftId: m.gift?.id,
    giftCount: m.gift?.count !== undefined ? Number(m.gift.count) : 1,
    repeatCount,
    // 点赞双数值：likeCount=当前玩家本次点赞数(count)，likeTotal=直播间总赞(total)
    likeCount: m.room?.likeCnt !== undefined ? Number(m.room.likeCnt) : undefined,
    likeTotal: m.room?.likeCount !== undefined ? Number(m.room.likeCount) : undefined,
    online: m.room?.audienceCount,
    batch: 0,
  };
}

function sendToRenderer(channel: string, payload: any) {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send(channel, payload);
  }
}

function sendStatus(state: string, extra: Record<string, any> = {}) {
  sendToRenderer('danmu:status', { state, ...extra });
}

/**
 * 绑定 DyCast 事件 → 渲染进程 IPC 转发，并返回清理函数数组
 *
 * 设计要点：每个事件监听器都记录对应的 off 清理函数并返回。
 * 重连/断连时调用清理函数即可精确移除旧监听，避免旧连接的事件
 * 泄漏到新连接（修复历史 bug：原实现传新空函数无法真正 off）。
 *
 * 转发规则：
 *   - open    → danmu:status { state:'connected', anchorName, liveTitle }
 *   - message → 每条转成 UiMessage，同批打同 batch 号；在线人数单独走 status
 *   - close   → danmu:status { state:'disconnected', code, msg }
 *   - reconnecting → danmu:status { state:'connecting', msg:'重连中 (n/3)' }
 *   - error   → danmu:error { msg }
 *
 * @param roomId 当前连接的房间号（注入到 status 载荷中供 UI 展示）
 * @returns 清理函数列表（逐一调用可移除全部监听）
 */
function bindCastEvents(roomId: string): Array<() => void> {
  const room = rooms.get(roomId);
  if (!room || !room.cast) return [];
  const handlers: Array<() => void> = [];
  const cast = room.cast;  // 多房间：从房间状态取 cast 实例

  const onOpen = (_ev: any, info: DyLiveInfo) => {
    // 连接成功：取消超时兜底，防止误杀刚建立的连接
    clearConnectTimer(roomId);
    cancelReasons.delete(roomId);
    // 连接成功 → 清零自动重连计数（只要这次稳定，下次断开从头计）
    if (room) room.autoReconnectCount = 0;
    // 记录连接历史（输入框历史记录数据源；去重置顶，上限 20 条）
    addRoomHistory({
      roomId,
      nickname: info?.nickname || '',
      avatar: info?.avatar || '',
    });
    // 记录主播信息（房间级别）
    const anchor: RoomState['anchorInfo'] = {
      nickname: info?.nickname || '',
      avatar: info?.avatar || '',
      liveTitle: info?.title || '',
      followerCount: info?.followerCount,
      followingCount: info?.followingCount,
      likeCount: info?.likeCount,
    };
    if (room) room.anchorInfo = anchor;
    // 详细日志：连接信息 + 直播间信息（主播/标题/头像/状态码/总赞）
    CLog.info(
      `[main] 连接成功 room=${roomId} 主播=${info?.nickname || '-'} 标题=${info?.title || '-'} ` +
        `头像=${info?.avatar || '-'} 粉丝=${info?.followerCount ?? '-'} 关注=${info?.followingCount ?? '-'} ` +
        `总赞=${info?.likeCount ?? '-'} 状态码=${info?.status ?? '-'}`
    );
    sendStatus('connected', {
      roomId,
      anchorName: anchor.nickname,
      liveTitle: anchor.liveTitle,
      anchorAvatar: anchor.avatar,
      anchorFollowerCount: anchor.followerCount,
      anchorFollowingCount: anchor.followingCount,
      anchorLikeCount: anchor.likeCount,
    });
    // 房间号未能解析出直播间页面（resolved=false：getLiveInfo 失败兜底）：
    // 此时 WSS 即使握手成功服务器也不订阅消息，且签名窗口加载该号会 404 无声。
    // 推送提示，避免用户误以为连接正常（表现为"连接成功但没声音没弹幕"）。
    if (info && info.resolved === false) {
      CLog.warn(
        `[main] 房间 ${roomId} 未解析出直播间页面（房间号可能无效或已下播），该房间收不到消息且无声音`
      );
      sendStatus('room-invalid', {
        roomId,
        msg: `房间号 ${roomId} 可能无效或直播间已下播，可能收不到弹幕且无声音`,
      });
    }
    // 主播粉丝数/关注数补全：页面 anchor.follow_info 不下发数字，改走
    // webcast/user/profile 接口（浏览器点击用户名时调用的同款接口，无需签名，
    // 但必须带 target_uid/sec_target_uid/anchor_id/sec_anchor_id 四个参数）。
    // 异步执行不阻塞连接；成功后推送 danmu:anchor 更新右侧面板。
    if (info?.anchorId && info?.anchorSecUid) {
      fetchAnchorProfile(info.anchorId, info.anchorSecUid, info.roomId || roomId)
        .then((profile) => {
          if (!profile) return;
          // 防串台：异步返回时若已切到别的直播间，丢弃本次结果
          let changed = false;
          if (room && profile.followerCount !== undefined && String(room.anchorInfo.followerCount ?? '') !== String(profile.followerCount)) {
            room.anchorInfo.followerCount = profile.followerCount;
            changed = true;
          }
          if (room && profile.followingCount !== undefined && String(room.anchorInfo.followingCount ?? '') !== String(profile.followingCount)) {
            room.anchorInfo.followingCount = profile.followingCount;
            changed = true;
          }
          if (changed) {
            CLog.info(
              `[main] 主播信息更新（profile接口）: 粉丝=${room?.anchorInfo.followerCount} 关注=${room?.anchorInfo.followingCount}`
            );
            sendToRenderer('danmu:anchor', { roomId, ...room?.anchorInfo });
          }
        })
        .catch(() => {});
    }
  };
  cast.on('open', onOpen);
  handlers.push(() => cast?.off('open', onOpen));

  const onMessage = (msgs: DyMessage[]) => {
    // 同批消息打同 batch 号，便于 UI 合并连击
    batchSeq++;
    msgs.forEach((m) => {
      const ui = toUiMessage(m);
      ui.batch = batchSeq;
      ui.roomId = roomId;
      sendToRenderer('danmu:message', ui);
      // 主播信息兜底：弹幕流中昵称与主播一致的消息（多为主播发言），
      // 若携带粉丝数/关注数则更新房间面板
      if (room && room.anchorInfo.nickname && ui.user?.nickname === room.anchorInfo.nickname) {
        let changed = false;
        if (ui.user.followerCount !== undefined && String(room.anchorInfo.followerCount ?? '') !== String(ui.user.followerCount)) {
          room.anchorInfo.followerCount = ui.user.followerCount;
          changed = true;
        }
        if (ui.user.followingCount !== undefined && String(room.anchorInfo.followingCount ?? '') !== String(ui.user.followingCount)) {
          room.anchorInfo.followingCount = ui.user.followingCount;
          changed = true;
        }
        if (changed) {
          CLog.info(`[main] 主播信息更新（弹幕流兜底）: 粉丝=${room.anchorInfo.followerCount} 关注=${room.anchorInfo.followingCount}`);
          sendToRenderer('danmu:anchor', { roomId, ...room.anchorInfo });
        }
      }
      // 在线人数（来自观众席消息）
      if (ui.online !== undefined && ui.online !== null) {
        sendToRenderer('danmu:status', { state: 'connected', roomId, onlineCount: ui.online });
      }
      // 主播粉丝数（关注消息兜底）：SOCIAL 消息（有人关注主播时下发）携带的
      // followCount 即主播最新粉丝数，比等主播发言更实时——房间页 anchor.follow_info
      // 只有 follow_status，抖音服务端不在页面下发粉丝数，这是页面对外的唯一实时来源
      if (m.method === CastMethod.SOCIAL && m.room?.followCount !== undefined && m.room?.followCount !== null) {
        const fc = m.room.followCount;
        if (room && String(room.anchorInfo.followerCount ?? '') !== String(fc)) {
          room.anchorInfo.followerCount = fc;
          CLog.info(`[main] 主播粉丝数更新（关注消息）: 粉丝=${fc}`);
          sendToRenderer('danmu:anchor', { roomId, ...room.anchorInfo });
        }
      }
      // 本场总赞：点赞消息带直播间累计总赞（total），实时同步到主播信息（不单独推送，
      // 渲染层已直接消费点赞消息更新右侧「本场总赞」，这里仅保持主进程状态一致）
      if (ui.likeTotal !== undefined && ui.likeTotal !== null && room) {
        const cur = Number(room.anchorInfo.likeCount ?? 0);
        if (Number(ui.likeTotal) > cur) room.anchorInfo.likeCount = ui.likeTotal;
      }
      // ① 详细日志 + ② 消息转发：受房间过滤勾选控制（msgFilters）
      //  - 未勾选的消息类型：不打印日志、不转发
      //  - 勾选的：打印 + 转发（转发受房间独立转发器 + 转发开关控制）
      const filterOn = room && room.msgFilters[ui.type] !== false;
      if (filterOn) {
        // ① 详细日志：观众信息（昵称/UID/头像）+ 消息内容（见 logMessageDetail）
        logMessageDetail(ui, m, roomId);
        // ② 消息转发：每房间独立转发器，连接即转发（isForwardingEnabled 由连接/断开控制）
        if (room?.forwarder && room.forwarder.isForwardingEnabled()) {
          room.forwarder.forward(buildForwardPayload(ui, m, roomId));
        }
      }
      // ③ 下播检测：控制消息 status >= 3 表示主播暂停/离开/已下播，自动断开
      if (m.method === CastMethod.CONTROL && m.room?.status) {
        const st = Number(m.room.status);
        if (st >= 3) {
          const desc = st === 4 ? '直播间已下播' : st === 3 ? '主播已暂停直播（离开）' : `直播间状态异常(${st})`;
          CLog.warn(`[main] 检测到下播信号 status=${st}（1=准备 2=直播中 3=暂停 4=下播），${desc}，自动断开连接`);
          teardownRoom(roomId, `${desc}，连接已自动断开`);
        }
      }
    });
  };
  cast.on('message', onMessage);
  handlers.push(() => cast?.off('message', onMessage));

  const onClose = (code: number, msg: string) => {
    // 连接已关闭：取消超时兜底（无论成功失败，状态都交给 close 事件决定）
    clearConnectTimer(roomId);
    CLog.warn(`[main] 连接关闭 room=${roomId} code=${code} msg=${msg}`);
    if (room) {
      room.cast = null;
      room.cleanup = null;
    }
    // 自动重连判定：
    //   - 服务端无理由踢线（code=1005 NO_STATUS / 1006 ABNORMAL）且房间仍在监听
    //     （未被用户手动断开/下播自动清理，那两种情况 rooms 里已无此房间）→ 自动重连
    //   - 下播（4001）/连接错误（4002）/用户手动断开 → 彻底清理房间（rooms 出栈，
    //     防泄漏）并推送 disconnected；此前只发状态不清理，房间对象一直挂在内存里
    const serverKick = code === 1005 || code === 1006;
    if (serverKick && rooms.has(roomId)) {
      scheduleAutoReconnect(roomId);
    } else {
      teardownRoom(roomId);
      sendStatus('disconnected', { roomId, code, msg: String(msg) });
    }
  };
  cast.on('close', onClose);
  handlers.push(() => cast?.off('close', onClose));

  const onReconnecting = (count: number) => {
    sendStatus('connecting', { roomId, msg: `重连中 (${count}/3)` });
  };
  cast.on('reconnecting', onReconnecting);
  handlers.push(() => cast?.off('reconnecting', onReconnecting));

  // WSS 层自动重连成功（游标续传）：刷新房间状态，让 UI 从「重连中」回到「已连接」
  const onReconnect = () => {
    CLog.info(`[main] 房间 ${roomId} WSS 重连成功（游标续传）`);
    sendStatus('connected', {
      roomId,
      anchorName: room?.anchorInfo.nickname || '',
      liveTitle: room?.anchorInfo.liveTitle || '',
      anchorAvatar: room?.anchorInfo.avatar || '',
      anchorFollowerCount: room?.anchorInfo.followerCount,
      anchorFollowingCount: room?.anchorInfo.followingCount,
      anchorLikeCount: room?.anchorInfo.likeCount,
    });
  };
  cast.on('reconnect', onReconnect);
  handlers.push(() => cast?.off('reconnect', onReconnect));

  const onError = (err: Error) => {
    CLog.error('[main] 弹幕错误 =>', err);
    sendToRenderer('danmu:error', { msg: err?.message || '未知错误' });
  };
  cast.on('error', onError);
  handlers.push(() => cast?.off('error', onError));

  return handlers;
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 860,
    minHeight: 600,
    title: 'DanmuDesk 弹幕桌面',
    backgroundColor: '#12141a', // 与渲染进程深色主题一致，避免加载白闪
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, // 渲染进程无法访问 Node，仅通过 preload 桥接
      nodeIntegration: false,
      sandbox: false, // 允许 preload 使用 require（仅主窗口；签名桥窗口必须保持沙箱！）
    },
  });
  // 注意：渲染进程统一放在 dist/renderer（build.mjs 从根目录 renderer/ 复制而来），
  // 这样开发态与打包后（asar 内）路径一致，不会出现 app.asar/renderer 不存在的坑
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWin.on('closed', () => {
    mainWin = null;
    // Windows 惯例：主窗口关闭 = 退出整个应用（签名桥等隐藏窗口随 before-quit 一并清理）。
    // 否则隐藏的签名桥窗口会让 window-all-closed 永不触发，应用变成无界面僵尸实例，
    // 一直占着单实例锁，表现为「一键启动打不开软件」。
    app.quit();
  });
}

// ---- IPC ----
/**
 * 连接直播间（手动连接与自动重连共用）
 *
 * 流程：
 *   1. 房间状态「提前」创建并入 Map（含连接代数）—— 此前要等签名桥就绪才创建，
 *      导致连接中的「取消」「超时兜底」全都失效（房间不在 Map 里，查无此房）
 *   2. 等待签名桥就绪（首次连接时隐藏窗口加载抖音页面 + 注入 acrawler，
 *      失败自动重试；就绪后就地缓存，后续连接秒级复用）
 *   3. 创建 DyCast 并绑定事件 → connect()
 *   4. 每个异步节点后校验连接代数，已过期（被取消/超时/替换）立即放弃
 *
 * @param rid   房间号（已校验）
 * @param mySeq 连接代数（每次发起连接都换新，用于竞态保护）
 */
async function connectRoom(rid: string, mySeq: number): Promise<{ ok: boolean; msg?: string }> {
  // 房间状态提前创建：自动重连等场景沿用旧房间的过滤/统计/转发配置与主播信息
  let room = rooms.get(rid);
  if (!room) {
    room = {
      cast: null,
      cleanup: null,
      connectSeq: mySeq,
      anchorInfo: { nickname: '', avatar: '', liveTitle: '' },
      msgFilters: {},
      stats: { chat: 0, gift: 0, enter: 0, like: 0, follow: 0 },
      forwarder: null,
      autoReconnectCount: 0,
      connectTimer: null,
    };
    rooms.set(rid, room);
  } else {
    room.connectSeq = mySeq;
  }
  // 超时兜底：覆盖整个连接流程（签名桥加载 + 房间页抓取 + im/fetch + WSS 建立）
  startConnectTimer(rid, mySeq);
  try {
    await ensureSignerReady(rid);
    if (!isRoomSeqAlive(rid, mySeq)) return { ok: false, msg: takeCancelReason(rid) };
    const cast = new DyCast(rid);
    room.cast = cast;
    room.cleanup = bindCastEvents(rid);
    await cast.connect();
    if (!isRoomSeqAlive(rid, mySeq)) return { ok: false, msg: takeCancelReason(rid) };
    return { ok: true };
  } catch (err: any) {
    if (!isRoomSeqAlive(rid, mySeq)) return { ok: false, msg: takeCancelReason(rid) };
    clearConnectTimer(rid);
    // 清理半建立的房间（含监听/转发器/定时器）
    teardownRoom(rid);
    CLog.error('[main] 连接失败 =>', err);
    sendStatus('error', { roomId: rid, msg: err?.message || '连接失败' });
    return { ok: false, msg: err?.message || '连接失败' };
  }
}

/** 取出并清除连接取消原因（连接流程收尾时给渲染进程展示准确文案） */
function takeCancelReason(roomId: string): string {
  const msg = cancelReasons.get(roomId) || '连接已被取消';
  cancelReasons.delete(roomId);
  return msg;
}

/**
 * 服务端异常踢线后的自动重连调度
 *  - 延迟 1.5s×n 递增（最多 5s），给服务端/网络留恢复时间
 *  - 重连沿用 connectRoom 完整流程；期间用户手动断开会因 connectSeq
 *    竞态保护被安全取消
 *  - 连续超过 MAX_AUTO_RECONNECT 次仍未稳定 → 放弃并提示用户重新连接
 */
function scheduleAutoReconnect(roomId: string) {
  const room = rooms.get(roomId);
  if (!room) return;
  const n = (room.autoReconnectCount || 0) + 1;
  room.autoReconnectCount = n;
  if (n > MAX_AUTO_RECONNECT) {
    CLog.warn(`[main] 房间 ${roomId} 连续被断开 ${MAX_AUTO_RECONNECT} 次仍未稳定，放弃自动重连`);
    teardownRoom(roomId, '连接不稳定（多次断开），已停止自动重连');
    sendStatus('error', { roomId, msg: '连接不稳定（多次断开），请重新连接' });
    return;
  }
  const delay = Math.min(5000, 1500 * n);
  CLog.warn(`[main] 房间 ${roomId} 连接被服务端断开，${Math.round(delay / 1000)}s 后自动重连（${n}/${MAX_AUTO_RECONNECT}）`);
  sendStatus('connecting', { roomId, msg: `连接断开，${Math.round(delay / 1000)} 秒后自动重连...` });
  setTimeout(async () => {
    if (!rooms.has(roomId)) return; // 期间已被用户手动断开/删除
    try {
      const res = await connectRoom(roomId, nextConnectSeq());
      if (!res.ok) {
        CLog.warn(`[main] 自动重连失败 room=${roomId}: ${res.msg}`);
      }
    } catch (e: any) {
      CLog.error(`[main] 自动重连异常 room=${roomId} =>`, e);
    }
  }, delay);
}

/** 授权门禁：未授权/过期时拒绝并提示（连接、发送、添加定时任务共用） */
function licenseDeny(): { ok: false; msg: string } | null {
  const st = getLicenseStatus();
  if (st.ok) return null;
  return { ok: false, msg: `${st.msg}（点击顶部授权状态可激活）` };
}

/**
 * IPC: danmu:connect —— 连接直播间（渲染进程点击「连接」时调用）
 *  - 校验房间号格式（至少 4 位数字，兼容粘贴直播链接中的纯数字）
 *  - 断开旧连接（若存在）后走公共 connectRoom 流程
 */
ipcMain.handle('danmu:connect', async (_event, roomId: string) => {
  const deny = licenseDeny();
  if (deny) return deny;
  const rid = String(roomId).trim();
  if (!/^\d{4,}$/.test(rid)) {
    return { ok: false, msg: '房间号格式不正确' };
  }
  // 如果该房间已连接，先断开
  if (rooms.has(rid)) {
    teardownRoom(rid);
  }
  sendStatus('connecting', { roomId: rid });
  return connectRoom(rid, nextConnectSeq());
});

/**
 * IPC: danmu:disconnect —— 主动断开连接
 *  - 连接中（connecting）也可调用：会立即使进行中的签名桥/连接流程失效
 *  - 关闭 DyCast、移除全部事件监听、通知渲染进程状态
 */
ipcMain.handle('danmu:disconnect', (_event, roomId?: string) => {
  if (roomId) {
    teardownRoom(roomId, '已手动断开');
  } else {
    // 断开所有房间
    for (const rid of [...rooms.keys()]) teardownRoom(rid, '已手动断开');
  }
  return { ok: true };
});

/**
 * IPC: danmu:forward-connect —— 连接指定房间的转发 WS
 *  - 创建/重用房间的 Forwarder 实例，连接到指定 URL
 *  - 连接即开始转发已勾选消息类型的消息，断开才停止
 */
ipcMain.handle('danmu:forward-connect', (_event, roomId: string, url: string) => {
  const room = rooms.get(roomId);
  if (!room) return { ok: false, msg: '房间未连接' };
  const u = String(url || '').trim();
  if (!u) return { ok: false, msg: '请填写 WS 地址' };
  // 创建转发器（若不存在）
  if (!room.forwarder) {
    room.forwarder = new Forwarder();
    room.forwarder.onStatus((state, msg) => {
      sendToRenderer('danmu:forward-status', { roomId, state, msg });
    });
  }
  // 连接即开始转发已勾选消息类型的消息（断开才停止）
  room.forwarder.setForwardingEnabled(true);
  room.forwarder.connect(u);
  // 持久化地址
  setRoomForward(roomId, u, true);
  return { ok: true };
});

/**
 * IPC: danmu:forward-disconnect —— 断开指定房间的转发 WS
 *  - 关闭 WS、清空队列、停止转发
 */
ipcMain.handle('danmu:forward-disconnect', (_event, roomId: string) => {
  const room = rooms.get(roomId);
  if (!room || !room.forwarder) return { ok: true };
  room.forwarder.disconnect();
  // 持久化：记录转发已关闭
  setRoomForward(roomId, getRoomForward(roomId).url, false);
  return { ok: true };
});



/**
 * IPC: danmu:forward-get —— 读取指定房间的转发配置
 *  - 返回持久化的 URL（WS 连接状态由 forward-status 推送）
 */
ipcMain.handle('danmu:forward-get', (_event, roomId: string) => {
  const cfg = getRoomForward(roomId);
  const room = rooms.get(roomId);
  const connected = !!(room?.forwarder && room.forwarder.isConnected());

  return { ok: true, url: cfg.url, connected };
});

/**
 * IPC: danmu:send —— 发送弹幕（登录后可用）
 *  - 走主进程串行队列（≥3s 冷却），页面注入方案，见 danmuSender.ts
 */
ipcMain.handle('danmu:send', async (_event, roomId: string, content: string) => {
  const deny = licenseDeny();
  if (deny) return deny;
  const rid = String(roomId || '').trim();
  if (!rid) return { ok: false, msg: '房间号无效' };
  return sendDanmu(rid, String(content ?? ''));
});

/**
 * IPC: danmu:schedule-add / update / remove / list —— 多条定时任务管理
 *  - 任务按 ID 管理，同一房间可并存多条；房间断开时该房间任务全部移除
 *  - 添加/编辑后到达第一个间隔时才发送（即时发送走 danmu:send）
 *  - 每次定时发送结果经 danmu:send-status 推送（带 taskId）
 */
ipcMain.handle('danmu:schedule-add', (_event, roomId: string, content: string, intervalSec: number) => {
  const deny = licenseDeny();
  if (deny) return deny;
  const r = addSchedule(String(roomId || '').trim(), String(content ?? ''), Number(intervalSec) || 0);
  sendToRenderer('danmu:schedule-changed', {});
  return r;
});

ipcMain.handle('danmu:schedule-update', (_event, taskId: string, content: string, intervalSec: number) => {
  const r = updateSchedule(String(taskId || '').trim(), String(content ?? ''), Number(intervalSec) || 0);
  sendToRenderer('danmu:schedule-changed', {});
  return r;
});

ipcMain.handle('danmu:schedule-remove', (_event, taskId: string) => {
  const r = removeSchedule(String(taskId || '').trim());
  sendToRenderer('danmu:schedule-changed', {});
  return r;
});

ipcMain.handle('danmu:schedule-list', () => {
  return { ok: true, tasks: listSchedules() };
});

/** IPC: license:get-status / license:activate —— 授权状态与激活 */
ipcMain.handle('license:get-status', () => getLicenseStatus());
ipcMain.handle('license:activate', (_event, key: string) => activateLicense(String(key || '')));

/** IPC: danmu:history-get —— 读取连接历史（输入框下拉数据源） */
ipcMain.handle('danmu:history-get', () => {
  return { ok: true, list: getRoomHistory() };
});

/** IPC: danmu:history-remove —— 删除单条历史记录 */
ipcMain.handle('danmu:history-remove', (_event, roomId: string) => {
  removeRoomHistoryEntry(String(roomId || '').trim());
  return { ok: true };
});

/** IPC: danmu:history-clear —— 清空连接历史 */
ipcMain.handle('danmu:history-clear', () => {
  clearRoomHistory();
  return { ok: true };
});

/**
 * IPC: danmu:set-filters —— 同步第二栏消息类型勾选状态（渲染进程勾选变化时调用）
 *  - 未勾选的消息类型：主进程不打印日志、不转发（显示仍由渲染层过滤）
 *  - 勾选状态只存内存，重启后由渲染层重新推送
 */
ipcMain.handle('danmu:set-filters', (_event, roomId: string, f: Record<string, boolean>) => {
  const room = rooms.get(roomId);
  if (room && f && typeof f === 'object') {
    room.msgFilters = f;
    CLog.info(`[main] 房间 ${roomId} 消息过滤已更新: ` + Object.entries(room.msgFilters).map(([k, v]) => `${k}=${v ? '✓' : '✗'}`).join(' '));
  }
  return { ok: true };
});

/**
 * IPC: danmu:login —— 打开抖音登录窗口
 *
 * 背景（2026-04 发现）：
 *   抖音已更新推送策略，礼物消息（WebcastGiftMessage）只下发给已登录的连接。
 *   未登录连接能收到弹幕/进场/点赞/关注，但收不到礼物。
 *   用户需在弹出的窗口中扫码/登录抖音账号，登录后 Cookie 持久化到签名桥分区，
 *   后续 WSS 握手携带登录态 Cookie 即可收到礼物消息。
 */
ipcMain.handle('danmu:login', () => {
  openLoginWindow(async () => {
    // 窗口关闭：检查登录状态并获取用户信息
    const { loggedIn } = await checkLoginStatus();
    let userInfo: LoggedInUserInfo | undefined;
    if (loggedIn) {
      const r = await getLoggedInUserInfo();
      userInfo = r?.info;
      // 仅接口明确判定"未登录"（20003）才清 Cookie；网络错误保留登录态防误伤
      if (r?.expired) {
        CLog.info('[main] 登录态已失效（接口判定未登录），自动清除');
        await clearLoginSession();
        mainWin?.webContents.send('danmu:login-status', { loggedIn: false });
        return;
      }
    }
    mainWin?.webContents.send('danmu:login-status', { loggedIn, userInfo });
  });
  return { ok: true };
});

/**
 * IPC: danmu:check-login —— 检查抖音登录状态
 *  - 通过检查签名桥持久化分区是否有 sessionid Cookie 判断
 *  - 渲染进程初始化时调用，连接时也调用（未登录时提示用户）
 */
ipcMain.handle('danmu:check-login', async () => {
  const { loggedIn } = await checkLoginStatus();
  let userInfo: LoggedInUserInfo | undefined;
  if (loggedIn) {
    const r = await getLoggedInUserInfo();
    userInfo = r?.info;
    // 仅接口明确判定"未登录"（status_code=20003）时才判定过期并清除；
    // 网络错误/接口异常时保留登录态（UI 仍显示已登录），防止误清刚登录的 Cookie
    if (r?.expired) {
      CLog.info('[main] 登录态已过期（接口判定未登录），自动清除');
      await clearLoginSession();
      return { ok: true, loggedIn: false };
    }
    if (!userInfo) {
      // 获取失败但不确定过期：保持登录态，UI 显示已登录（用户信息留空）
      CLog.warn('[main] 用户信息获取失败（网络原因？），保留登录态');
    }
  }
  return { ok: true, loggedIn, userInfo };
});

/**
 * IPC: danmu:logout —— 退出登录（清除登录态 Cookie）
 *  - 清除 sessionid 等登录 Cookie（保留 ttwid 等访客 Cookie）
 *  - 通知渲染进程更新 UI（按钮恢复为「登录抖音」）
 *  - 如已连接直播间，礼物消息将不再下发（需重新登录）
 */
ipcMain.handle('danmu:logout', async () => {
  await clearLoginSession();
  mainWin?.webContents.send('danmu:login-status', { loggedIn: false });
  CLog.info('[main] 用户已退出登录');
  return { ok: true };
});

// ---- 生命周期 ----
app.whenReady().then(async () => {
  // 定时任务发送结果 → 渲染进程（任务列表页展示每次发送的成功/失败）
  onScheduleResult((taskId, roomId, res, content) => {
    sendToRenderer('danmu:send-status', {
      taskId,
      roomId,
      state: res.ok ? 'sent' : 'send-failed',
      msg: res.msg,
      content,
      scheduled: true,
    });
  });

  // 发送时发现登录态失效（服务端判定过期）→ 通知渲染层恢复未登录 UI
  onLoginExpired(() => {
    mainWin?.webContents.send('danmu:login-status', { loggedIn: false });
  });

  // 授权：初始化 + 状态变化推送渲染层（顶部授权标识/弹窗刷新）
  initLicense();
  onLicenseStatusChanged((s) => {
    sendToRenderer('danmu:license-status', s);
  });

  // 用 Electron net.fetch 覆盖全局 fetch：自动携带 session Cookie（__ac_nonce 等）
  // 必须在任何网络请求（含自检/冒烟测试）之前设置
  globalThis.fetch = net.fetch as unknown as typeof fetch;

  // 运行时日志实时落盘：所有 CLog.* 输出除控制台外，同步追加到 log/app.log
  // （开发=项目根/log，打包=userData/log），双击 exe 也能查看实时运行日志
  CLog.setFileTarget(path.join(getLogDir(), 'app.log'));
  CLog.info('[main] DanmuDesk 启动, 日志文件: ' + path.join(getLogDir(), 'app.log'));

  // 自检模式：验证运行时能力后退出
  if (process.env.DANMU_TEST) {
    const results = {
      WebSocket: typeof WebSocket,
      wasm: typeof WebAssembly,
      fetch: typeof fetch,
      node: process.versions.node,
      electron: process.versions.electron,
    };
    CLog.info('[selftest] ' + JSON.stringify(results));
    CLog.flush(); // 立即退出前把日志缓冲落盘
    app.exit(0);
    return;
  }

  // 连接冒烟测试：DANMU_TEST_CONNECT=<roomId> 时不弹窗，直接连真实直播间
  // 打印关键日志并在 60s 后退出，用于验证「签名桥 → WSS → 解码」整条链路
  if (process.env.DANMU_TEST_CONNECT) {
    const rid = String(process.env.DANMU_TEST_CONNECT).trim();
    // 同步日志：避免 app.exit(0) 丢弃 stdout 缓冲（Windows 下 console.log 重定向会丢）
    // 统一写到 log/ 目录（开发=项目根/log，打包=userData/log），见 getLogDir()
    const LOG_FILE = path.join(getLogDir(), 'connect_flow.log');
    const slog = (s: string) => {
      const line = `[${new Date().toISOString().slice(11, 23)}] ${s}`;
      fs.appendFileSync(LOG_FILE, line + '\n');
      console.log(line);
    };
    fs.writeFileSync(LOG_FILE, '');
    slog(`roomId=${rid} node=${process.versions.node} electron=${process.versions.electron}`);
    try {
      if (process.env.DANMU_TEST_MOCK_SIGN) {
        // 注入 mock 签名器：跳过签名桥（签名不参与 protobuf 链路验证，用于无渲染进程环境的冒烟测试）
        const { setFrontierSigner } = await import('./core/signer');
        setFrontierSigner(() => ({ 'X-Bogus': 'DFSzswVVUvxANEDaF0cDkM1eNWFq0to3iAgj7kzr' }));
        slog('使用 MOCK 签名器（跳过签名桥）');
      } else {
        // 先等签名桥就绪（隐藏窗口加载抖音页面 + acrawler 注入，最多 45s）
        slog('等待签名桥就绪 ...');
        await ensureSignerReady(rid);
      }
      const t = new DyCast(rid);
      // 帧级调试：每帧/每条原始消息同步落盘
      const { setDebugSink } = await import('./core/dycast');
      setDebugSink((evt: any) => {
        if (evt.t === 'frame') {
          slog(`FRAME len=${evt.len} type=${evt.payloadType} msgs=${evt.msgCount} cursor=${evt.cursor}`);
        } else if (evt.t === 'raw') {
          slog(`RAW method=${evt.method}`);
        }
      });
      t.on('open', (_ev, info: any) => {
        slog(`OPEN 主播=${info?.nickname || '?'} 标题=${info?.title || '?'} 在线=${info?.audienceCount ?? '?'}`);
      });
      t.on('message', (msgs: DyMessage[]) => {
        for (const m of msgs.slice(0, 5)) {
          const kind = TYPE_MAP[m.method || ''] || m.method;
          slog(`MSG kind=${kind} user=${m.user?.name || '-'} content=${(m.content || m.gift?.name || '').toString().slice(0, 40)}`);
        }
      });
      t.on('close', (code: number, msg: string) => {
        slog(`CLOSE code=${code} msg=${String(msg).slice(0, 120)}`);
      });
      t.on('reconnecting', (n: number) => slog(`RECONNECT ${n}/3`));
      t.on('error', (err: any) => slog(`ERROR ${err?.message || err}`));
      await t.connect();
      slog('connect() resolved, 等待消息 60s ...');
    } catch (err: any) {
      slog('FAILED ' + (err?.message || err));
    }
    setTimeout(() => app.exit(0), 60000);
    return;
  }

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // 应用退出前：关闭所有弹幕连接（含每房间转发器）、停掉定时发送、销毁签名桥隐藏窗口
  teardownAllRooms();
  stopAllSchedules();
  disposeSigner();
  // 冲刷日志缓冲（logUtil 为性能做了批量落盘，退出前把未写完的日志刷进文件）
  CLog.flush();
});
