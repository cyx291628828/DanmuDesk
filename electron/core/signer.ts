// signer.ts — frontierSign 签名提供者（依赖注入）
// dycast 原版直接调用 window.byted_acrawler.frontierSign（浏览器页面注入）
// 桌面版主进程没有该环境，由 main.ts 通过 setFrontierSigner 注入实现：
//   默认实现：隐藏 BrowserWindow 加载抖音直播间页面，executeJavaScript 调用真实 frontierSign
//   备选实现：可注入社区算法实现（见 signBridge.ts）

/**
 * 签名入参：调用 frontierSign 时传入的参数对象
 *  - 包含 WSS URL 的关键 query 参数（room_id / user_unique_id / cursor 等）
 *  - 注意：参数须按页面要求以字符串键值对传入，顺序由实现方保证
 */
export type SignParams = Record<string, string>;
/** 签名结果：frontierSign 返回的 { 'X-Bogus': '16位字符串' } */
export type SignResult = Record<string, string>;

/**
 * 签名实现函数类型
 *  - 由外部注入（真实页面方案 / mock 方案），本模块只负责统一调度与等待
 */
export type SignerImpl = (params: SignParams) => SignResult | Promise<SignResult>;

const SIGNER_READY_TIMEOUT = 60000; // 签名桥初始化最久等待（页面加载 + acrawler 注入）

/**
 * 签名器状态机（三种来源，frontierSign() 统一等待）：
 *   - impl    ：已就绪的同步/异步实现（注入完成后赋值）
 *   - pending ：异步注入在途的 Promise（signBridge 初始化完成后 resolve）
 *   - readyPromise / readyResolve：注入完成的信号，供 frontierSign() 阻塞等待
 * 任何时刻最多一种「未完成」状态；markReady() 触发所有等待方继续
 */
let impl: SignerImpl | null = null;
let pending: Promise<SignerImpl> | null = null;
let readyResolve: (() => void) | null = null;
const readyPromise: Promise<void> = new Promise((res) => {
  readyResolve = res;
});

/** 标记签名器就绪：resolve readyPromise，唤醒所有等待中的 frontierSign 调用 */
function markReady() {
  readyResolve?.();
  readyResolve = null;
}

/** 设置签名实现（可同步设置；如测试注入 mock） */
export function setFrontierSigner(fn: SignerImpl) {
  impl = fn;
  pending = null;
  markReady();
}

/**
 * 设置异步签名实现（初始化完成后可用）
 *  - signBridge.initSigner 完成时调用，传 resolve 后的真实实现
 *  - Promise 失败时仅清空 pending，不抛未捕获异常（由调用方 await 得知）
 */
export function setFrontierSignerAsync(p: Promise<SignerImpl>) {
  pending = p;
  p.then((fn) => {
    impl = fn;
    pending = null;
    markReady();
  }).catch(() => {
    pending = null;
  });
}

/** 签名器是否已就绪（同步判断；未就绪请用 frontierSign 等待） */
export function isSignerReady(): boolean {
  return !!impl;
}

/**
 * 调用签名（signature.js 使用）
 *  - 按状态依次处理：实现已就绪 → 直接调用；异步注入在途 → 等 pending；
 *    注入尚未开始 → 等 readyPromise（上限 SIGNER_READY_TIMEOUT）
 *  - 最终未就绪（初始化失败/超时）时抛出明确错误
 */
export async function frontierSign(params: SignParams): Promise<SignResult> {
  if (!impl && pending) {
    // 异步初始化已在途，直接等它完成
    try {
      impl = await pending;
      pending = null;
      markReady();
    } catch (err) {
      throw new Error('frontierSign 签名器初始化失败: ' + (err as Error).message);
    }
  }
  if (!impl && readyResolve) {
    // 初始化仍在进行（隐藏窗口正在加载抖音页面/注入 acrawler），阻塞等待
    try {
      await Promise.race([
        readyPromise,
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('frontierSign 签名器初始化超时，请稍后重试')), SIGNER_READY_TIMEOUT)
        ),
      ]);
    } catch (err) {
      throw err;
    }
  }
  if (!impl) {
    throw new Error('frontierSign 签名器未初始化，请先连接初始化');
  }
  return impl(params);
}
