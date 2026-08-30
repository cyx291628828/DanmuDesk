# DanmuDesk 弹幕桌面

抖音直播弹幕桌面应用（Electron + 原生 Node 网络栈），核心移植自开源项目 [dycast](https://github.com/skmcj/dycast)。

输入直播间链接或房间号，即可在桌面端实时接收该直播间的弹幕、礼物、进场、点赞、关注等消息，支持多房间同时监听、消息统计与 WebSocket 转发（可对接 OBS 弹幕姬、AI 助手、数据大屏等下游程序）。

> 2026-08 性能与稳定性专项优化已完成，详见 [docs/优化工作文档.md](./docs/优化工作文档.md)。
> 连接速度从「3~12 秒，偶发 45 秒超时失败」优化到「热连接约 1~2 秒，冷启动自动重试自愈」。

---

## 功能特性

### 弹幕接收
- **一键连接**：输入 `live.douyin.com/123456` 链接或纯数字房间号均可（自动提取数字）
- **连接历史**：点击输入框弹出最近连接成功的直播间（房间号 + 主播名 + 上次连接时间），可视 5 条滚动、最多记录 20 条，点击直接重连
- **多房间同时监听**：右侧手风琴列表管理多个直播间，同时只展开一个，互不干扰
- **实时消息流**：弹幕 / 礼物（含连击）/ 进场 / 点赞（玩家赞数 + 直播间总赞）/ 关注 / 系统消息
- **观众信息完整透传**：昵称、抖音号、UID、头像三档、粉丝数、关注数、消费等级（财富等级）、粉丝团灯牌等级，鼠标悬停查看详情
- **同帧合并**：同一帧内同一用户的多条消息合并计数，避免刷屏

### 发送弹幕（登录后可用）
- **发送坞在左侧消息区下方**：即时发送目标为当前展开的直播间，标签实时显示「发送到：主播名（房间号）」
- **多条定时任务**：填写内容 + 间隔（5~3600 秒）点「添加定时」；任务按列表管理，同一房间可并存多条，每条可单独编辑/删除；到第一个间隔时开始自动发送，房间断开时该房间任务自动移除
- 发送走主进程串行队列（≥3 秒冷却，防风控）；采用「真实页面注入」方案：在真实抖音页面的评论框写入内容，并通过 CDP 按键注入触发真实回车（与真人键盘操作等价）
- 发送以「输入框被清空」为成功判据（失败时内容会留在输入框并提示原因）；未登录时页面无评论框，会明确提示先登录

### 直播间信息
- 主播昵称、头像、直播标题
- 在线人数、本场总点赞数（点赞消息实时同步）
- 主播粉丝数 / 关注数（页面解析 + user/profile 接口 + 弹幕流兜底三路补全）
- 连接时长计时

### 统计与过滤
- 每房间独立统计：弹幕数 / 礼物数 / 进场数 / 点赞数 / 关注数
- 每房间独立的消息类型过滤（勾选即生效，同时控制主进程日志与转发行为）
- 暂停滚动、清空列表（每房间消息快照独立保留，最多 500 条）

### 消息转发（WebSocket）
- 每房间独立配置一个目标 WS 地址（如 `ws://127.0.0.1:8080`），连接即转发
- 转发内容为结构化 JSON（完整观众信息 + 事件 + 礼物字段 + 点赞字段），详见 [forwarder.ts](./electron/forwarder.ts) 中 `ForwardPayload` 结构
- 断线自动重连（3s 间隔），未连接期间消息进内存队列（上限 200 条），连上后自动补发
- 转发地址按房间持久化，重启应用后自动恢复

### 抖音登录
- 右上角登录抖音账号（扫码/验证码），Cookie 持久化到独立分区
- **未登录可以收弹幕，但收不到礼物消息**（抖音 2026-04 起的推送策略，礼物仅下发给已登录连接）
- 登录 Cookie 自动备份与自愈：页面风控误清 sessionid 时自动从备份恢复
- 支持退出登录（只清登录 Cookie，保留访客 Cookie 供签名使用）

### 稳定性
- 心跳保活：10s 周期心跳，连续 2 个周期收不到任何服务器帧判定链路死亡
- 三级重连：WSS 层退避重连（1s×n，携带最新 cursor 断点续传）→ 主进程层自动重连（1.5s~5s 退避，最多 3 次）→ 提示用户
- 下播自动断开（status=3 暂停 / 4 下播）、无效房间号提示、连接超时兜底（150s）
- 单实例锁：防止多开导致 Cookie 分区数据库互相覆盖
- 竞态保护：连接代数（seq）机制保证「取消/断开/重连」操作能安全中断进行中的连接流程

---

## 技术架构

### 消息链路

```
房间号/链接
   │
   ▼
┌───────────────────────────── 主进程 (electron/main.ts) ─────────────────────────────┐
│                                                                                      │
│  签名桥 signBridge.ts          页面解析 request.ts            弹幕客户端 dycast.ts      │
│  ┌──────────────────┐   ┌──────────────────────┐   ┌───────────────────────────┐    │
│  │ 隐藏窗口加载真实   │   │ 抓取直播间页面 HTML   │   │ im/fetch → cursor /        │    │
│  │ 抖音直播间页面     │   │ 解析 19 位内部 roomId │   │ internalExt / pushServer   │    │
│  │ → frontierSign    │   │ + 主播/房间信息       │   │ → WSS 长连接 (ws 库)       │    │
│  │   (X-Bogus 签名)  │   │ → im/fetch 参数      │   │ → PushFrame 解码/心跳/ACK  │    │
│  └──────────────────┘   └──────────────────────┘   └────────────┬──────────────┘    │
│           │                        │                             │                   │
│           └── Cookie 分区（persist:danmusign，含登录态）──────┘                     │
│                                        │                                            │
│                          消息解析（protobuf 手写编解码 model.ts）                     │
│                                        │                                            │
│              每房间转发器 forwarder.ts（WS 下游）  ┆  每房间过滤/统计/日志              │
└────────────────────────────────────────┼───────────────────────────────────────────┘
                                         ▼ IPC（contextBridge 白名单）
                              渲染进程 renderer/（原生 HTML/CSS/JS）
```

### 关键设计

- **核心复用**：`electron/core/` 直接移植 dycast `src/core`（HTTP / protobuf / WSS / 心跳重连），仅改动 3 处浏览器 API：
  1. `dycast.ts` — `location.origin` → 固定 `wss://live.douyin.com`
  2. `request.ts` — `navigator` → 固定 UA；`/dylive/*` 相对路径 → 绝对 URL
  3. `signature.js` — `window.byted_acrawler.frontierSign` → 可注入的签名桥（`signer.ts` 依赖注入）

- **签名桥**（`signBridge.ts`）：`frontierSign` 是 JSVMP 虚拟机保护算法，强依赖真实浏览器环境，纯 Node 复刻成本极高。方案是隐藏 BrowserWindow 加载真实抖音直播间页面，让页面自动注入 `window.byted_acrawler`，再用 `executeJavaScript` 调用真实 `frontierSign` 得到 X-Bogus。签名算法始终跟随抖音页面实时更新，无需维护逆向实现。
  - **页面粘性复用**：任何直播间页面都能提供签名环境（签名参数由主进程传入），换房间不重载页面
  - **媒体拦截**：`webRequest` 屏蔽 media 资源，隐藏窗口不需要真的播放直播，省掉视频解码的内存/CPU
  - **挂起导航自愈**：抖音页面在 DOMContentLoaded 后会发起 1~2 个同文档（in-place）导航，部分环境下永远挂起，导致 `executeJavaScript` 被 Chromium 冻结、load 事件永不触发（连接慢/连不上的根因）。自愈手段：沙箱 preload 在页面内部上报 SDK 就绪信号（不依赖 executeJavaScript）+ 调用超时后 `webContents.stop()` 终止挂起导航再重试

- **Cookie 管理**：签名窗口使用持久化分区 `persist:danmusign`，Cookie 跨重启保留；HTTP 请求层（request.ts）用 Node `https.request` 手动携带 Cookie（Electron `net.fetch` 的 Cookie 是 forbidden header，不可控），签名分区 Cookie 会预热合并进请求层 Cookie 链，减少首次连接的重复页面抓取；WSS 握手携带同一分区导出的完整 Cookie 串

- **WebSocket / WebAssembly**：依赖 Electron 内置 Node 22（原生 WebSocket、WASM 均可用）；WSS 用 `ws` 库而非原生 WebSocket，因为主进程原生 WebSocket 无法自定义握手 Cookie

- **协议要点**（踩坑记录，改动前务必阅读 `dycast.ts` 头部注释）：
  - WSS 每帧是 PushFrame（headersList + payload），payload 可能 gzip 压缩；headers 里的 `im-cursor` / `im-internal_ext` 是游标，ACK 必须原样带回，漏发会断流
  - `room_id` 必须用页面解析出的 19 位内部 ID（用户输入的房间号只能握手成功，收不到任何消息）
  - `user_unique_id` 必须用 im/fetch 响应 internalExt 里的 `wss_push_did`，否则握手被拒（DEVICE_BLOCKED, HTTP 415）
  - WSS 域名以 im/fetch 响应的 `push_server` 为准

- **进程隔离**：主窗口 `contextIsolation:true + nodeIntegration:false`，渲染层仅能通过 preload 白名单 IPC（`window.danmu.*`）通信；签名桥窗口保持 Chromium 沙箱（`sandbox:false` 会暴露 Node 特征，被风控判定自动化环境）

---

## 项目结构

```
DanmuDesk/
├── electron/
│   ├── main.ts            # 主进程入口：窗口、IPC、多房间连接管理、超时/重连调度
│   ├── preload.js         # 主窗口安全桥接（contextBridge 白名单）
│   ├── signBridge.ts      # 签名桥：隐藏窗口 + frontierSign + Cookie 分区 + 挂起导航自愈
│   ├── sign-preload.js    # 签名窗口专用 preload（页面内上报 SDK 就绪，只读）
│   ├── forwarder.ts       # 每房间消息转发器（WS 下游、断线重连、补发队列）
│   ├── danmuSender.ts     # 发送弹幕（页面注入 + 串行队列/冷却 + 定时任务）
│   ├── settings.ts        # 设置持久化（转发配置 + 连接历史，userData/settings.json）
│   └── core/              # 移植自 dycast 的核心库
│       ├── dycast.ts      # 弹幕客户端（im/fetch → WSS → 心跳/ACK/重连 → 消息分发）
│       ├── request.ts     # HTTP 接口层（房间页解析 / im/fetch / user-profile，Cookie 链）
│       ├── model.ts       # 手写 protobuf 编解码（PushFrame/Response/Chat/Gift/Like…）
│       ├── signature.js   # MD5 STUB + X-Bogus 签名入口（调 signer）
│       ├── signer.ts      # 签名实现依赖注入器（真实页面方案 / mock 注入）
│       ├── abogus.js      # a_bogus 加密参数（SM3）
│       ├── emitter.ts     # 极简类型安全事件发射器
│       ├── logUtil.ts     # CLog 日志（控制台 + 文件批量落盘 + 50MB 轮转）
│       ├── util.ts        # 页面内嵌 state 解析（字段级正则）
│       └── Long.ts        # Long 整数工具
├── renderer/              # 渲染进程 UI（原生 HTML/CSS/JS，无框架）
│   ├── index.html
│   ├── style.css
│   └── app.js             # 多房间手风琴、消息渲染、过滤/转发/登录交互
├── scripts/
│   ├── build.mjs          # esbuild 打包主进程 → dist/，复制 preload/renderer/vendor
│   └── launch.cjs         # 启动器（清 ELECTRON_RUN_AS_NODE、控制台 UTF-8）
├── electron/vendor/       # webmssdk.es5.js 本地副本（备用）+ sign-bridge.html
├── docs/优化工作文档.md    # 2026-08 性能与稳定性专项优化的完整工作记录
├── log/                   # 运行日志（开发=项目根/log；打包=userData/log）
├── 一键启动.bat            # 自动装依赖 → 构建 → 启动
└── 一键打包.bat            # 自动装依赖 → 构建 → electron-builder 打包
```

---

## 快速开始

### 环境要求

- Windows 10/11 x64（当前构建目标）
- Node.js ≥ 18（用于安装依赖与构建；运行时用 Electron 内置 Node 22）
- 需要能直连 `*.douyin.com` 的网络（应用强制直连，不读系统代理，见 [常见问题](#常见问题-faq)）

### 安装与运行

```bash
npm install        # 安装依赖（已配置 npmmirror 镜像，国内网络友好）
npm run dev        # 构建并启动（开发模式）
npm start          # 构建 + 启动
npm run build      # 仅构建（esbuild 打包主进程 + 复制渲染层到 dist/）
```

也可以直接双击 **`一键启动.bat`**（首次运行自动安装依赖、构建并启动）。

### 打包发布

```bash
npm run dist          # NSIS 安装包 + portable 绿色版
npm run dist:nsis     # 仅安装包
npm run dist:portable # 仅绿色版
```

或双击 **`一键打包.bat`**（自动配置 electron-builder 国内镜像）。产物输出到 `release/`。

---

## 使用方法

### 1. 连接直播间
1. 顶部输入框粘贴直播间链接（`https://live.douyin.com/123456`）或直接输入房间号
2. 点击「新增连接」（或回车）
3. 等待连接成功——右侧出现直播间卡片，消息开始滚动
4. 连接过程中按钮变为「断开连接」，点击可随时取消

> **历史记录**：点击输入框会弹出最近连接成功的直播间（主播名 + 房间号 + 上次连接时间，最多 20 条、可视 5 条滚动），点击任意一条直接重连；面板右上角「清空」可清空历史。

### 2. 多房间管理
- 每连接一个房间，右侧新增一张手风琴卡片；点击卡片头展开/收起，同时只展开一个
- 卡片右上角 `×` 断开并移除该直播间

### 3. 消息类型过滤
- 展开房间卡片 → 「消息类型」区勾选/取消对应类型
- 过滤即时生效：同时控制界面显示、主进程日志与消息转发
- 礼物类型需登录抖音后才可勾选（未登录时抖音不下发礼物消息）

### 4. 发送弹幕（需登录）
1. 右上角登录抖音账号
2. 展开房间卡片 → 「发送弹幕」区输入内容 → 点击「发送」（或回车）
3. **定时重复发送**：先在上方输入内容，再填「间隔(秒)」（最少 5 秒）→ 点击「定时发送」——立即发送一次并按间隔重复；按钮变为「停止定时」，点击即停
4. 注意事项：
   - 发送依赖签名窗口加载目标房间页面：向「当前签名页面不在的房间」发送时首次会自动切换页面（约 2~6 秒），同房间连续发送无额外开销
   - 所有发送共用一个队列（间隔 ≥3 秒），直播间禁言/风控时会返回失败原因
   - 直播间未开播或你被禁言时发送会失败，以 toast 提示为准

### 5. 消息转发（对接下游程序）
1. 展开房间卡片 → 「消息转发」区填入目标 WS 地址（如 `ws://127.0.0.1:8080`）
2. 点击「连接」——连接建立后即开始转发该房间已勾选类型的消息
3. 下游程序按以下 JSON 结构解析（节选）：

```jsonc
{
  "event": "chat",              // chat|gift|enter|like|follow|sys
  "eventContent": "发送弹幕",   // 事件描述
  "text": "弹幕正文",           // 仅弹幕消息有
  "user": {
    "id": "sec_uid", "displayId": "抖音号", "name": "昵称",
    "avatar": "https://...", "payLevel": 30, "fansClubLevel": 12
    // ...完整字段见 forwarder.ts 的 ForwardPayload
  },
  "giftName": "小心心", "giftCount": 1, "repeatCount": 5, // 仅礼物消息
  "likeCount": 1, "likeTotal": 1929,                       // 仅点赞消息
  "roomId": "123456",
  "msgId": "...", "ts": 1788063878244
}
```

### 6. 登录抖音（接收礼物/发送弹幕必需）
1. 点击右上角抖音图标 → 「登录抖音」
2. 在弹出窗口完成扫码/验证码登录，窗口自动关闭
3. 登录态持久化保存；之后连接的直播间才能收到礼物消息
4. 退出登录：右上角头像 → 用户卡片 → 「退出登录」

---

## 日志与诊断

| 位置 | 说明 |
| --- | --- |
| `log/app.log` | 运行时主日志（开发=项目根/log，打包后=`%APPDATA%/danmudesks/log`），50MB 自动轮转 |
| `log/connect_flow.log` | 连接冒烟测试专用的帧级日志 |
| `userData/settings.json` | 每房间转发配置持久化 |
| `userData/sign-login-cookies.json` | 登录 Cookie 备份（自愈用） |

调试辅助命令：

```bash
DANMU_TEST=1 node scripts/launch.cjs              # 自检：验证 WebSocket/WASM/fetch 运行时能力后退出
DANMU_TEST_CONNECT=<roomId> node scripts/launch.cjs  # 连接冒烟测试：不弹窗，直接连真实直播间，60s 后退出
DEBUG_SIGN=1 node scripts/launch.cjs              # 显示签名桥隐藏窗口（调试页面加载/签名）
DANMU_TEST_MOCK_SIGN=1 DANMU_TEST_CONNECT=...     # 注入 mock 签名器（无页面环境时验证 protobuf 链路）
```

---

## 常见问题（FAQ）

**Q: 连接要多久？为什么有时候很慢？**
首次连接（应用冷启动后第一次）需要隐藏窗口加载一次抖音直播间页面来收集签名环境与 Cookie，约 2~6 秒；之后所有连接复用该页面（签名环境就绪后就地缓存），通常 1~2 秒。2026-08 优化前首次连接需要 3~12 秒且偶发超时失败，现在已修复并带自动重试，详见 [优化工作文档](./docs/优化工作文档.md)。

**Q: 提示连接超时 / 连接不稳定？**
- 检查网络能否直连 `live.douyin.com`（浏览器打开直播间页面验证）
- 房间号是否有效（主播是否在播；下播会自动断开并提示）
- 高频风控时段（如凌晨）握手可能被拒（日志出现 `DEVICE_BLOCKED`），等待几分钟后重试
- 日志 `log/app.log` 中搜索 `握手被拒` / `DEVICE_BLOCKED` 可确认具体原因

**Q: 收不到礼物消息 / 发不了弹幕？**
礼物消息只下发给已登录连接，发送弹幕也要求登录态（两者都依赖右上角的抖音登录）。登录后重新连接即可。若提示「需先登录」但界面显示已登录，是登录 Cookie 已过期，退出登录后重新扫码即可。

**Q: 能收到弹幕但界面不动？**
查看消息类型过滤是否全部取消勾选了；或「暂停滚动」处于开启状态。

**Q: 走代理 / 公司网络能用吗？**
应用启动时强制 `no-proxy-server`（直连），系统代理与代理环境变量不生效。需要代理才能访问抖音的网络环境无法使用。

**Q: 双击 exe 启动后在哪里看日志？**
打包版日志在 `%APPDATA%/danmudesks/log/app.log`（路径打印在启动日志第一行）。

---

## 说明

- 本工具仅用于学习交流与个人研究，请遵守抖音平台规则与相关法律法规，勿用于商业用途
- 请控制监听房间数量与使用频率，尊重目标平台的服务
- 核心协议实现移植自 [skmcj/dycast](https://github.com/skmcj/dycast)（MIT），感谢原作者
- 接口与风控策略随抖音更新可能变化，遇到问题先看日志，再参考 [优化工作文档](./docs/优化工作文档.md) 中的排查思路
