// request.ts — 抖音接口请求层（Node https.request 直连）
// 与 wss_hybrid_test.js 已验证链路完全一致：
//   1) 房间页 → 收集 set-cookie（__ac_nonce 等）累积到 cookieChain
//   2) fetchUser（HEAD /dylive/webcast/user/）追加 cookie
//   3) im/fetch 携带 cookieChain 请求 → 解码 protobuf 得到 cursor / internalExt / pushServer
// 不使用 net.fetch：其 Cookie header 受 fetch 规范限制（forbidden header），
// 手动 https.request 可完整控制请求头。
import https from 'node:https';
import { getAbogus } from './abogus';
import type { DyImInfo } from './dycast';
import { decodeResponse } from './model';
import { getMsToken } from './signature';
import { makeUrlParams, parseLiveHtml } from './util';
import { CLog } from './logUtil';

/**
 * 请求直播间信息（抓取直播间页面 HTML）
 *  - 页面里内嵌了 RENDER_DATA/state，parseLiveHtml 从中解析 roomId 等字段
 *  - 桌面版直接抓真实直播间页面；/dylive/<id> 路由已被抖音下线（404），勿再使用
 */
// 桌面版：直连抖音官方域名（浏览器版经由 Vite proxy 同源转发）
const API_HOST = 'https://live.douyin.com';

// 桌面版：无浏览器环境，固定 UA
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const BROWSER_VERSION =
  '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const BROWSER_NAME = 'Mozilla';
const VERSION_CODE = 180800;

/**
 * 会话 Cookie 链（房间页 → user → im/fetch 逐级累积）
 *  - 每次响应里的 set-cookie 都会合并进来，后续请求自动携带
 *  - 抖音风控依赖这套 Cookie 链判断「同一浏览器会话」，缺失会导致接口
 *    返回空数据或 im/fetch 校验失败
 */
let cookieChain = '';

/**
 * 合并 set-cookie 到 cookieChain
 * @param setCookies e.g. ["__ac_nonce=abc; Path=/", ...]
 */
function mergeSetCookies(setCookies: string[]) {
  if (!setCookies || !setCookies.length) return;
  const map = new Map<string, string>();
  for (const c of (cookieChain || '').split('; ')) {
    if (!c) continue;
    const [k] = c.split('=');
    map.set(k, c);
  }
  for (const c of setCookies) {
    const [k] = c.split('=');
    if (k) map.set(k, c);
  }
  cookieChain = [...map.values()].join('; ');
}

/**
 * 预热 Cookie 链（签名窗口持久分区 → 请求层）
 *  - 签名窗口分区里保存着上次运行累积的 ttwid/__ac_nonce 等会话 Cookie，
 *    合并进来后房间页「首次抓取」即可命中可解析状态，
 *    免掉「无 Cookie → 解析失败 → 再整页抓一遍」的固定双次页面请求（连接提速 1~3s）
 *  - 外部（分区）值优先：覆盖 cookieChain 里的同名项
 * @param cookies "name1=value1; name2=value2; ..."（getSessionCookieString 的返回值）
 */
export function seedCookieChain(cookies: string): void {
  if (!cookies) return;
  mergeSetCookies(cookies.split('; ').filter(Boolean));
}

/** 当前会话 Cookie（供日志/调试） */
export function getCookieChain(): string {
  return cookieChain;
}

/** 重置会话 Cookie（断开连接时可选调用） */
export function resetCookieChain(): void {
  cookieChain = '';
}

interface ReqResult {
  status: number;
  headers: NodeJS.Dict<string | string[]>;
  body: Buffer;
}

/**
 * https 请求（自动携带并累积 Cookie）
 *  - 每个响应中的 set-cookie 都会 merge 进 cookieChain（见 mergeSetCookies），
 *    因此请求顺序必须是 房间页 → user → im/fetch，逐级累积完整会话
 * @param method HTTP 方法（GET/HEAD）
 * @param url 完整 URL（含 query）
 * @param extraHeaders 附加请求头（会覆盖默认的 UA/Referer）
 */
function req(method: string, url: string, extraHeaders: Record<string, string> = {}): Promise<ReqResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts: https.RequestOptions = {
      method,
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      headers: Object.assign({ 'User-Agent': USER_AGENT, Referer: 'https://live.douyin.com/' }, extraHeaders),
      timeout: 20000,
    };
    // 如果 extraHeaders 中没有 Cookie，才使用 cookieChain
    if (cookieChain && !extraHeaders.Cookie) opts.headers = Object.assign(opts.headers!, { Cookie: cookieChain });
    const r = https.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        // 累积 set-cookie（取分号前的 name=value 部分，丢弃 Path/Expires 等属性）
        const setCookies = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]);
        mergeSetCookies(setCookies);
        resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    r.on('error', reject);
    r.on('timeout', () => {
      r.destroy();
      reject(Error('request timeout'));
    });
    r.end();
  });
}

export const fetchLiveInfo = async function (id: string) {
  try {
    // 桌面版：直接抓真实直播间页面解析内嵌状态（/dylive/<id> 路由已被抖音下线，返回 404）
    const res = await req('GET', `${API_HOST}/${id}`);
    return res.body.toString('utf8');
  } catch (err) {
    return Promise.reject(Error('Fetch Live Info Error'));
  }
};

/**
 * 获取直播间信息
 * @param id 房间号
 * @returns
 */
export const getLiveInfo = async function (id: string) {
  try {
    const html = await fetchLiveInfo(id);
    const first = parseLiveHtml(html);
    if (first) return first;
    else {
      // 如第一次请求无 cookie => __ac_nonce，无法获得目标信息
      // 但第一次请求会返回 cookie => __ac_nonce
      // 请求第二次
      const realHtml = await fetchLiveInfo(id);
      const second = parseLiveHtml(realHtml);
      if (second) return second;
      else throw new Error('Get Live Info Error');
    }
  } catch (err) {
    return Promise.reject(err);
  }
};

/**
 * 用户请求
 *  - 用于增加cookie
 */
export const fetchUser = async function () {
  try {
    await req('HEAD', `${API_HOST}/dylive/webcast/user/`, {
      'X-Secsdk-Csrf-Request': '1',
      'X-Secsdk-Csrf-Version': '1.2.22'
    });
  } catch (err) {
    return Promise.reject(Error('Fetch Webcast User Error'));
  }
};

/**
 * 接口默认参数
 *  - /webcast/im/fetch 的 query 参数
 *  - 关键：resp_content_type=protobuf（要求二进制响应，用 decodeResponse 解码）
 *  - 必须携带加密参数 msToken + a_bogus，否则服务器返回空 body（风控拦截）
 */
const defaultIMFetchParams = {
  aid: 6383,
  app_name: 'douyin_web',
  browser_language: 'zh-CN',
  browser_name: BROWSER_NAME,
  browser_online: true,
  browser_platform: 'Win32',
  browser_version: BROWSER_VERSION,
  cookie_enabled: true,
  cursor: '',
  device_id: '',
  device_platform: 'web',
  did_rule: 3,
  endpoint: 'live_pc',
  fetch_rule: 1,
  identity: 'audience',
  insert_task_id: '',
  internal_ext: '',
  last_rtt: 0,
  live_id: 1,
  live_reason: '',
  need_persist_msg_count: 15,
  resp_content_type: 'protobuf',
  screen_height: 1080,
  screen_width: 1920,
  support_wrds: 1,
  tz_name: 'Asia/Shanghai',
  version_code: VERSION_CODE
};

/**
 * 请求初次连接信息（im/fetch，返回 protobuf 二进制）
 *  - 请求需要关键加密参数：msToken（JS 生成）+ a_bogus（由参数字符串 + UA 计算）
 *  - 成功响应为 protobuf 二进制（Response 编码），需 decodeResponse 解码，
 *    主要取 cursor / internalExt / pushServer 三个字段
 * @param roomId 19 位内部 roomId（来自页面解析，见 dycast.fetchConnectInfo）
 * @param uniqueId user_unique_id（wss_push_did）
 */
export const fetchImInfo = async function (roomId: string, uniqueId: string) {
  // 请求需要一些关键参数：msToken、a_bogus
  // 请求成功后会响应 protobuf 二进制数据，解码为 model 的 Response 类型
  // 主要需要里面的 cursor、internal_ext 值
  try {
    const msToken = getMsToken(184);
    const paramStr = makeUrlParams(
      Object.assign({}, defaultIMFetchParams, {
        room_id: roomId,
        user_unique_id: uniqueId,
        live_pc: roomId
      })
    );
    // 一个加密参数，须通过上侧 params 参数计算
    const aBogus = getAbogus(paramStr, USER_AGENT);
    const params = Object.assign({}, defaultIMFetchParams, {
      msToken,
      room_id: roomId,
      user_unique_id: uniqueId,
      live_pc: roomId,
      a_bogus: aBogus
    });
    const url = `${API_HOST}/webcast/im/fetch/?${makeUrlParams(params)}`;
    const res = await req('GET', url);
    CLog.info(
      `[request] im/fetch HTTP ${res.status} len=${res.body.length} cookieLen=${cookieChain.length} utf8head=${JSON.stringify(res.body.toString('utf8').slice(0, 120))}`
    );
    return res.body;
  } catch (err) {
    return Promise.reject(Error('Fetch Im Info Error'));
  }
};

/**
 * 获取初次连接信息（im/fetch 的封装：二进制 → DyImInfo 结构）
 * @param roomId 19 位内部 roomId
 * @param uniqueId user_unique_id（wss_push_did）
 * @returns 解析成功返回服务器字段；失败时返回手工构造的兜底值
 *          （cursor/internalExt 按约定格式生成，WSS 仍可建立，见下方注释）
 */
export const getImInfo = async function (roomId: string, uniqueId: string): Promise<DyImInfo> {
  const reqMs = Date.now();
  try {
    const buffer = await fetchImInfo(roomId, uniqueId);
    // 请求出错返回的可能为json（此时 decodeResponse 会因字节不符合协议而抛错，
    // 由下方 catch 兜底）
    const res = decodeResponse(new Uint8Array(buffer));
    return {
      cursor: res.cursor,
      internalExt: res.internalExt,
      now: res.now,
      pushServer: res.pushServer,
      fetchInterval: res.fetchInterval,
      fetchType: res.fetchType,
      liveCursor: res.liveCursor
    };
  } catch (err) {
    const now = Date.now();
    // 确保能返回 cursor、internalExt —— 兜底值按抖音约定格式手工构造：
    //   cursor 形如 r-{reqid}_d-1_u-1_fh-{id}_t-{ts}
    //   internalExt 包含 wss_push_room_id / wss_push_did（WSS 参数依赖后者）
    // 这样即使 im/fetch 临时失败，WSS 也能建立并收到消息（hybrid 测试验证过）
    return {
      cursor: `r-7497180536918546638_d-1_u-1_fh-7497179772733760010_t-${now}`,
      internalExt: `internal_src:dim|wss_push_room_id:${roomId}|wss_push_did:${uniqueId}|first_req_ms:${reqMs}|fetch_time:${now}|seq:1|wss_info:0-${now}-0-0|wrds_v:7497180515443673855`
    };
  }
};

/** 默认请求参数 */
const defaultMeFetchParam = {
  aid: '6383',
  app_name: 'douyin_web',
  browser_language: 'zh-CN',
  browser_name: 'Edge',
  browser_platform: 'Win32',
  browser_version: '146.0.0.0',
  cookie_enabled: 'true',
  device_platform: 'web',
  enter_from: 'web_live',
  language: 'zh-CN',
  live_id: '1',
  os_name: 'Windows',
  os_version: '10',
  room_id: '0',
  screen_height: '1080',
  screen_width: '1920'
};

/**
 * 获取当前登录用户信息
 * @returns
 */
export const fetchMeInfo = async function () {
  try {
    const params = Object.assign({}, defaultMeFetchParam);
    const paramStr = makeUrlParams(params);
    const msToken = getMsToken(184);
    const abogus = getAbogus(paramStr, USER_AGENT);
    Object.assign(params, {
      msToken,
      a_bogus: abogus
    });
    const url = `${API_HOST}/dylive/webcast/user/me/?${makeUrlParams(params)}`;
    const res = await req('GET', url);
    return JSON.parse(res.body.toString('utf8') || '{}');
  } catch (err) {
    return Promise.reject(`Fetch Me Info Error: ${err}`);
  }
};

interface DyResult<T> {
  /** 状态码 */
  code: number;
  /** 状态描述 */
  msg: string;
  /** 数据 */
  data: T;
}

interface DyMeInfo {
  /** sec_uid */
  uid: string;
  /** display_id : 抖音号 */
  did: string;
  /** 昵称 */
  nickname: string;
  /** 头像 */
  avatar: string;
  /** follower_count : 粉丝数 */
  follower: number;
  /** following_count : 关注数 */
  following: number;
  /** signature : 个性签名 */
  sign?: string;
}

/**
 * 获取当前登录用户信息
 */
export const getMeInfo = async function (): Promise<DyResult<DyMeInfo | null>> {
  try {
    const res = await fetchMeInfo();
    let code = 0;
    let msg = '';
    let info: DyMeInfo | null = null;
    if (res['status_code'] !== 0) {
      // 获取失败
      const data = res?.data || {};
      code = res['status_code'];
      msg = data?.prompts || data?.message || 'get user info fail';
    } else {
      // 获取成功
      const data = res.data || {};
      info = {
        uid: data.sec_uid || '',
        did: data.display_id || '',
        sign: data.signature || '',
        nickname: data.nickname || '',
        avatar: data.avatar_medium?.url_list?.[0] || '',
        follower: data.follow_info?.follower_count || 0,
        following: data.follow_info?.following_count || 0
      };
    }
    return {
      code,
      msg,
      data: info
    };
  } catch (err) {
    return Promise.reject(err);
  }
};

/**
 * 主播资料结果（webcast/user/profile 接口）
 */
export interface AnchorProfile {
  /** 粉丝数 */
  followerCount?: number;
  /** 关注数 */
  followingCount?: number;
  /** 昵称（接口侧，可与页面解析值交叉验证） */
  nickname?: string;
}

/**
 * 获取主播粉丝数/关注数（webcast/user/profile 接口，浏览器点击用户名时调用的同款接口）
 *
 * 实测要点（2026-08 验证）：
 *  - 无需 msToken/a_bogus 签名，但参数必须齐全，缺 anchor_id/sec_anchor_id 报 10011 params error
 *  - 查主播自己时 target_uid 与 anchor_id 都填主播的 uid
 *  - 必须携带房间页累积的 Cookie 链（getLiveInfo 已预热 cookieChain）
 *  - 返回结构：data.user_profile.follow_info.follower_count / following_count
 *  - 房间页 anchor.follow_info 只有 follow_status 不下发数字，此接口是页面对外唯一数字来源
 *
 * @param anchorId 主播数字 uid（页面 anchor.id_str）
 * @param anchorSecUid 主播 sec_uid（页面 anchor.sec_uid）
 * @param roomId 19 位内部 roomId
 */
export const fetchAnchorProfile = async function (
  anchorId: string,
  anchorSecUid: string,
  roomId: string
): Promise<AnchorProfile | null> {
  try {
    const params = {
      aid: 6383,
      app_name: 'douyin_web',
      live_id: 1,
      device_platform: 'web',
      language: 'zh-CN',
      enter_from: 'web_live',
      cookie_enabled: true,
      screen_width: 1920,
      screen_height: 1080,
      browser_language: 'zh-CN',
      browser_platform: 'Win32',
      browser_name: 'Edge',
      browser_version: '151.0.0.0',
      os_name: 'Windows',
      os_version: 10,
      target_uid: anchorId,
      sec_target_uid: anchorSecUid,
      anchor_id: anchorId,
      sec_anchor_id: anchorSecUid,
      current_room_id: roomId,
      click_source: 'pc_pc_comment_user'
    };
    const url = `${API_HOST}/webcast/user/profile/?${makeUrlParams(params)}`;
    const res = await req('GET', url);
    if (res.status !== 200 || res.body.length < 500) {
      CLog.warn(`[request] anchor profile HTTP ${res.status} len=${res.body.length}`);
      return null;
    }
    const json = JSON.parse(res.body.toString('utf8'));
    if (json.status_code !== 0) {
      CLog.warn(`[request] anchor profile status_code=${json.status_code}`);
      return null;
    }
    const followInfo = json?.data?.user_profile?.follow_info;
    return {
      followerCount: followInfo?.follower_count,
      followingCount: followInfo?.following_count,
      nickname: json?.data?.user_profile?.base_info?.nickname
    };
  } catch (err) {
    CLog.warn(`[request] anchor profile error: ${String((err as Error)?.message || err)}`);
    return null;
  }
};

/**
 * 发送弹幕到直播间（直接调用抖音 API）
 * @param roomId 直播间ID（19位内部roomId）
 * @param content 弹幕内容
 * @param loginCookie 登录Cookie字符串（从签名窗口获取）
 * @returns 是否发送成功
 */
