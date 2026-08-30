/**
 * ============================================================================
 * dycast.ts — 抖音直播弹幕核心（网络层）
 * ============================================================================
 *
 * 【职责】
 *   本模块实现从「输入房间号」到「渲染进程收到结构化弹幕消息」的完整链路：
 *
 *   ┌────────────┐   ┌──────────────┐   ┌──────────────────┐   ┌─────────────┐
 *   │ 房间号/链接 │ → │ fetchConnect │ → │ im/fetch 初次连接 │ → │ WSS 长连接   │
 *   │ (roomNum)  │   │ Info(解析    │   │ (拿 cursor /      │   │ (PushFrame  │
 *   │            │   │ roomId)      │   │  internalExt)     │   │  消息推送)   │
 *   └────────────┘   └──────────────┘   └──────────────────┘   └──────┬──────┘
 *                                                                     ▼
 *   ┌─────────────┐   ┌──────────────┐   ┌──────────────────────────────┐
 *   │ UI 渲染      │ ← │ main.ts 转发  │ ← │ 帧解码(PushFrame→Response)   │
 *   │ (danmu:* IPC)│   │ (DyMessage)  │   │ → 消息解码(Chat/Gift/Like…)  │
 *   └─────────────┘   └──────────────┘   └──────────────────────────────┘
 *
 * 【抖音弹幕协议要点】（均为踩坑后验证所得，改动前务必阅读）
 *   1. 消息分两层包装：
 *      - 传输层：WSS 收到的每帧是 PushFrame（headersList + payload）
 *        · payload 可能被 gzip 压缩（headers['compress_type'] === 'gzip'），需先解压
 *        · headers 中的 im-cursor / im-internal_ext 是消息游标，ACK 必须原样带回
 *      - 业务层：解压后的 payload 是 Response（messages[] + cursor + internalExt）
 *        · 每条 message 的 method 标识类型（WebcastChatMessage / GiftMessage ...）
 *        · message.payload 是再次 protobuf 编码的业务消息体，按 method 分发解码
 *   2. 心跳：客户端需周期性发送 payloadType=hb 的 PushFrame；若连续
 *      downgradePingCount 次心跳窗口内没收到任何服务器帧，判定接收异常并重连。
 *   3. ACK：收到 needAck 的帧后必须回发 payloadType=ack 的 PushFrame，
 *      payload 为 headers['im-internal_ext'] 的 UTF-8 字节，漏发会断流。
 *   4. 关键 ID：
 *      - room_id 必须用页面解析出的 19 位内部 roomId（而非用户输入的房间号），
 *        否则 WSS 握手成功但收不到任何消息（probe4 验证）。
 *      - user_unique_id 必须用 im/fetch 响应 internalExt 里的 wss_push_did，
 *        签名 stub 也用它，否则返回 DEVICE_BLOCKED（见 getWssParam）。
 *
 * 【重连策略】
 *   心跳超时 / 服务端关闭 / 网络抖动 → cannotReceiveMessage / handleClose
 *   → shouldReconnect=true → reconnect() 携带最新 cursor 重新建立 WSS，
 *   最多 maxReconnectCount(3) 次；重连成功用最新 cursor 续传，不漏消息。
 * ============================================================================
 */
import { CLog } from './logUtil';
import { Emitter, type EventMap } from './emitter';

/**
 * 帧级调试钩子（connect-test 用）
 *  - 每次收到 WSS 帧 / 解码出消息时同步回调，避免 console.log 缓冲丢失
 *  - 通过 setDebugSink(fn) 注入；生产环境保持 null 不产生任何开销
 */
export type DyDebugSink = (evt: { t: string; [k: string]: any }) => void;
let debugSink: DyDebugSink | null = null;
export function setDebugSink(fn: DyDebugSink | null): void {
  debugSink = fn;
}
import * as pako from 'pako';
import WebSocketClient from 'ws';
import { getSessionCookieString } from '../signBridge';
import {
  decodeChatMessage,
  decodeControlMessage,
  decodeEmojiChatMessage,
  decodeGiftMessage,
  decodeLikeMessage,
  decodeMemberMessage,
  decodePushFrame,
  decodeResponse,
  decodeRoomRankMessage,
  decodeRoomStatsMessage,
  decodeRoomUserSeqMessage,
  decodeSocialMessage,
  encodePushFrame
} from './model';
import type {
  GiftStruct,
  Message,
  RoomRankMessage_RoomRank,
  RoomUserSeqMessage_Contributor,
  Text,
  User
} from './model';
import { fetchLiveInfo, fetchUser, getCookieChain, getImInfo, getLiveInfo, seedCookieChain } from './request';
import { getSignature } from './signature';
// import { logUserCast } from '@/utils/debugUtil';

/**
 * 连接状态
 *  - 0 - 未连接
 *  - 1 - 连接中(连接完成)
 *  - 2 - 连接失败
 *  - 3 - 已断开
 */
export type ConnectStatus = 0 | 1 | 2 | 3;

/** 直播间信息 */
export interface LiveRoom {
  /**
   * 在线观众数
   */
  audienceCount?: number | string;
  /**
   * 本场点赞数（直播间累计总点赞，来自点赞消息的 total 字段）
   */
  likeCount?: number | string;
  /**
   * 本条点赞数（当前玩家本次连点的赞数，来自点赞消息的 count 字段）
   *  - 抖音点赞协议里 count 是「这一帧该用户点了几个赞」（通常为 1）
   *  - 与 likeCount（直播间总赞）区分：UI 需要同时展示玩家赞数 + 总赞数
   */
  likeCnt?: number | string;
  /**
   * 主播粉丝数
   */
  followCount?: number | string;
  /**
   * 累计观看人数
   */
  totalUserCount?: number | string;
  /** 房间状态 */
  status?: number;
}

/** 直播间信息-连接信息 */
export interface DyLiveInfo {
  roomNum?: string;
  roomId: string;
  uniqueId: string;
  avatar: string;
  cover: string;
  nickname: string;
  title: string;
  status: number;
  /** 是否成功从页面解析出直播间（false=页面解析失败，roomId 是用户输入号兜底，
   *  此时 WSS 即使 101 握手成功服务器也不会订阅消息，且签名页面加载该号会 404 无声） */
  resolved?: boolean;
  /** 主播粉丝数（尽力获取：页面内嵌 state 的 roomInfo 常为空，可能缺失） */
  followerCount?: number | string;
  /** 主播关注数（同上，可能缺失） */
  followingCount?: number | string;
  /** 本场直播总点赞数（来自页面 room 内嵌 like_count，可能缺失） */
  likeCount?: number | string;
  /** 主播数字 uid（页面 anchor.id_str，用于 user/profile 接口查询粉丝/关注数） */
  anchorId?: string;
  /** 主播 sec_uid（页面 anchor.sec_uid，同上） */
  anchorSecUid?: string;
}
/** 直播间信息-初次连接信息 */
export interface DyImInfo {
  cursor?: string;
  fetchInterval?: string;
  now?: string;
  internalExt?: string;
  fetchType?: number;
  pushServer?: string;
  liveCursor?: string;
}

/**
 * 送礼点赞榜
 */
export interface LiveRankItem {
  nickname: string;
  avatar: string;
  rank: number | string;
}

export interface CastUser {
  // user.sec_uid | user.id_str（加密用户 ID，展示用）
  id?: string;
  // user.display_id（抖音号，如 "dy123456"）
  displayId?: string;
  // user.nickname
  name?: string;
  // user.avatar_thumb.url_list.0（小头像 ~100px）
  avatar?: string;
  // user.avatar_medium.url_list.0（中头像 ~200px）
  avatarMedium?: string;
  // user.avatar_large.url_list.0（大头像 ~400px）
  avatarLarge?: string;
  // 性别 0 | 1 | 2 => 未知 | 男 | 女
  gender?: number;
  // user.signature（个性签名）
  signature?: string;
  // user.verified（是否官方认证）
  verified?: boolean;
  // user.follow_info.following_count（TA 关注了多少人）
  followingCount?: number | string;
  // user.follow_info.follower_count（TA 的粉丝数）
  followerCount?: number | string;
  // user.pay_grade.level（消费等级，抖音「财富等级」）
  payLevel?: number | string;
  // user.pay_grade.name（等级名称，如 "Lv.30"）
  payGradeName?: string;
  // user.fans_club.data.club_name（粉丝团名，即「灯牌」所属主播）
  fansClubName?: string;
  // user.fans_club.data.level（粉丝团等级，灯牌等级 1~20+）
  fansClubLevel?: number;
}

export interface CastGift {
  id?: string;
  name?: string;
  // 抖音币 diamond_count
  price?: number;
  type?: number;
  // 描述
  desc?: string;
  // 图片
  icon?: string;
  // 数量 repeat_count | combo_count
  count?: number | string;
  // 礼物消息可能重复发送，0 表示第一次，未重复
  repeatEnd?: number;
}

/**
 * 富文本类型
 *  1 - 普通文本
 *  2 - 合并表情
 */
export enum CastRtfContentType {
  TEXT = 1,
  EMOJI = 2,
  USER = 3
}

// 富文本
export interface CastRtfContent {
  type?: CastRtfContentType;
  text?: string;
  url?: string;
  user?: CastUser;
}

export interface DyMessage {
  id?: string;
  /** 消息自身时间（Common.createTime，秒级时间戳字符串；缺失时上层用本地时间兜底） */
  time?: string;
  method?: CastMethod;
  user?: CastUser;
  toUser?: CastUser;
  gift?: CastGift;
  content?: string;
  rtfContent?: CastRtfContent[];
  room?: LiveRoom;
  rank?: LiveRankItem[];
}

export enum CastMethod {
  CHAT = 'WebcastChatMessage',
  GIFT = 'WebcastGiftMessage',
  LIKE = 'WebcastLikeMessage',
  MEMBER = 'WebcastMemberMessage',
  SOCIAL = 'WebcastSocialMessage',
  ROOM_USER_SEQ = 'WebcastRoomUserSeqMessage',
  CONTROL = 'WebcastControlMessage',
  ROOM_RANK = 'WebcastRoomRankMessage',
  ROOM_STATS = 'WebcastRoomStatsMessage',
  EMOJI_CHAT = 'WebcastEmojiChatMessage',
  FANSCLUB = 'WebcastFansclubMessage',
  ROOM_DATA_SYNC = 'WebcastRoomDataSyncMessage',
  /** 自定义消息 */
  CUSTOM = 'CustomMessage'
}

/**
 * 直播间直播状态
 */
export enum RoomStatus {
  PREPARE = 1,
  LIVING = 2,
  PAUSE = 3,
  END = 4
}
/** 客户端状态 */
enum WSRoomStatus {
  /** 未连接 */
  UNCONNECTED = 1,
  /** 正在连接 */
  CONNECTING = 2,
  /** 连接中|已连接 */
  CONNECTED = 3,
  /** 重连中 */
  RECONNECTING = 4,
  /** 已关闭 */
  CLOSED = 5
}

/**
 * DyCast Event
 */
interface DyCastEvent extends EventMap {
  /**
   * 监听ws打开
   * @param ev
   * @returns
   */
  open: (ev?: Event, info?: DyLiveInfo) => void;
  /**
   * 监听关闭
   * @param code
   * @param reason
   * @returns
   */
  close: (code: number, reason: string) => void;
  /**
   * 监听错误
   * @param e
   * @returns
   */
  error: (e: Error) => void;
  /**
   * 监听弹幕
   * @param messages
   * @returns
   */
  message: (messages: DyMessage[]) => void;
  /** 重连中 */
  reconnecting: (count?: number, code?: DyCastCloseCode, reason?: string) => void;
  /** 重连完成 */
  reconnect: (ev?: Event) => void;
}

/**
 * 自定义关闭码
 */
export enum DyCastCloseCode {
  /** 正常关闭 */
  NORMAL = 1000,
  /** 终端离开，可能因为服务端错误，也可能因为浏览器正从打开连接的页面跳转离开 */
  GOING_AWAY = 1001,
  /** 由于协议错误而中断连接 */
  PROTOCOL_ERROR = 1002,
  /** 接收到不允许的数据类型而断开连接 */
  UNSUPPORTED = 1003,
  /** 没有收到预期的状态码 */
  NO_STATUS = 1005,
  /** 没有处理关闭帧 */
  ABNORMAL = 1006,
  /** 应用自定义状态码 */
  /** 主播未开播 */
  LIVE_END = 4001,
  /** 连接过程错误 */
  CONNECTING_ERROR = 4002,
  /** 无法正常接收信息 */
  CANNOT_RECEIVE = 4003,
  /** 因重连关闭 */
  RECONNECTING = 4004
}

// 配置
interface DyCastOptions {
  aid?: string;
  app_name?: string;
  browser_language?: string;
  browser_name?: string;
  browser_online?: boolean;
  browser_platform?: string;
  browser_version?: string;
  compress?: string;
  cookie_enabled?: boolean;
  cursor: string;
  device_platform?: string;
  did_rule?: number;
  endpoint?: string;
  heartbeatDuration?: string;
  host?: string;
  identity?: string;
  im_path?: string;
  insert_task_id?: string;
  internal_ext: string;
  live_id?: number;
  live_reason?: string;
  need_persist_msg_count?: string;
  room_id: string;
  screen_height?: number;
  screen_width?: number;
  signature: string;
  support_wrds?: number;
  tz_name?: string;
  update_version_code?: string;
  user_unique_id: string;
  version_code?: string;
  webcast_sdk_version?: string;
}

interface DyCastCursor {
  cursor?: string;
  firstCursor?: string;
  internalExt?: string;
}

/**
 * dycast 自定义关闭信息
 */
interface DyCastCloseEvent {
  code: number;
  msg: string;
}

/**
 * PushFrame 的 payload_type（帧类型，决定客户端如何处理该帧）
 *  - hb   ：心跳帧。客户端主动发给服务器，服务器不回应；用于保活连接
 *  - ack  ：确认帧。客户端收到 needAck 的消息帧后回发，携带 im-internal_ext，
 *           告知服务器「这条游标之前的消息已收到」，漏发会导致消息重推或断流
 *  - msg  ：消息帧。服务器推送的业务消息（Response 封装），需解码后分发
 *  - close：关闭帧。服务器告知本次连接即将关闭，客户端应主动走关闭流程
 */
enum PayloadType {
  Ack = 'ack',
  Close = 'close',
  Hb = 'hb',
  Msg = 'msg'
}

/** API */
// 抖音官方 WSS 推送地址（域名会因负载而变，实际以 im/fetch 响应的 push_server 为准）：
// wss://webcast5-ws-web-lf.douyin.com/webcast/im/push/v2/  => version: 1.0.14-beta.0
// wss://webcast100-ws-web-lq.douyin.com/webcast/im/push/v2/  => version: 1.0.15
// 桌面版：固定使用抖音官方域名（浏览器版经由 Vite proxy 同源转发，此处直连）
// 注意：BASE_URL 仅作兜底，正常情况下 _getSocketUrl 会优先用 im/fetch 返回的 pushServer
const BASE_URL = `wss://live.douyin.com/socket/webcast/im/push/v2/`;

/** UA：与签名桥隐藏窗口一致的桌面 Chrome UA，降低风控识别概率 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

/** SDK 版本：与 im/fetch 的 version_code / update_version_code 呼应 */
export const VERSION = '1.0.15';

/**
 * 默认配置（WSS 握手 URL 的 query 参数）
 *  - 这些参数与 im/fetch 的参数同源，部分字段（cursor / internal_ext / signature /
 *    user_unique_id）在 getWssParam() 时被动态覆盖，其余用默认值
 *  - aid=6383 / app_name=douyin_web / device_platform=web / identity=audience
 *    表示「抖音 Web 观众端」，改动会导致服务器返回未知协议错误
 *  - did_rule=3、support_wrds=1 为 Web 端固定取值
 */
const defaultOpts: Partial<DyCastOptions> = {
  aid: '6383',
  app_name: 'douyin_web',
  browser_language: 'zh-CN',
  browser_name: 'Mozilla',
  browser_online: true,
  browser_platform: 'Win32',
  browser_version:
    '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  compress: 'gzip', // payload 压缩方式：服务器据此决定是否 gzip 压缩消息体
  cookie_enabled: true,
  device_platform: 'web',
  did_rule: 3,
  endpoint: 'live_pc', // 直播 Web 端标识
  heartbeatDuration: '0', // 0 = 使用客户端默认 10s 心跳
  host: 'https://live.douyin.com',
  identity: 'audience', // 观众身份
  im_path: '/webcast/im/fetch/',
  insert_task_id: '',
  live_id: 1,
  live_reason: '',
  need_persist_msg_count: '15', // 断线重连时向服务器请求补发的历史消息条数
  screen_height: 1080,
  screen_width: 1920,
  support_wrds: 1,
  tz_name: 'Asia/Shanghai',
  update_version_code: VERSION,
  version_code: '180800', // 抖音 Web 客户端版本号（与 UA Chrome/134 匹配）
  webcast_sdk_version: VERSION
};

export class DyCast {
  /** 房间号 */
  private roomNum: string;

  /** 房间信息 */
  private info: DyLiveInfo;

  // 初次连接信息
  private imInfo: DyImInfo;

  /** WS客户端（ws 库，可携带 Cookie header） */
  private ws: any | undefined;

  /** 连接 url */
  private url: string | undefined;

  // 连接状态
  private state: boolean;

  /** 客户端状态 */
  private wsRoomStatus: WSRoomStatus;

  /** 直播间直播状态 */
  private status: RoomStatus;

  /** 连接配置 */
  private options: DyCastOptions | undefined;

  // 心跳
  // 主要用于检查消息接收是否正常
  private heartbeatDuration: number = 10000;
  // 心跳次数
  private pingCount: number = 0;
  // 心跳阈值
  // 如果 heartbeatDuration ms 内心跳次数大于等于该值，证明消息接收出错
  // 即 如果 10000 ms 内都没接收到新消息，证明消息接收出错
  private downgradePingCount: number = 2;

  private pingTimer: number | undefined = void 0;

  // 上次接收时间
  private lastReceiveTime: number;

  private cursor: DyCastCursor;

  /**
   * 自定义实现的 错误信息提示
   *  - 由于 dycast 的服务端并不会正确处理关闭帧
   *  - 调用 websocket close 后，关闭监听返回 1006
   */
  private closeEvent: DyCastCloseEvent;

  /** 当前重连次数 */
  private reconnectCount: number;
  /** 最大重连尝试次数 */
  private maxReconnectCount: number;
  // 是否需要重连
  private shouldReconnect: boolean;
  // 正在重连中
  private isReconnecting: boolean;

  /** 重连退避定时器：重连间隔 1s×n（上限 4s），避免网络抖动/风控时连环重试加剧风险 */
  private reconnectTimer: NodeJS.Timeout | undefined = void 0;
  /** 重连代数：close() 主动取消后使在途的延迟重连失效 */
  private reconnectGen: number = 0;
  /** 主动关闭标记：close() 置位（重连自关闭 RECONNECTING 除外），取消在途的延迟重连 */
  private aborted: boolean = false;

  // 订阅者
  private emitter: Emitter<DyCastEvent>;

  constructor(roomNum: string) {
    // 初始化
    this.roomNum = roomNum;
    this.state = !1;
    // 10秒心跳
    this.heartbeatDuration = 10000;
    this.pingCount = 0;
    this.downgradePingCount = 2;
    this.cursor = {
      cursor: '',
      firstCursor: '',
      internalExt: ''
    };
    // 当前重连次数
    this.reconnectCount = 0;
    // 最大重连次数
    this.maxReconnectCount = 3;
    // 上一次接收消息时间
    this.lastReceiveTime = Date.now();
    // 当前客户端状态
    this.wsRoomStatus = WSRoomStatus.UNCONNECTED;
    this.shouldReconnect = !1;
    /**
     * 默认情况
     *  - 即未收到预期的状态码
     */
    this.closeEvent = { code: 1005, msg: 'CLOSE_NO_STATUS' };
    this.info = {
      roomId: '',
      uniqueId: '',
      avatar: '',
      cover: '',
      nickname: '',
      title: '',
      status: 4
    };
    this.imInfo = {};
    this.status = RoomStatus.END;
    this.emitter = new Emitter<DyCastEvent>();
    this.isReconnecting = false;
  }

  /**
   * 监听
   * @param event
   * @param listener
   */
  public on<K extends keyof DyCastEvent>(event: K, listener: DyCastEvent[K]) {
    this.emitter.on(event, listener);
  }

  /**
   * 取消监听
   * @param event
   * @param listener
   */
  public off<K extends keyof DyCastEvent>(event: K, listener: DyCastEvent[K]) {
    this.emitter.off(event, listener);
  }

  /**
   * 一次性监听
   *  - 如监听打开关闭
   * @param event
   * @param listener
   */
  public once<K extends keyof DyCastEvent>(event: K, listener: DyCastEvent[K]) {
    this.emitter.once(event, listener);
  }

  /**
   * 连接（对外主入口，幂等保护：已连接时再次调用会报错）
   *
   * 流程：
   *   1. fetchConnectInfo(roomNum)：解析房间页拿到 19 位内部 roomId + 主播信息，
   *      并调用 im/fetch 获取首次连接所需 cursor / internalExt / pushServer
   *   2. getWssParam()：从 internalExt 提取 wss_push_did，调用签名器生成 signature
   *   3. 主播在播（status === LIVING）→ _connect() 建立 WSS；否则发 close 事件
   *
   * 注意：本方法只负责「发起」，WSS 的 open/close/message 全部走事件回调，
   * 因此 resolve 时并不代表已连上，业务层应监听 open 事件确认连接成功。
   */
  public async connect() {
    try {
      if (this.state) {
        // state 为 true 表示 WSS 已打开（见 _afterOpen），重复连接无意义
        this.emitter.emit('error', Error('已连接，请勿重复连接'));
        return;
      }
      // 1) 解析房间信息 + im/fetch 拿初次连接参数（含 roomId / cursor / internalExt / pushServer）
      await this.fetchConnectInfo(this.roomNum);
      // 2) 组装 WSS URL 所需参数：room_id / user_unique_id / cursor / internal_ext / signature
      const params = await this.getWssParam();
      if (this.isLiving()) {
        // 主播在播：进入「连接中」状态并发起 WSS 握手
        this.wsRoomStatus = WSRoomStatus.CONNECTING;
        this._connect(params);
      } else {
        // 主播未开播（准备中/离开/已下播）：不发 WSS，直接通知上层
        const liveStatus = this.getLiveStatus();
        this.wsRoomStatus = WSRoomStatus.CLOSED;
        this.emitter.emit('close', DyCastCloseCode.LIVE_END, liveStatus.msg);
      }
    } catch (err) {
      // 过程错误（页面解析失败 / im/fetch 失败 / 签名失败等）
      CLog.error('房间连接前错误 =>', err);
      // 关闭
      this.emitter.emit('close', DyCastCloseCode.CONNECTING_ERROR, '房间连接前出错');
      this._afterClose();
      // 报错
      this.emitter.emit('error', err as Error);
    }
  }

  /**
   * 获取当前连接状态
   */
  public getRoomStatus() {
    return this.wsRoomStatus;
  }

  /**
   * 实际建立 WSS 连接（初次连接与重连共用此方法）
   *
   * 关键点：
   *   - 必须用 ws 库（而非 Electron 原生 WebSocket）：主进程原生 WebSocket
   *     无法自定义握手 Cookie，而 WSS 握手必须携带签名窗口会话的 Cookie，
   *     否则握手阶段就会被拒绝（或虽握手成功但收不到消息）
   *   - 握手 header 需带：Cookie（签名窗口会话）、Origin=https://live.douyin.com、UA
   *   - 所有 ws 事件（open/close/error/message）都转发给本类统一的处理函数，
   *     保证初次连接与重连走同一套状态机
   *
   * @param opts 完整连接参数（含 room_id / signature / cursor 等，见 getWssParam）
   */
  private async _connect(opts: DyCastOptions) {
    // 连接前的初始化：保存参数、拼出 WSS URL、记录起始 cursor
    this.options = opts;
    this.url = this._getSocketUrl(opts);
    this.cursor = {
      cursor: '',
      firstCursor: opts.cursor, // 首个游标：用于断线重连时告诉服务器从哪续传
      internalExt: opts.internal_ext
    };
    this.lastReceiveTime = Date.now();
    this.pingCount = 0;
    try {
      // 主进程原生 WebSocket 无法自定义握手 Cookie（WSS 必需），故用 ws 库
      const cookie = await getSessionCookieString();
      CLog.info(`[dycast] WSS url len=${this.url.length} cookieLen=${cookie.length} sig=${opts.signature} did=${opts.user_unique_id}`);
      const ws = new WebSocketClient(this.url, {
        headers: {
          Cookie: cookie,
          Origin: 'https://live.douyin.com',
          'User-Agent': UA
        },
        perMessageDeflate: false, // 关闭扩展压缩：抖音服务端按 payload 的 compress_type 单独压缩
        handshakeTimeout: 15000
      });
      this.ws = ws;
      ws.on('open', (ev: Event) => {
        // 可能初次打开，也可能是重连打开（通过 reconnectCount 区分）
        if (this.reconnectCount > 0) {
          // 重连成功：清零次数，通知上层「reconnect」事件
          this.reconnectCount = 0;
          this.emitter.emit('reconnect', ev);
        } else {
          // 初次连接：携带直播间信息通知上层「open」
          this.emitter.emit('open', ev, this.info);
        }
        this.ping(); // 打开后立即启动心跳定时器（周期 10s）
        this._afterOpen();
      });
      ws.on('close', (code: number, reasonBuf: Buffer) => {
        this.handleClose({ code, reason: reasonBuf ? reasonBuf.toString() : '' } as CloseEvent);
      });
      ws.on('error', (err: Error) => {
        this.emitter.emit('error', err);
      });
      // 握手被拒（HTTP 响应而非 101）：打印 handshake-msg 便于排查风控（如 DEVICE_BLOCKED）
      ws.on('unexpected-response', (_req: any, res: any) => {
        const h = (res && res.headers) || {};
        CLog.warn(`[dycast] WSS 握手被拒: status=${res && res.statusCode} handshake-msg=${JSON.stringify(h['handshake-msg'])}`);
        CLog.warn(`[dycast] WSS 拒绝响应头: ${JSON.stringify(h).slice(0, 400)}`);
      });
      ws.on('message', (data: Buffer) => {
        this.handleMessage(data);
      });
    } catch (err) {
      CLog.error('房间连接过程错误 =>', err);
      // 可能原因为 WebSocket 不可用
      // 关闭
      this.emitter.emit('close', DyCastCloseCode.CONNECTING_ERROR, '房间连接过程出错');
      this._afterClose();
      // 报错
      this.emitter.emit('error', err as Error);
    }
  }

  /**
   * 处理 ws 的 close 事件（含服务端主动关闭/网络断开）
   *
   * 关闭码映射：抖音服务端不会正确处理关闭帧，ws.close() 后回调通常返回
   * 1006(ABNORMAL) 或无状态 1005(NO_STATUS) —— 此时用 close() 时记录的
   * closeEvent（自定义码，如 CANNOT_RECEIVE）替换，上层才能知道真实原因。
   *
   * 后续走向：
   *   - shouldReconnect 或已有重连计数 → 走 reconnect() 自动续连
   *   - 否则 → 触发 'close' 事件交给上层（如 UI 显示已断开）
   */
  private handleClose(ev: CloseEvent) {
    let { code, reason } = ev;
    let msg: string = reason.toString();
    switch (code) {
      case DyCastCloseCode.NO_STATUS:
      case DyCastCloseCode.ABNORMAL:
        // 服务端未返回有效关闭码：用自定义 closeEvent 替换
        code = this.closeEvent.code || code;
        msg = this.closeEvent.msg || msg || 'closed';
        break;
    }
    this._afterClose();
    if (this.shouldReconnect || this.reconnectCount > 0) {
      // 需要重连
      this.reconnect();
    } else {
      // 正常关闭
      this.emitter.emit('close', code, msg);
    }
  }

  /**
   * 处理收到的每一帧 WSS 二进制消息（帧级入口，Async 但实际同步解码）
   *
   * 帧处理顺序（重要）：
   *   1. 清零心跳计数并刷新 lastReceiveTime —— 任何帧（含空帧/ack 帧）都算「连接正常」
   *   2. _decodeFrame() 解码 PushFrame → Response（自动处理 gzip 解压、提取 cursor）
   *   3. 若该帧 needAck：回发 ack 帧（携带 im-internal_ext），并推进本地 cursor
   *   4. 按帧的 payloadType 分发：
   *      - msg   → _dealMessages() 逐条解码业务消息后通过 'message' 事件抛出
   *      - close → 服务端要求关闭，走正常关闭流程
   *
   * @param data 服务端推送的原始二进制帧（PushFrame 编码）
   */
  private async handleMessage(data: Uint8Array | ArrayBuffer) {
    this.pingCount = 0;
    this.lastReceiveTime = Date.now();
    const rawLen = typeof data === 'string' ? data.length : (data as any).byteLength || (data as any).length;
    let res;
    try {
      res = await this._decodeFrame(new Uint8Array(data));
    } catch (err) {
      res = null;
    }
    if (!res) return;
    const { response, frame, cursor, needAck, internalExt } = res;
    // 帧级调试钩子：connect-test 模式借此把每一帧同步落盘
    debugSink?.({
      t: 'frame',
      len: rawLen,
      payloadType: frame?.payloadType,
      method: frame?.method,
      msgCount: response?.messages?.length ?? 0,
      cursor: String(cursor || '').slice(0, 40)
    });
    if (needAck) {
      // 发送 ack：payload 为 internalExt 的 UTF-8 字节，服务器据此确认消息已消费
      const ack = this._ack(internalExt, frame?.logId);
      this.setCursor(cursor, internalExt);
      if (this.ws && this.ws.readyState === 1) {
        this.ws.send(ack);
      } else {
        // 连接已断开却仍收到需 ack 的帧：说明链路异常，直接走关闭清理
        CLog.error(`ACK发送异常 => 直播间[${this.roomNum}]已关闭`);
        this._afterClose();
        // this.reconnect();
      }
    }
    // 处理消息体
    if (frame) {
      // 判断消息体类型
      if (frame.payloadType === PayloadType.Msg) {
        this._dealMessages(response.messages);
      }
      if (frame.payloadType === PayloadType.Close) {
        // 关闭连接
        this.close(DyCastCloseCode.NORMAL, 'Close By PayloadType');
      }
    }
  }

  /**
   * 重连（仅由 handleClose 在 shouldReconnect 或已有重连计数时调用）
   *
   * 关键：重连时把最新 cursor / internalExt 塞回连接参数 —— 服务器据此
   * 从断点继续推送，保证重连后不丢消息（配合 need_persist_msg_count 补发）。
   * 超过 maxReconnectCount(3) 次则放弃：除 error 外补发 close 事件（1006），
   * 上层（main）才能收尾并按自己的策略做带退避的整链路重连。
   */
  private reconnect() {
    // 还未关闭
    if (this.ws && this.ws.readyState === 1) {
      this.close(DyCastCloseCode.RECONNECTING, '因重连而关闭');
    }
    this.shouldReconnect = !1;
    // 重连参数用最新游标续传（cursor 为空说明还没 ack 过任何帧，回退到首个游标）。
    // 注意： handleClose 会先调 _afterClose，cursor 必须在 _afterClose 里保留
    this.reconnectCount++;
    if (this.reconnectCount > this.maxReconnectCount) {
      CLog.error('已超过最大重连次数，交给上层处理');
      this.emitter.emit('error', Error('连接不稳定，已超过最大重连次数'));
      // 只发 error 不发 close 的历史 bug：上层等不到关闭事件，房间永远卡在
      // 「已连接」但实际已死。补发 1006（服务端异常关闭）让上层自动重连/收尾。
      this.emitter.emit('close', DyCastCloseCode.ABNORMAL, '重连多次失败');
      return;
    }
    this.wsRoomStatus = WSRoomStatus.RECONNECTING;
    this.emitter.emit('reconnecting', this.reconnectCount);
    this.isReconnecting = true;
    // 退避重连：1s×n（上限 4s）。此前是失败后立刻重试，网络抖动/风控场景下
    // 3 次重连在 1~2s 内全部烧完，且高频握手可能加重风控
    const opts: DyCastOptions = Object.assign({}, this.options, {
      cursor: this.cursor.cursor || this.cursor.firstCursor || '',
      internal_ext: this.cursor.internalExt
    });
    this.aborted = false;
    const myGen = ++this.reconnectGen;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (this.aborted || myGen !== this.reconnectGen) return;
      this.reconnectTimer = void 0;
      this._connect(opts);
    }, Math.min(4000, 1000 * this.reconnectCount));
  }

  /**
   * 关闭连接（对外接口，也供内部各异常分支调用）
   *  - 设置 closeEvent 记录自定义关闭码：dycast 的服务端并不正确处理关闭帧，
   *    ws.close() 后回调返回的 code 通常是 1006（ABNORMAL），handleClose 会用
   *    closeEvent 里的自定义码替换，上层才能拿到真实原因
   * @param code 期望上层看到的关闭码（默认 1005 NO_STATUS）
   * @param reason 关闭原因描述
   */
  public close(code: number = 1005, reason: string = 'close') {
    // 主动关闭：取消在途的延迟重连（重连流程自关闭 RECONNECTING 除外，它随后
    // 会重新调度；上层 main 的 teardown 调 close() 时传的是业务码，会真正取消）
    if (code !== DyCastCloseCode.RECONNECTING) this.aborted = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = void 0;
    }
    if (this.ws) {
      this.state = !1;
      this.closeEvent = { code, msg: reason };
      // 无需传 code，因为抖音弹幕ws服务端并不会处理关闭帧
      this.ws.close();
      this.ws = void 0;
    }
  }

  /**
   * 连接关闭后的统一清理（_afterClose）
   *  - 停止心跳定时器、状态复位为 CLOSED
   *  - 注意：不清空 cursor —— handleClose 的重连路径先走这里再走 reconnect()，
   *    重连要用最新游标续传（历史 bug：在此清空导致每次重连都从头拉流）
   *  - 不负责触发 'close' 事件，由各调用方按场景决定是发事件还是重连
   */
  private _afterClose() {
    this.state = !1;
    if (this.pingTimer) {
      clearTimeout(this.pingTimer);
      this.pingTimer = void 0;
    }
    this.wsRoomStatus = WSRoomStatus.CLOSED;
    this.closeEvent = { code: DyCastCloseCode.NO_STATUS, msg: 'CLOSE_NO_STATUS' };
    this.ws = void 0;
    this.isReconnecting = false;
  }

  /** 连接打开后的统一收尾：标记已连接、复位重连计数 */
  private _afterOpen() {
    this.state = !0;
    this.wsRoomStatus = WSRoomStatus.CONNECTED;
    this.isReconnecting = false;
    this.aborted = false;
    this.reconnectCount = 0;
  }

  /**
   * 获取完整的 wss 地址
   *  - 域名必须以 im/fetch 响应中的 push_server 为准（webcast5-ws-web-lf / webcast100-ws-web-lq 等）
   *  - BASE_URL 仅作兜底
   * @param opts
   * @returns
   */
  private _getSocketUrl(opts: DyCastOptions) {
    const fullOpt = Object.assign({}, defaultOpts, opts);
    const base = (this.imInfo.pushServer || BASE_URL).replace(/\/$/, '');
    return `${base}/?${this._mergeOptions(fullOpt)}`;
  }

  /**
   * 将配置转换为 url 参数字符串
   *  - 如：item1=value1&item2=value2&...
   *  - 注意：与 util.makeUrlParams 不同，这里不做 encodeURIComponent ——
   *    signature / internal_ext 是签名后的原文，直接拼接（抖音服务端接受原文）
   * @param opts
   * @returns
   */
  private _mergeOptions(opts: any): string {
    return Object.keys(opts).reduce((t, n) => {
      let r;
      return `${t}${t ? '&' : ''}${n}=${null != (r = opts[n]) ? r : ''}`;
    }, '');
  }

  /**
   * 发送心跳帧（并调度下一次心跳）
   *
   * 心跳机制设计：
   *   - 每 heartbeatDuration(10s) 发送一次 hb 帧，同时 pingCount++
   *   - 任何收到的帧（handleMessage 开头）都会把 pingCount 清零 —— 因此
   *     pingCount 实质上统计的是「连续几个心跳周期都没收到服务器任何帧」
   *   - 若 pingCount >= downgradePingCount(2)：判定消息接收异常，触发重连
   *     （即：约 10s 的窗口内服务器没推任何东西，说明链路已死）
   */
  private ping() {
    try {
      let dur = Math.max(10000, Number(this.heartbeatDuration));
      if (this.ws && this.ws.readyState === 1) {
        // 连接正常
        // 发送心跳 => hb
        this.ws.send(this._ping());
        this.pingCount++;
        if (this.pingCount >= this.downgradePingCount) {
          return this.cannotReceiveMessage();
        }
      }
      // 心跳：大概每 10 秒发送一次（通过 setTimeout 自调度形成周期）
      this.pingTimer = setTimeout(() => {
        this.state && this.ping();
      }, dur);
    } catch (err) {
      // 发送过程出错
      CLog.error('DyCast Ping Error =>', err);
    }
  }

  /**
   * 无法正常接收消息（心跳超时触发）
   *  - 先关闭当前连接，再根据剩余重连次数决定是否自动重连
   *  - 重连时会携带最新 cursor（见 reconnect），服务器据此补发断档消息
   */
  private cannotReceiveMessage() {
    // 先关闭
    this.close(DyCastCloseCode.CANNOT_RECEIVE, '客户端无法正常接收信息');
    let tmp = Date.now() - this.lastReceiveTime;
    CLog.error(`DyCast Cannot Receive Message => after ${tmp} ms`);
    // 重连：未超过最大次数才置 shouldReconnect（真正触发在 handleClose 里）
    this.emitter.emit('reconnecting', this.reconnectCount, DyCastCloseCode.CANNOT_RECEIVE, '客户端无法正常接收信息');
    this.reconnectCount < this.maxReconnectCount && (this.shouldReconnect = !0);
  }

  /**
   * 设置消息游标（每收到 needAck 帧后更新）
   *  - cursor      ：最新游标，ACK 与重连续传都用它
   *  - internalExt ：同步记录，重连时回传给服务器
   *  - firstCursor ：首个游标（首次连接时记录），后续重连若 cursor 异常可回退
   * @param cur 新游标（帧头 im-cursor 或 Response.cursor）
   * @param ext 新 internalExt（帧头 im-internal_ext 或 Response.internalExt）
   */
  private setCursor(cur: string, ext: string) {
    this.cursor.cursor = cur;
    this.cursor.internalExt = ext;
    if (!this.cursor.firstCursor) {
      this.cursor.firstCursor = cur;
    }
  }

  /**
   * 处理一次接收的消息集（同一帧内可能打包多条消息）
   *  - 逐条解码，忽略解码失败的（如未知 method / 结构异常）
   *  - 全部解码完后统一通过 'message' 事件抛出，便于上层批量渲染/合并连击
   * @param msgs Response.messages（原始 Message 列表）
   */
  private async _dealMessages(msgs?: Message[]) {
    if (!msgs || msgs.length < 1) return;
    const messages: DyMessage[] = [];
    try {
      for (const msg of msgs) {
        const message = await this._dealMessage(msg);
        debugSink?.({ t: 'raw', method: msg.method, msgId: msg.msgId });
        if (message) messages.push(message);
      }
    } catch (err) {}
    if (!messages.length) return;
    this.emitter.emit('message', messages);
  }

  /**
   * 解码单条业务消息（按 method 分发到对应的 protobuf 解码器）
   *
   * 每种消息的解码结果统一收敛为 DyMessage（UI 层只认这一种结构）：
   *   - CHAT        弹幕：user + content（纯文本）+ rtfContent（富文本，含表情/@）
   *   - GIFT        礼物：user + toUser + gift（名称/价格/数量/连击状态）
   *   - LIKE        点赞：user + content（"为主播点赞了(N)"）+ 房间总赞数
   *   - MEMBER      进场：user + content（"进入直播间"）+ 当前在线人数
   *   - SOCIAL      关注：user + content（"关注了主播"）+ 主播粉丝数
   *   - EMOJI_CHAT  会员表情：user + content（表情图 URL）
   *   - ROOM_USER_SEQ 观众席：rank（送礼榜）+ 在线人数/累计观看
   *   - CONTROL     控制消息：content（描述）+ 房间状态（开播/下播等）
   *   - ROOM_RANK   小时榜：rank（榜单列表）
   *   - ROOM_STATS  房间统计：在线人数
   * @param msg 原始 Message（method + payload）
   */
  private async _dealMessage(msg: Message) {
    const method = msg.method;
    const data: DyMessage | null = {};
    data.id = msg.msgId;
    let message = null;
    let payload = msg.payload;
    if (!payload) return null;
    try {
      // 处理消息
      switch (method) {
        case CastMethod.CHAT:
          // 普通弹幕：content 为纯文本，rtfContent 为富文本片段（文本/表情/@人）
          message = decodeChatMessage(payload);
          data.method = CastMethod.CHAT;
          data.user = this._getCastUser(message.user);
          data.content = message.content;
          // 获取富文本：包含合并表情
          data.rtfContent = this._getCastRtfContent(message.rtfContentV2);
          break;
        case CastMethod.GIFT:
          // 礼物：repeatCount/comboCount 为连击数，repeatEnd=0 表示连击开始
          message = decodeGiftMessage(payload);
          data.method = CastMethod.GIFT;
          data.user = this._getCastUser(message.user);
          data.toUser = this._getCastUser(message.toUser);
          data.gift = this._getCastGift(message.gift, message.repeatCount || message.comboCount, message.repeatEnd);
          break;
        case CastMethod.LIKE:
          // 点赞：count 为当前玩家本次点赞数，total 为直播间累计总点赞数
          // 两者都放进 room：UI 据此同时显示「玩家点赞数 + 直播间总赞数」
          message = decodeLikeMessage(payload);
          data.method = CastMethod.LIKE;
          data.user = this._getCastUser(message.user);
          data.content = `为主播点赞了(${message.count})`;
          data.room = { likeCount: message.total, likeCnt: message.count };
          break;
        case CastMethod.MEMBER:
          // 进场：memberCount 为当前在线人数
          message = decodeMemberMessage(payload);
          data.method = CastMethod.MEMBER;
          data.user = this._getCastUser(message.user);
          data.content = '进入直播间';
          data.room = { audienceCount: message.memberCount };
          break;
        case CastMethod.SOCIAL:
          // 关注：followCount 为主播粉丝数
          message = decodeSocialMessage(payload);
          data.method = CastMethod.SOCIAL;
          data.user = this._getCastUser(message.user);
          data.content = '关注了主播';
          data.room = { followCount: message.followCount };
          break;
        case CastMethod.EMOJI_CHAT:
          // 会员专属表情弹幕：emojiContent 里是表情图片
          message = decodeEmojiChatMessage(payload);
          data.method = CastMethod.EMOJI_CHAT;
          data.user = this._getCastUser(message.user);
          data.content = this._getCastEmoji(message.emojiContent);
          break;
        case CastMethod.ROOM_USER_SEQ:
          // 观众席/在线榜：ranks 为送礼榜前 N，total 为在线人数，totalUser 为累计观看
          message = decodeRoomUserSeqMessage(payload);
          data.method = CastMethod.ROOM_USER_SEQ;
          data.rank = this._getCastRanksA(message.ranks);
          data.room = { audienceCount: message.total, totalUserCount: message.totalUser };
          break;
        case CastMethod.CONTROL:
          // 控制消息：如主播开播/下播/封禁等，action 为数字状态码
          // 与 RoomStatus 对齐：1=准备中 2=直播中 3=暂停/离开 4=已下播
          message = decodeControlMessage(payload);
          data.method = CastMethod.CONTROL;
          data.content = message.common?.describe;
          {
            const act = parseInt(message.action || '') || 0;
            // 同步内部房间状态：直播中收到「暂停/下播」(>=3) 时，上层可据此自动断开
            if (act >= RoomStatus.PREPARE && act <= RoomStatus.END) this.status = act;
            data.room = { status: act || void 0 };
          }
          break;
        case CastMethod.ROOM_RANK:
          // 小时榜/人气榜：ranks 为榜单列表（scoreStr 为分数）
          message = decodeRoomRankMessage(payload);
          data.method = CastMethod.ROOM_RANK;
          data.rank = this._getCastRanksB(message.ranks);
          break;
        case CastMethod.ROOM_STATS:
          // 房间统计：displayMiddle 为直播间在线人数展示值
          message = decodeRoomStatsMessage(payload);
          data.method = CastMethod.ROOM_STATS;
          data.room = { audienceCount: message.displayMiddle };
          break;
      }
      if (!data.method) return null;
      // 消息自身时间：所有消息类型共用的 common.createTime（秒级时间戳），
      // 重连补发/批量帧场景下它比本地记录时间更接近真实发送时间
      const ct = (message as any)?.common?.createTime;
      if (ct !== undefined && ct !== null && String(ct) !== '0') data.time = String(ct);
    } catch (err) {
      // MLog.error('DyCast Message Decode Error =>', method);
      return null;
    }
    return data;
  }

  /**
   * 获取当前的送礼榜单（观众席消息 WebcastRoomUserSeqMessage 用）
   *  - rank 为用户在榜名次（缺失时按数组顺序兜底 i+1）
   * @param data 原始榜单贡献者数组
   */
  private _getCastRanksA(data?: RoomUserSeqMessage_Contributor[]): LiveRankItem[] | undefined {
    if (!data || !data.length) return void 0;
    const list: LiveRankItem[] = [];
    for (let i = 0; i < data.length; i++) {
      const item = data[i];
      list.push({
        avatar: item.user?.avatarThumb?.urlList?.[0] || '',
        nickname: item.user?.nickname || '',
        rank: item.rank || i + 1
      });
    }
    return list;
  }

  /**
   * 获取当前的送礼榜单（小时榜消息 WebcastRoomRankMessage 用）
   *  - rank 用 scoreStr（榜单分数文本，如 "1.2万"），缺失时按数组顺序兜底
   * @param data 原始榜单项数组
   */
  private _getCastRanksB(data?: RoomRankMessage_RoomRank[]): LiveRankItem[] | undefined {
    if (!data || !data.length) return void 0;
    const list: LiveRankItem[] = [];
    for (let i = 0; i < data.length; i++) {
      const item = data[i];
      list.push({
        avatar: item.user?.avatarThumb?.urlList?.[0] || '',
        nickname: item.user?.nickname || '',
        rank: item.scoreStr || i + 1
      });
    }
    return list;
  }

  /**
   * 获取弹幕用户（User protobuf → CastUser 精简结构）
   *  - id 用 secUid（加密用户 ID，展示用足够；user_unique_id 属设备 ID 不在此列）
   *  - 尽量提取完整观众信息：头像三档 / 粉丝数 / 关注数 / 消费等级 / 粉丝团
   *    （model.ts 已完整解码，这里只做字段搬运，不再丢弃）
   *  - 注意：抖音 WSS 弹幕流里 followInfo(粉丝/关注数) 可能为空（部分消息不携带），
   *    payGrade/fansClub 通常存在；空字段保持 undefined，调用方自行兜底
   * @param data 原始用户对象
   * @returns 精简用户信息；无数据返回 undefined
   */
  private _getCastUser(data?: User): CastUser | undefined {
    if (!data) return void 0;
    // 粉丝团数据：fansClub.data 是当前直播间的粉丝团信息（灯牌）
    // 实测：服务端只下发 level（灯牌等级）和 userFansClubStatus，clubName 常为空
    const club = data.fansClub?.data;
    return {
      id: data.secUid,
      displayId: data.displayId,
      name: data.nickname,
      gender: data.gender,
      avatar: data.avatarThumb?.urlList?.[0],
      avatarMedium: data.avatarMedium?.urlList?.[0],
      avatarLarge: data.avatarLarge?.urlList?.[0],
      signature: data.signature,
      verified: data.verified,
      followingCount: data.followInfo?.followingCount,
      followerCount: data.followInfo?.followerCount,
      payLevel: data.payGrade?.level,
      payGradeName: data.payGrade?.name,
      fansClubName: club?.clubName,
      fansClubLevel: club?.level,
    };
  }

  /**
   * 获取弹幕礼物（GiftStruct protobuf → CastGift 精简结构）
   *  - price 为抖音币（diamond_count），count 为连击数，repeatEnd 标记连击阶段
   * @param data 原始礼物结构
   * @param count 连击/重复次数（来自 repeatCount 或 comboCount）
   * @param end 连击结束标记（0=连击开始，1=连击结束/单次）
   * @returns 精简礼物信息；无数据返回 undefined
   */
  private _getCastGift(data?: GiftStruct, count?: string, end?: number): CastGift | undefined {
    if (!data) return void 0;
    return {
      id: data.id,
      name: data.name,
      price: data.diamondCount,
      type: data.type,
      desc: data.describe,
      icon: data.image?.urlList?.[0],
      count: count,
      repeatEnd: end
    };
  }

  /**
   * 获取会员表情（WebcastEmojiChatMessage 专用）
   *  - emojiContent 是 Text 结构，取第一个 piece 的 imageValue 图片 URL
   * @param data 表情内容 Text
   * @returns 表情图片 URL；无数据返回 undefined
   */
  private _getCastEmoji(data?: Text): string | undefined {
    if (!data) return void 0;
    return data.pieces?.[0]?.imageValue?.image?.urlList?.[0];
  }

  /**
   * 获取弹幕富文本内容
   * @param data
   * @returns
   */
  private _getCastRtfContent(data?: Text): CastRtfContent[] | undefined {
    if (!data) return void 0;
    if (!data.pieces) return void 0;
    const pieces = data.pieces;
    const list: CastRtfContent[] = [];
    /**
     * pieces 类型
     *  - type = 1  : 普通的聊天文本 : 关键字段(stringValue)
     *  - type = 11 : @ 用户 : 关键字段(userValue.user)
     *  - type = 15 : 合成表情 : 关键字段(imageValue)
     */
    for (let i = 0; i < pieces.length; i++) {
      if (pieces[i].imageValue) {
        // 合成表情
        let url = pieces[i].imageValue?.image?.urlList?.[0];
        let name = pieces[i].imageValue?.image?.content?.name;
        list.push({
          type: CastRtfContentType.EMOJI,
          text: name,
          url
        });
      } else if (pieces[i].userValue) {
        // 艾特用户
        let atUser = pieces[i].userValue?.user;
        list.push({
          type: CastRtfContentType.USER,
          text: `@${atUser?.nickname}`,
          user: this._getCastUser(atUser)
        });
      } else {
        // 假定为普通文本类型
        // 实际还可能是 giftValue 之类的
        list.push({
          type: CastRtfContentType.TEXT,
          text: pieces[i].stringValue || ''
        });
      }
    }
    return list;
  }

  /**
   * 解码一帧 PushFrame 二进制数据
   *
   * PushFrame 结构（model.ts 中 decodePushFrame 定义）：
   *   ├─ logId            帧日志 ID（回 ack 时带回）
   *   ├─ payloadType      'hb' | 'ack' | 'msg' | 'close'
   *   ├─ headersList      帧头（含 im-cursor / im-internal_ext / compress_type）
   *   └─ payload          业务数据：可能是 gzip 压缩的 Response 编码
   *
   * 处理步骤：
   *   1. decodePushFrame 解出外层帧
   *   2. 若 headers['compress_type'] === 'gzip'：先 pako.ungzip 解压 payload
   *   3. decodeResponse 解出内层业务响应（messages[] / cursor / internalExt / needAck）
   *   4. 游标优先级：帧头 im-cursor > Response.cursor；internalExt 同理
   *
   * @param data PushFrame 编码的二进制
   * @returns 解码结果；无法解码时返回 null（由调用方忽略）
   */
  private async _decodeFrame(data: Uint8Array) {
    const frame = decodePushFrame(data);
    let payload = frame.payload;
    const headers = frame.headersList;
    let cursor = '';
    let internalExt = '';
    let needAck = !1;
    if (!payload) return null;
    if (headers) {
      // 帧头指示 payload 是否被 gzip 压缩：压缩则先解压再做业务解码
      if (headers['compress_type'] && headers['compress_type'] === 'gzip') {
        payload = pako.ungzip(payload);
      }
      // 帧头携带的消息游标（推进 / ack 用），优先于 Response 内字段
      if (headers['im-cursor']) {
        cursor = headers['im-cursor'];
      }
      if (headers['im-internal_ext']) {
        internalExt = headers['im-internal_ext'];
      }
    }
    const res = decodeResponse(payload);
    // 兜底：帧头没带游标时用 Response 内的字段
    if (!cursor && res.cursor) cursor = res.cursor;
    if (!internalExt && res.internalExt) internalExt = res.internalExt;
    if (res.needAck) needAck = res.needAck;
    return {
      response: res,
      frame,
      cursor,
      needAck,
      internalExt
    };
  }

  /**
   * 构造心跳帧（payloadType=hb）
   *  - 心跳帧无需 payload，服务器收到后仅维持连接活性
   *  - 心跳周期见 ping()：默认 10s 一次
   */
  private _ping() {
    return encodePushFrame({
      payloadType: PayloadType.Hb
    }) as Uint8Array<ArrayBuffer>;
  }

  /**
   * 构造 ACK 确认帧（payloadType=ack）
   *  - payload 为 internalExt 字符串的 UTF-8 手动编码字节（不依赖 TextEncoder，
   *    兼容 Electron 主进程环境）
   *  - 服务器根据 ack 中的 internalExt 判断客户端消息消费进度，从而决定
   *    断线重连时从哪个游标补发消息
   * @param ext Frame im-internal_ext | Response internalExt（须原样回传）
   * @param logId 帧日志 ID（可选，带回便于服务器关联）
   */
  private _ack(ext: string = '', logId?: string) {
    const getPayload = function (_ext: string) {
      // 手写 UTF-8 编码：将字符串按 Unicode 码点转换为 1~3 字节序列
      let arr = [];
      for (let s of _ext) {
        let index = s.charCodeAt(0);
        index < 128
          ? arr.push(index)
          : index < 2048
            ? (arr.push(192 + (index >> 6)), arr.push(128 + (63 & index)))
            : index < 65536 &&
              (arr.push(224 + (index >> 12)), arr.push(128 + ((index >> 6) & 63)), arr.push(128 + (63 & index)));
      }
      return new Uint8Array(arr);
    };
    return encodePushFrame({
      payloadType: PayloadType.Ack,
      payload: getPayload(ext),
      logId
    }) as Uint8Array<ArrayBuffer>;
  }

  /**
   * 获取连接所需信息（连接流程第 1 步）
   *
   * 完成三件事：
   *   1. 解析直播间页面 → 得到 19 位内部 roomId 与主播信息（nickname/title 等）
   *      - 优先用 getLiveInfo()（页面内嵌 state 正则解析，见 util.ts parseLiveHtml）
   *      - 解析失败时兜底：用简单正则抓 "roomId":\s*"(\d{15,})，仍失败则把
   *        用户输入的房间号直接当 roomId（连接失败由后续错误处理兜住）
   *   2. 补齐 user_unique_id（页面解析不出时随机生成 19 位 did）
   *   3. 调用 im/fetch 拿初次连接参数（cursor / internalExt / pushServer）
   *
   * 【踩坑记录】roomId 必须用 19 位内部 ID：
   *   用户输入的是 15 位房间号（如 962233848592），但 im/fetch 与 WSS 的
   *   room_id 参数必须用页面解析出的 19 位内部 ID（如 7675945602789772038）。
   *   用房间号虽然 WSS 能 101 握手成功，但服务器不会为该 ID 建立消息订阅，
   *   连接后收不到任何推送帧（probe4 反复验证）。
   *
   * @param roomNum 用户输入的房间号（或直播链接中的数字）
   */
  private async fetchConnectInfo(roomNum: string) {
    try {
      // 预热 Cookie 链：把签名窗口持久分区的会话 Cookie（ttwid/__ac_nonce 等，
      // 可能来自上次运行）合并进请求层，房间页首次抓取即可命中可解析状态，
      // 免掉「无 Cookie → 解析失败 → 再整页抓一遍」的固定双次页面请求（提速 1~3s）
      try {
        const sess = await getSessionCookieString();
        if (sess) seedCookieChain(sess);
      } catch {}
      let info = await getLiveInfo(roomNum);
      // 兜底：页面内嵌状态解析失败（正则不匹配新版页面）时，用简单正则提取 roomId，
      // uniqueId 随机生成（im/fetch 与 WSS 不要求与页面绑定，hybrid 测试已证明）
      if (!info || !info.roomId) {
        let roomId = roomNum;
        try {
          const html = await fetchLiveInfo(roomNum);
          const m = html.match(/"roomId\\?":\s*"?(\d{15,})/);
          if (m) roomId = m[1];
        } catch (e) {}
        info = {
          roomId,
          uniqueId: DyCast.randomDid(),
          avatar: '',
          cover: '',
          nickname: '',
          title: '',
          status: 2, // 假设在播，连接失败由错误处理兜住
          resolved: false, // 页面解析失败，roomId 为用户输入号兜底
        };
      } else {
        // 页面解析成功：roomId 应为 19 位内部号（≠ 用户输入的房间号）
        info.resolved = /^\d{15,19}$/.test(info.roomId) && info.roomId !== roomNum;
      }
      if (!info.uniqueId) info.uniqueId = DyCast.randomDid();
      // 关键：im/fetch、WSS、签名 stub 的 room_id 一律使用页面解析出的 19 位内部 roomId
      // （如 7675945602789772038），而非用户输入的房间号 —— 服务器只对内部 room_id
      // 建立消息订阅；用房间号虽能 101 握手成功，但连接后收不到任何推送帧（probe4 验证）
      this.info = info;
      this.status = info.status;
      // user 接口仅用于补充 Cookie（/dylive/ 路由已被抖音下线，通常直接 404）：
      // 已有会话 Cookie（__ac_nonce/ttwid）时跳过这次串行请求；失败也不阻断连接
      const cc = getCookieChain();
      if (!cc.includes('__ac_nonce') && !cc.includes('ttwid')) {
        await fetchUser().catch(() => {});
      }
      const res = await getImInfo(info.roomId, info.uniqueId);
      this.imInfo = res;
      CLog.info(
        `[dycast] im/fetch: roomId=${info.roomId} did=${info.uniqueId} pushServer=${res.pushServer || '(空,走兜底)'} cursor=${String(res.cursor || '').slice(0, 40)}`
      );
    } catch (err) {
      // CLog.error('DyCast LiveInfo Request Error =>', err);
      return Promise.reject(err);
    }
  }

  /**
   * 组装 WSS 连接参数（连接流程第 2 步）
   *
   * 关键字段说明：
   *   - room_id       ：19 位内部 roomId（来自 fetchConnectInfo，见上）
   *   - user_unique_id：必须是 im/fetch 响应 internalExt 中的 wss_push_did（19 位数字设备 ID）
   *   - signature     ：frontierSign 生成的 16 位 X-Bogus（经签名桥调用真实页面算法）
   *
   * 【踩坑记录】user_unique_id 与 DEVICE_BLOCKED：
   *   - 之前用随机生成 / 页面 odin 的 user_unique_id 发起 WSS，握手被服务器拒绝：
   *     handshake-msg=DEVICE_BLOCKED（HTTP 415）
   *   - 正确做法：从 im/fetch 响应的 internalExt 中正则提取 wss_push_did:(\d+)，
   *     签名 stub 与 WSS 参数都用同一个 did —— 服务器才认为「同设备同会话」
   */
  private async getWssParam(): Promise<DyCastOptions> {
    const { roomId } = this.info;
    const internalExt = this.imInfo.internalExt || '';
    // 从 im/fetch 的 internalExt 提取设备 ID：internal_src:dim|wss_push_room_id:xxx|wss_push_did:yyyy|...
    const did = String(internalExt).match(/wss_push_did:(\d+)/)?.[1] || DyCast.randomDid();
    CLog.info(
      `[dycast] internalExt=${JSON.stringify(String(internalExt).slice(0, 160))} wss_push_did=${did}`
    );
    const sign = await getSignature(roomId, did);
    return {
      room_id: roomId,
      user_unique_id: did,
      cursor: this.imInfo.cursor || '',
      internal_ext: internalExt,
      signature: sign
    };
  }

  /** 生成 19 位数字 did（页面解析不出 user_unique_id 时兜底） */
  static randomDid(): string {
    return String(Date.now()) + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
  }

  /**
   * 是否已经直播
   */
  private isLiving() {
    return this.status === RoomStatus.LIVING;
  }

  /** 获取直播状态 */
  private getLiveStatus() {
    let type = 'Unknown';
    let code = 0;
    let msg = '未知状态';
    switch (this.status) {
      case RoomStatus.PREPARE:
        type = 'PREPARE';
        code = RoomStatus.PREPARE;
        msg = '主播正在准备中';
        break;
      case RoomStatus.LIVING:
        type = 'LIVING';
        code = RoomStatus.LIVING;
        msg = '主播正在直播中';
        break;
      case RoomStatus.PAUSE:
        type = 'PAUSE';
        code = RoomStatus.PAUSE;
        msg = '主播暂时离开了';
        break;
      case RoomStatus.END:
        type = 'END';
        code = RoomStatus.END;
        msg = '主播已下播';
        break;
    }
    return {
      type,
      code,
      msg
    };
  }

  /**
   * 获取直播间信息
   */
  public getLiveInfo(): DyLiveInfo {
    return {
      ...this.info,
      roomNum: this.roomNum
    };
  }
}
