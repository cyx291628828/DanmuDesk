// DanmuDesk 启动器
// 兼容性处理：部分 CLI / 沙箱环境会注入 ELECTRON_RUN_AS_NODE=1，
// 该变量会让 Electron 退化为纯 Node 模式（require('electron') 只返回 exe 路径，
// ipcMain/app 等全部不可用）。启动前先删除它，再拉起真正的 Electron。
const { spawn, spawnSync } = require('child_process');
const path = require('path');

// 中文乱码修复（Windows）：
// 中文 Windows 控制台默认代码页是 GBK(936)，而 Node/Electron 输出的是 UTF-8 字节，
// 经 npm/管道转发到控制台时会按 GBK 解码 → 中文全变乱码。
// 解决：启动前先把共享控制台代码页切到 65001(UTF-8)，之后 Electron 的中文日志
// 就能正常显示。chcp 是 cmd 内置命令，通过 cmd /c 执行即可（只改当前控制台，
// 不影响文件/系统设置）。失败时静默忽略，不影响启动。
if (process.platform === 'win32') {
  try {
    spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'chcp 65001>nul'], {
      stdio: 'inherit',
    });
  } catch {}
}

delete process.env.ELECTRON_RUN_AS_NODE;

// 在纯 Node 模式下 require('electron') 返回 electron.exe 的绝对路径
const electronPath = require('electron');
const appDir = path.join(__dirname, '..');

// ---- GPU 噪音过滤 ----
// 无独显/虚拟机/远程桌面环境下，Chromium 初始化软件渲染时会打
// 「Failed to create GLES3 context, fallback to GLES2」「Failed to create
// shared context for virtualization」等 ERROR —— 这是自动回退到 GLES2 的
// 无害噪音（功能不受影响），但每次启动刷几条容易让人误以为出错。
// 这里把已知无害的行过滤掉，其余 stderr 原样透传（真实报错不会被吞）。
const GPU_NOISE = [
  /Failed to create GLES\d? context/i,
  /Failed to create shared context for virtualization/i,
  /ContextResult::kFatalFailure/i,
];

const child = spawn(electronPath, ['.', ...process.argv.slice(2)], {
  cwd: appDir,
  env: process.env,
  stdio: ['inherit', 'inherit', 'pipe'],
});

let stderrBuf = '';
child.stderr.on('data', (chunk) => {
  stderrBuf += chunk.toString();
  const lines = stderrBuf.split('\n');
  stderrBuf = lines.pop() ?? ''; // 末段可能是不完整行，留到下个 chunk
  const kept = lines.filter((l) => !GPU_NOISE.some((re) => re.test(l)));
  if (kept.length) process.stderr.write(kept.join('\n'));
});
const flushStderr = () => {
  if (stderrBuf) process.stderr.write(stderrBuf);
  stderrBuf = '';
};
child.on('close', flushStderr);

child.on('error', (err) => {
  flushStderr();
  console.error('[launch] 启动 Electron 失败:', err.message);
  process.exit(1);
});

child.on('close', (code) => process.exit(code ?? 0));
