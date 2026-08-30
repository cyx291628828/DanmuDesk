/**
 * ============================================================================
 * license.ts — 软件授权（离线签名授权码：机器绑定 + 有效期 + 版本上限 + 试用）
 * ============================================================================
 *
 * 【原理】
 *   Ed25519 非对称签名：卖家私藏私钥（项目根 license-private-key.pem，勿外泄、
 *   勿打包进软件），软件内置公钥。授权码格式：
 *
 *     DML1.<base64url(payload JSON)>.<base64url(签名)>
 *
 *   payload = { v, m: 机器码指纹, e: 到期日 YYYY-MM-DD, mv: 可用版本上限,
 *               iat: 签发时间, n: 买家备注（可选） }
 *
 *   软件本地验签 + 校验机器码/到期日/版本，通过才放行连接与发送。
 *
 * 【机器绑定】机器码 = SHA-256(Windows MachineGuid) 前 16 位 hex，
 *   显示为 XXXX-XXXX-XXXX-XXXX。一码一机；重装系统若 MachineGuid 变化需重签。
 *
 * 【试用期】未激活时可用 TRIAL_DAYS 天（自首次运行起），到期禁止连接/发送。
 *
 * 【防时间回拨】本地记录「见过的最大时间」，系统时间回拨超过容忍窗口则锁定，
 *   直到系统时间追回来。
 *
 * 【在线激活预留】本模块只做本地校验；未来接入在线激活/心跳时，把
 *   activateLicense 扩展为先请求服务端、再落本地签名令牌即可，架构无需变更。
 * ============================================================================
 */
import { app } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { CLog } from './core/logUtil';

/** 授权公钥（Ed25519 SPKI DER base64）——与项目根 license-private-key.pem 配对 */
const LICENSE_PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEAjGpACp5NDlmeENzmS3ZU+qkZld8QguwCEIzzYe8ALqs=';

/** 试用期天数（无授权码时自首次运行起可用天数） */
const TRIAL_DAYS = 3;
/** 时间回拨容忍窗口（毫秒）：回拨超过该值判定为篡改系统时间 */
const CLOCK_ROLLBACK_TOLERANCE_MS = 48 * 3600 * 1000;
/** 授权状态缓存有效期：期间内重复校验直接用缓存结果 */
const STATUS_CACHE_MS = 30 * 60 * 1000;

export type LicenseMode = 'licensed' | 'trial' | 'expired' | 'tampered' | 'missing';

export interface LicenseStatus {
  ok: boolean;
  mode: LicenseMode;
  /** 给用户看的说明（用于 toast / 授权弹窗） */
  msg: string;
  /** 机器码展示格式 XXXX-XXXX-XXXX-XXXX（买家下单时发回给卖家） */
  machine: string;
  /** 授权到期日（licensed 时有） */
  exp?: string;
  /** 试用剩余天数（trial 时有） */
  trialLeft?: number;
}

// ---------- 机器码 ----------

let machineCodeCache = '';

/** 机器码指纹（16 位 hex）：Windows MachineGuid 哈希，读不到时用主机名+用户名兜底 */
export function getMachineCode(): string {
  if (machineCodeCache) return machineCodeCache;
  let raw = '';
  try {
    const out = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', {
      encoding: 'utf8',
      timeout: 5000,
    });
    const m = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
    if (m) raw = m[1];
  } catch {
    /* 非 Windows 或权限不足，走兜底 */
  }
  if (!raw) raw = `${require('os').hostname()}|${require('os').userInfo().username}`;
  machineCodeCache = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return machineCodeCache;
}

/** 机器码展示格式 XXXX-XXXX-XXXX-XXXX */
export function getMachineCodeDisplay(): string {
  const h = getMachineCode();
  return (h.match(/.{4}/g) || []).join('-').toUpperCase();
}

// ---------- 授权码编解码 ----------

interface LicensePayload {
  v: number;
  m: string;
  e: string;
  mv?: string;
  iat: number;
  n?: string;
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s: string): Buffer {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function publicKey(): crypto.KeyObject {
  return crypto.createPublicKey({ key: Buffer.from(LICENSE_PUBLIC_KEY_B64, 'base64'), type: 'spki', format: 'der' });
}

// ---------- 本地状态（试用起点 + 防回拨） ----------

interface LicenseState {
  /** 见过的最大时间戳（防系统时间回拨） */
  ts: number;
  /** 首次运行时间（试用起点） */
  trialStart: number;
  /** 已激活的授权码 */
  key?: string;
}

let stateCache: LicenseState | null = null;
let lastStateWrite = 0;

function stateFile(): string {
  return path.join(app.getPath('userData'), 'license.state');
}

function loadState(): LicenseState {
  if (stateCache) return stateCache;
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    stateCache = {
      ts: Number(raw.ts) || Date.now(),
      trialStart: Number(raw.trialStart) || Date.now(),
      key: typeof raw.key === 'string' ? raw.key : undefined,
    };
  } catch {
    stateCache = { ts: Date.now(), trialStart: Date.now() };
  }
  return stateCache;
}

function saveState(force = false): void {
  const s = loadState();
  const now = Date.now();
  if (!force && now - lastStateWrite < 5 * 60 * 1000) return; // 节流：5 分钟内不重复写盘
  lastStateWrite = now;
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(s), 'utf8');
  } catch (err) {
    CLog.warn('[license] 状态写入失败:', err);
  }
}

/** 更新「见过的最大时间」，返回是否检测到时间回拨 */
function updateTimeSeen(): boolean {
  const s = loadState();
  const now = Date.now();
  if (now + CLOCK_ROLLBACK_TOLERANCE_MS < s.ts) return true; // 回拨超过容忍窗口
  if (now > s.ts) {
    s.ts = now;
    saveState();
  }
  return false;
}

// ---------- 校验 ----------

/** 语义化版本比较：appVer > maxVer 时返回 true */
function versionExceeds(appVer: string, maxVer?: string): boolean {
  if (!maxVer) return false;
  const a = appVer.split('.').map((x) => parseInt(x, 10) || 0);
  const b = maxVer.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}

let statusCache: { at: number; status: LicenseStatus } | null = null;
let onStatusChangedCb: ((s: LicenseStatus) => void) | null = null;
let lastMode: LicenseMode | null = null;

/** 注册授权状态变化回调（主进程注入，用于通知渲染层刷新标识） */
export function onLicenseStatusChanged(cb: (s: LicenseStatus) => void): void {
  onStatusChangedCb = cb;
}

/** 校验当前授权状态（带缓存；激活/过期/定时刷新时缓存失效） */
export function getLicenseStatus(): LicenseStatus {
  if (statusCache && Date.now() - statusCache.at < STATUS_CACHE_MS) return statusCache.status;
  const status = computeStatus();
  statusCache = { at: Date.now(), status };
  if (lastMode !== null && lastMode !== status.mode) onStatusChangedCb?.(status);
  lastMode = status.mode;
  return status;
}

function computeStatus(): LicenseStatus {
  const machine = getMachineCodeDisplay();
  const s = loadState();

  // 时间回拨检测
  if (updateTimeSeen()) {
    return { ok: false, mode: 'tampered', msg: '检测到系统时间回拨，授权校验已锁定。请校正系统时间后重启软件。', machine };
  }

  // 已有授权码：验签 + 机器/到期/版本校验
  if (s.key) {
    const r = verifyLicenseKey(s.key);
    if (r.ok && r.payload) {
      const expLeft = Math.ceil((new Date(r.payload.e + 'T23:59:59').getTime() - Date.now()) / 86400000);
      return {
        ok: true,
        mode: 'licensed',
        msg: `已授权（${r.payload.e} 到期${expLeft >= 0 ? `，剩余 ${expLeft} 天` : ''}）`,
        machine,
        exp: r.payload.e,
      };
    }
    // 授权码无效：按未授权继续走试用判定，msg 里带原因
    CLog.warn('[license] 已存授权码校验失败:', r.msg);
  }

  // 试用期判定
  const trialEnd = s.trialStart + TRIAL_DAYS * 86400000;
  const trialLeft = Math.ceil((trialEnd - Date.now()) / 86400000);
  if (Date.now() < trialEnd) {
    return {
      ok: true,
      mode: 'trial',
      msg: `试用中，剩余 ${Math.max(trialLeft, 0)} 天`,
      machine,
      trialLeft: Math.max(trialLeft, 0),
    };
  }
  return {
    ok: false,
    mode: 'expired',
    msg: `试用期已结束${s.key ? '（授权码无效）' : ''}，请输入授权码激活`,
    machine,
    trialLeft: 0,
  };
}

/** 校验授权码字符串（激活与状态校验共用） */
function verifyLicenseKey(key: string): { ok: boolean; msg?: string; payload?: LicensePayload } {
  try {
    const parts = String(key || '').trim().split('.');
    if (parts.length !== 3 || parts[0] !== 'DML1') return { ok: false, msg: '授权码格式不正确' };
    const payloadBuf = b64urlDecode(parts[1]);
    const sig = b64urlDecode(parts[2]);
    const valid = crypto.verify(null, payloadBuf, publicKey(), sig);
    if (!valid) return { ok: false, msg: '授权码签名无效（非本软件签发或已被篡改）' };
    const payload = JSON.parse(payloadBuf.toString('utf8')) as LicensePayload;
    if (payload.v !== 1 || !payload.m || !payload.e) return { ok: false, msg: '授权码内容不完整' };
    if (payload.m !== getMachineCode()) return { ok: false, msg: '授权码与本机不匹配（授权码绑定机器）' };
    if (new Date(payload.e + 'T23:59:59').getTime() < Date.now()) return { ok: false, msg: `授权码已于 ${payload.e} 过期` };
    if (versionExceeds(app.getVersion(), payload.mv)) {
      return { ok: false, msg: `当前版本 ${app.getVersion()} 超出授权可用版本（${payload.mv}），请联系卖家更新授权` };
    }
    return { ok: true, payload };
  } catch (e: any) {
    return { ok: false, msg: '授权码解析失败：' + (e?.message || e) };
  }
}

/**
 * 激活授权码（渲染层提交）。成功后写入本地状态并立即刷新缓存。
 * 【在线激活预留】未来接入服务端时：先请求服务端校验/注册机器码，
 * 由服务端返回（或重签）本机授权码，再走同样的本地落库流程。
 */
export function activateLicense(key: string): { ok: boolean; msg: string } {
  const r = verifyLicenseKey(String(key || '').trim());
  if (!r.ok || !r.payload) return { ok: false, msg: r.msg || '授权码无效' };
  const s = loadState();
  s.key = String(key).trim();
  saveState(true);
  statusCache = null; // 失效缓存，下次取最新状态
  CLog.info(`[license] 激活成功 exp=${r.payload.e}${r.payload.mv ? ` maxVer=${r.payload.mv}` : ''}${r.payload.n ? ` 备注=${r.payload.n}` : ''}`);
  const st = getLicenseStatus();
  onStatusChangedCb?.(st);
  return { ok: true, msg: st.msg };
}

/** 连接/发送等功能的授权门禁：通过返回 null，拒绝返回原因文案 */
export function licenseGate(): string | null {
  const st = getLicenseStatus();
  if (st.ok) return null;
  return st.msg;
}

/** 启动时调用：加载状态、首轮校验、启动定时复检 */
export function initLicense(): void {
  getLicenseStatus();
  const st = getLicenseStatus();
  CLog.info(`[license] 授权状态: mode=${st.mode} machine=${st.machine} ${st.msg}`);
  // 定时复检（试用到期/授权过期后无需重启即生效；30 分钟一次足够）
  const timer = setInterval(() => {
    statusCache = null;
    getLicenseStatus();
  }, 30 * 60 * 1000);
  (timer as any).unref?.();
}
