/**
 * sign-preload.js — 签名桥窗口专用 preload（沙箱模式，只读，不修改页面任何全局）
 *
 * 【背景】（2026-08-30 探针实测）
 *   抖音直播间页面在 DOMContentLoaded 之后会立刻发起 1~2 个同文档（in-place）导航，
 *   该导航在某些环境下永远挂起 → Chromium 在「导航进行中」冻结 executeJavaScript，
 *   同时 load 事件永不触发。表现为：loadURL 超时、executeJavaScript 永远挂起、
 *   签名桥初始化失败 → 连接慢/连不上。
 *
 * 【两个页面内就绪信号】（都不依赖 executeJavaScript，不受挂起导航冻结影响）
 *   1. signer:acrawler-ready —— window.byted_acrawler.frontierSign 可调用（签名用）
 *   2. signer:chat-ready     —— 评论输入框渲染完成（发送弹幕用；输入框只在
 *      已登录且页面完全渲染后才会出现，因此它同时是「页面渲染完成 + 登录有效」
 *      的复合信号；超时未出现会上报 hasInput:false）
 *
 * 【关键教训】主进程绝不能在这两个信号到达前 webContents.stop()——
 *   过早 stop 会把还在加载的文档杀掉，SPA 的评论框模块永远不会挂载。
 *
 * 安全性：本脚本只做「读取页面状态 + 发两条 IPC」，不改写任何页面全局。
 */
try {
  const { ipcRenderer } = require('electron');
  const findInput = function () {
    var all = Array.prototype.slice.call(
      document.querySelectorAll('div[contenteditable]:not([contenteditable="false"]), textarea, input[type="text"]')
    );
    var candidates = all.filter(function (e) {
      var ph = e.getAttribute('data-placeholder') || e.getAttribute('placeholder') || e.getAttribute('aria-label') || '';
      return !(e.tagName === 'INPUT' && ph.indexOf('\u641c\u7d22') >= 0);
    });
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i].offsetWidth || candidates[i].offsetHeight) return candidates[i];
    }
    return null;
  };

  var acrawlerReady = false;
  var chatReported = false;
  var polls = 0;

  var timer = setInterval(function () {
    try {
      // 信号 1：签名 SDK 就绪（通常 <1s）
      if (!acrawlerReady && window.byted_acrawler && typeof window.byted_acrawler.frontierSign === 'function') {
        acrawlerReady = true;
        ipcRenderer.send('signer:acrawler-ready');
      }
      // 信号 2：评论输入框渲染完成（依赖 SPA 懒加载模块挂载，可能需要数秒）
      if (!chatReported) {
        var inp = null;
        try { inp = findInput(); } catch (_) {}
        if (inp && (inp.offsetWidth || inp.offsetHeight)) {
          chatReported = true;
          ipcRenderer.send('signer:chat-ready', { hasInput: true, at: Date.now() });
        }
      }
    } catch (_) {}
    // 最多轮询 90s；超时上报未就绪（页面未登录/加载失败/结构变化）
    if (++polls > 180) {
      clearInterval(timer);
      if (!chatReported) {
        chatReported = true;
        ipcRenderer.send('signer:chat-ready', { hasInput: false, at: Date.now() });
      }
    }
  }, 500);
} catch (_) {}
