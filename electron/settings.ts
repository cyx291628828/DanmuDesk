/**
 * ============================================================================
 * settings.ts — 应用设置持久化模块
 * ============================================================================
 *
 * 【职责】
 *   管理需要跨重启保留的用户设置：
 *     roomForwards  每房间消息转发配置（WS 地址 + 是否启用转发）
 *     roomHistory   连接成功的直播间历史记录（房间号/主播名/最后连接时间）
 *
 * 【存储位置】
 *   userData/settings.json（app.getPath('userData')）
 *
 * 【设计要点】
 *   - 内存缓存 + 惰性加载：首次读取时从磁盘加载一次，之后走缓存
 *   - 写盘用同步 API：设置文件极小，同步写简单可靠
 *   - 读盘失败时静默回退默认值
 * ============================================================================
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { CLog } from './core/logUtil';

/** 单房间的转发配置 */
export interface RoomForwardConfig {
  /** 目标 WS 地址 */
  url: string;
  /** 是否启用转发消息（WS 连接后的开关） */
  enabled: boolean;
}

/** 连接历史记录条目 */
export interface RoomHistoryEntry {
  /** 房间号（用户输入的展示号） */
  roomId: string;
  /** 主播昵称（连接成功时页面解析结果） */
  nickname: string;
  /** 主播头像（尽力携带） */
  avatar: string;
  /** 最后一次连接成功的时间戳 */
  lastConnectedAt: number;
}

/** 历史记录上限：最多保留最近 20 条（连接成功即去重置顶） */
const HISTORY_MAX = 20;

/** 设置项结构 */
export interface AppSettings {
  /** 每房间消息转发配置：roomId → { url, enabled } */
  roomForwards: Record<string, RoomForwardConfig>;
  /** 连接成功的直播间历史（最新的在最前） */
  roomHistory: RoomHistoryEntry[];
}

const DEFAULTS: AppSettings = {
  roomForwards: {},
  roomHistory: [],
};

let cache: AppSettings | null = null;

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export function getSettings(): AppSettings {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf-8');
    const parsed = JSON.parse(raw);
    cache = { ...DEFAULTS, ...parsed };
    // 兼容旧版字段清理
    if (!cache.roomForwards) cache.roomForwards = {};
    if (!Array.isArray(cache.roomHistory)) cache.roomHistory = [];
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache as AppSettings;
}

/** 读取指定房间的转发配置 */
export function getRoomForward(roomId: string): RoomForwardConfig {
  const s = getSettings();
  return s.roomForwards[roomId] || { url: '', enabled: false };
}

/** 保存指定房间的转发配置并落盘 */
export function setRoomForward(roomId: string, url: string, enabled: boolean): void {
  const s = getSettings();
  if (!s.roomForwards) s.roomForwards = {};
  s.roomForwards[roomId] = { url: (url || '').trim(), enabled: !!enabled };
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2), 'utf-8');
  } catch (err) {
    CLog.warn('[settings] \u4fdd\u5b58\u8f6c\u53d1\u914d\u7f6e\u5931\u8d25:', err);
  }
}

/** 删除指定房间的转发配置（房间断开时清理） */
export function removeRoomForward(roomId: string): void {
  const s = getSettings();
  if (s.roomForwards && s.roomForwards[roomId]) {
    delete s.roomForwards[roomId];
    try {
      fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2), 'utf-8');
    } catch (err) {
      CLog.warn('[settings] \u5220\u9664\u8f6c\u53d1\u914d\u7f6e\u5931\u8d25:', err);
    }
  }
}

/** 读取连接历史（最新在前，最多 20 条） */
export function getRoomHistory(): RoomHistoryEntry[] {
  return [...getSettings().roomHistory];
}

/**
 * 记录一次连接成功（去重置顶 + 截断上限）
 *  - 由主进程在 DyCast open（真实连接成功）时调用
 */
export function addRoomHistory(entry: Omit<RoomHistoryEntry, 'lastConnectedAt'> & { lastConnectedAt?: number }): void {
  const s = getSettings();
  const list = s.roomHistory || (s.roomHistory = []);
  const idx = list.findIndex((e) => e.roomId === entry.roomId);
  const item: RoomHistoryEntry = {
    roomId: entry.roomId,
    nickname: entry.nickname || '',
    avatar: entry.avatar || '',
    lastConnectedAt: entry.lastConnectedAt ?? Date.now(),
  };
  if (idx >= 0) list.splice(idx, 1);
  list.unshift(item);
  if (list.length > HISTORY_MAX) list.length = HISTORY_MAX;
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2), 'utf-8');
  } catch (err) {
    CLog.warn('[settings] \u4fdd\u5b58\u8fde\u63a5\u5386\u53f2\u5931\u8d25:', err);
  }
}

/** 删除指定房间的历史记录（单条） */
export function removeRoomHistoryEntry(roomId: string): void {
  const s = getSettings();
  const list = s.roomHistory || (s.roomHistory = []);
  const idx = list.findIndex((e) => e.roomId === roomId);
  if (idx < 0) return;
  list.splice(idx, 1);
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2), 'utf-8');
  } catch (err) {
    CLog.warn('[settings] 删除历史记录失败:', err);
  }
}

/** 清空连接历史 */
export function clearRoomHistory(): void {
  const s = getSettings();
  s.roomHistory = [];
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2), 'utf-8');
  } catch (err) {
    CLog.warn('[settings] \u6e05\u7a7a\u8fde\u63a5\u5386\u53f2\u5931\u8d25:', err);
  }
}
