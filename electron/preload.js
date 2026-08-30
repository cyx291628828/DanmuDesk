/**
 * DanmuDesk preload — 安全暴露 IPC API 给渲染进程
 *
 * 通过 contextBridge 在隔离世界中暴露 window.danmu：
 *   - connect(roomId)              → Promise<{ok, msg?}>      发起连接
 *   - disconnect(roomId?)          → Promise<{ok}>            断开连接
 *   - setFilters(roomId, filters)  → Promise<{ok}>           同步消息类型过滤
 *   - forwardConnect(roomId, url)  → Promise<{ok}>            连接房间转发 WS
 *   - forwardDisconnect(roomId)    → Promise<{ok}>            断开房间转发 WS
 *   - forwardGet(roomId)           → Promise<{ok,url,connected}>
 *   - onForwardStatus(cb)          → 订阅转发器状态（含 roomId）
 *   - onMessage(cb) / onStatus(cb) / onError(cb) / onAnchor(cb)  订阅主进程推送
 *   - login() / checkLogin() / logout() / onLoginStatus(cb)     抖音登录
 *
 * 渲染进程没有 Node 能力（contextIsolation:true + nodeIntegration:false），
 * 只能通过这里暴露的受限 API 与主进程通信。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('danmu', {
  // 调用（invoke → 主进程 handle）
  connect: (roomId) => ipcRenderer.invoke('danmu:connect', roomId),
  disconnect: (roomId) => ipcRenderer.invoke('danmu:disconnect', roomId),
  // 抖音登录（礼物消息需要登录态才能收到）
  login: () => ipcRenderer.invoke('danmu:login'),
  checkLogin: () => ipcRenderer.invoke('danmu:check-login'),
  logout: () => ipcRenderer.invoke('danmu:logout'),
  onLoginStatus: (cb) => {
    const handler = (_e, s) => cb(s);
    ipcRenderer.on('danmu:login-status', handler);
    return () => ipcRenderer.removeListener('danmu:login-status', handler);
  },
  // 消息类型过滤：按房间独立同步（决定主进程是否打印日志/转发）
  setFilters: (roomId, filters) => ipcRenderer.invoke('danmu:set-filters', roomId, filters),
  // 消息转发：每房间独立 WS（连接即转发，断开即停止）
  forwardConnect: (roomId, url) => ipcRenderer.invoke('danmu:forward-connect', roomId, url),
  forwardDisconnect: (roomId) => ipcRenderer.invoke('danmu:forward-disconnect', roomId),
  forwardGet: (roomId) => ipcRenderer.invoke('danmu:forward-get', roomId),
  onForwardStatus: (cb) => {
    const handler = (_e, s) => cb(s);
    ipcRenderer.on('danmu:forward-status', handler);
    return () => ipcRenderer.removeListener('danmu:forward-status', handler);
  },
  // 发送弹幕（登录后可用；主进程串行队列 + 冷却）
  send: (roomId, content) => ipcRenderer.invoke('danmu:send', roomId, content),
  // 多条定时任务：添加/编辑/删除/列表（任务按 ID 管理，同房间可并存多条）
  scheduleAdd: (roomId, content, intervalSec) =>
    ipcRenderer.invoke('danmu:schedule-add', roomId, content, intervalSec),
  scheduleUpdate: (taskId, content, intervalSec) =>
    ipcRenderer.invoke('danmu:schedule-update', taskId, content, intervalSec),
  scheduleRemove: (taskId) => ipcRenderer.invoke('danmu:schedule-remove', taskId),
  scheduleList: () => ipcRenderer.invoke('danmu:schedule-list'),
  // 任务列表变更推送（房间断开移除任务等），收到后应刷新列表
  onScheduleChanged: (cb) => {
    const handler = (_e, s) => cb(s);
    ipcRenderer.on('danmu:schedule-changed', handler);
    return () => ipcRenderer.removeListener('danmu:schedule-changed', handler);
  },
  // 发送结果推送（定时任务的异步结果走这里，含 taskId）
  onSendStatus: (cb) => {
    const handler = (_e, s) => cb(s);
    ipcRenderer.on('danmu:send-status', handler);
    return () => ipcRenderer.removeListener('danmu:send-status', handler);
  },
  // 授权：状态查询 + 激活（顶部授权标识 / 激活弹窗用）
  licenseGetStatus: () => ipcRenderer.invoke('license:get-status'),
  licenseActivate: (key) => ipcRenderer.invoke('license:activate', key),
  onLicenseStatus: (cb) => {
    const handler = (_e, s) => cb(s);
    ipcRenderer.on('danmu:license-status', handler);
    return () => ipcRenderer.removeListener('danmu:license-status', handler);
  },
  // 连接历史（输入框下拉）：连接成功的直播间，最多 20 条
  getHistory: () => ipcRenderer.invoke('danmu:history-get'),
  historyRemove: (roomId) => ipcRenderer.invoke('danmu:history-remove', roomId),
  clearHistory: () => ipcRenderer.invoke('danmu:history-clear'),
  // 订阅（主进程 send → 渲染进程 on）
  onMessage: (cb) => {
    const handler = (_e, m) => cb(m);
    ipcRenderer.on('danmu:message', handler);
    return () => ipcRenderer.removeListener('danmu:message', handler);
  },
  onStatus: (cb) => {
    const handler = (_e, s) => cb(s);
    ipcRenderer.on('danmu:status', handler);
    return () => ipcRenderer.removeListener('danmu:status', handler);
  },
  onError: (cb) => {
    const handler = (_e, err) => cb(err);
    ipcRenderer.on('danmu:error', handler);
    return () => ipcRenderer.removeListener('danmu:error', handler);
  },
  // 主播信息兜底更新（弹幕流主播消息携带粉丝数/关注数时推送）
  onAnchor: (cb) => {
    const handler = (_e, a) => cb(a);
    ipcRenderer.on('danmu:anchor', handler);
    return () => ipcRenderer.removeListener('danmu:anchor', handler);
  },
});
