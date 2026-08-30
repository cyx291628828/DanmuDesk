// DanmuDesk 构建脚本：esbuild 打包主进程 TS → dist/main.js，复制 preload 与 renderer
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');

fs.mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [path.join(root, 'electron/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(dist, 'main.js'),
  external: ['electron'],
  logLevel: 'info',
});

fs.copyFileSync(path.join(root, 'electron/preload.js'), path.join(dist, 'preload.js'));
// 签名桥窗口专用 preload（页面内上报 acrawler 就绪，绕开挂起导航冻结）
fs.copyFileSync(path.join(root, 'electron/sign-preload.js'), path.join(dist, 'sign-preload.js'));
// 复制 vendor（签名 SDK 本地副本）——注意：此环境下 fs.cpSync 会崩溃，用 copyFileSync 逐个复制
function copyDir(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, name);
    const dest = path.join(destDir, name);
    const st = fs.statSync(src);
    if (st.isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}
copyDir(path.join(root, 'electron/vendor'), path.join(dist, 'vendor'));
// 复制 renderer —— 与 vendor 一样逐文件复制（此环境下 fs.cpSync 会静默失败，必须用 copyFileSync）
copyDir(path.join(root, 'renderer'), path.join(dist, 'renderer'));

console.log('[build] 完成 → dist/');
