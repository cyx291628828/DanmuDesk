/**
 * ============================================================================
 * forwarder.ts — 弹幕消息转发器（每房间独立实例）
 * ============================================================================
 *
 * 【职责】
 *   把主进程收到的每条弹幕消息，实时转发到用户配置的目标 WS 地址。
 *   每个直播间独立一个 Forwarder 实例，独立连接/断开/启用转发。
 *
 * 【使用流程】
 *   1. new Forwarder() — 创建实例
 *   2. onStatus(cb) — 注册状态回调
 *   3. connect(url) — 连接 WS（此时不转发消息）
 *   4. WS 连接成功后，setForwardingEnabled(true) — 开始转发
 *   5. disconnect() — 断开 WS，停止转发
 *
 * 【可靠性设计】
 *   - 转发启用且 WS 未连接时，消息进入内存队列（上限 200 条，超出丢最旧），
 *     连上后自动补发
 *   - 断线自动重连（3s 间隔）
 *   - 发送失败只记日志不抛异常，不干扰主弹幕链路
 * ============================================================================
 */
import WebSocket from 'ws';
import { CLog } from './core/logUtil';

/**
 * 转发消息的标准结构（接收端按此 JSON 解析）
 */
export interface ForwardPayload {
  event: string;
  eventContent: string;
  text: string;
  user: {
    id?: string;
    displayId?: string;
    name?: string;
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
  };
  roomId?: string;
  giftId?: string;
  giftName?: string;
  giftCount?: number;
  repeatCount?: number;
  giftPrice?: number;
  likeCount?: number;
  msgId?: string;
  ts: number;
}

/** 转发器状态 */
export type ForwardState = 'disconnected' | 'connecting' | 'connected' | 'error';

const QUEUE_MAX = 200;
const RECONNECT_MS = 3000;

/**
 * 每房间转发器实例
 * - connect(url)：连接 WS 并开始转发消息
 * - disconnect()：断开 WS 并停止转发
 * - 转发内容受房间消息类型过滤（msgFilters）控制
 */
export class Forwarder {
  private url = '';
  private ws: WebSocket | null = null;
  /** 是否实际转发消息（用户开关，WS 连接后才能开启） */
  private forwardingEnabled = false;
  private queue: ForwardPayload[] = [];
  private reconnectTimer: NodeJS.Timeout | null = null;
  private statusCb: ((state: ForwardState, msg?: string) => void) | null = null;

  /** 注册状态回调 */
  onStatus(cb: (state: ForwardState, msg?: string) => void) {
    this.statusCb = cb;
  }

  /** 当前是否正在转发消息（forwardingEnabled=true） */
  isForwardingEnabled(): boolean {
    return this.forwardingEnabled;
  }

  /** 当前 WS 是否已连接 */
  isConnected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * 连接目标 WS
   * - 断开旧连接（若存在），发起新连接
   * - 连接成功后 forwardingEnabled 保持不变（通常为 false，需用户手动开启）
   */
  connect(url: string) {
    this.url = (url || '').trim();
    if (!this.url) return;
    this._teardown();
    CLog.info(`[forward] 连接目标 WS → ${this.url}`);
    this._connect();
  }

  /**
   * 断开 WS 连接并停止转发
   */
  disconnect() {
    this.forwardingEnabled = false;
    this._teardown();
    this._emitStatus('disconnected');
    CLog.info('[forward] 已断开 WS 连接');
  }

  /**
   * 设置是否转发消息（内部由 connect/disconnect 控制，连接=开，断开=关）
   */
  setForwardingEnabled(enabled: boolean) {
    this.forwardingEnabled = !!enabled;
    CLog.info(`[forward] 消息转发已${this.forwardingEnabled ? '开启' : '关闭'}`);
  }

  /**
   * 转发一条消息
   * - forwardingEnabled=false → 直接丢弃
   * - WS 已连接 → 立即发送
   * - WS 未连接 → 进队列缓存（上限 QUEUE_MAX），连上后补发
   */
  forward(payload: ForwardPayload) {
    if (!this.forwardingEnabled) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(payload));
        CLog.info(
          `[forward \u2713] ${payload.event} ${payload.user?.name || '\u533f\u540d'} \u2192 ${(payload.text || payload.eventContent || '').slice(0, 60)}`
        );
      } catch (err) {
        CLog.warn('[forward] \u53d1\u9001\u5931\u8d25\uff08\u5df2\u4e22\u5f03\u672c\u6761\uff09:', err);
      }
    } else {
      if (this.queue.length >= QUEUE_MAX) this.queue.shift();
      this.queue.push(payload);
    }
  }

  /** 主动关闭（房间断开/应用退出时调用） */
  dispose() {
    this.forwardingEnabled = false;
    this.url = '';
    this.queue = [];
    this._teardown();
  }

  // ---------- 内部实现 ----------

  private _connect() {
    if (this.ws) return;
    this._emitStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err: any) {
      CLog.warn('[forward] \u8fde\u63a5\u521b\u5efa\u5931\u8d25:', err?.message || err);
      this._emitStatus('error', err?.message || '\u8fde\u63a5\u521b\u5efa\u5931\u8d25');
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      CLog.info(`[forward] \u76ee\u6807 WS \u5df2\u8fde\u63a5: ${this.url}`);
      this._emitStatus('connected');
      const pending = this.queue.splice(0);
      for (const p of pending) {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify(p));
            CLog.info(`[forward \u2713] ${p.event} ${p.user?.name || '\u533f\u540d'} \u2192 ${(p.text || p.eventContent || '').slice(0, 60)}\uff08\u8865\u53d1\uff09`);
          } catch {}
        }
      }
    });
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      CLog.warn('[forward] \u76ee\u6807 WS \u5df2\u65ad\u5f00\uff0c3s \u540e\u81ea\u52a8\u91cd\u8fde');
      this._emitStatus('error', '\u76ee\u6807 WS \u5df2\u65ad\u5f00\uff0c\u91cd\u8fde\u4e2d...');
      this._scheduleReconnect();
    });
    ws.on('error', (err: Error) => {
      CLog.warn('[forward] \u76ee\u6807 WS \u9519\u8bef:', err?.message || err);
      this._emitStatus('error', err?.message || '\u8fde\u63a5\u9519\u8bef');
    });
  }

  private _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, RECONNECT_MS);
  }

  private _teardown() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }

  private _emitStatus(state: ForwardState, msg?: string) {
    try {
      this.statusCb?.(state, msg);
    } catch {}
  }
}
