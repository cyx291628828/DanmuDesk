@echo off
chcp 65001 >nul
title DanmuDesk 一键启动
cd /d "%~dp0"

echo ============================================
echo    DanmuDesk 弹幕桌面 - 一键启动
echo ============================================
echo.

REM ---- 1. 检查 Node.js 环境 ----
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装：https://nodejs.org/
  echo        安装完成后重新双击本脚本即可。
  pause
  exit /b 1
)

REM ---- 2. 首次运行自动安装依赖（之后跳过） ----
if not exist "node_modules\electron\dist\electron.exe" (
  echo [1/3] 首次运行，正在安装依赖，请稍候...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重新运行。
    pause
    exit /b 1
  )
) else (
  echo [1/3] 依赖已就绪
)

REM ---- 3. 构建主进程（esbuild 打包，约 1 秒） ----
echo [2/3] 构建主进程...
call node scripts\build.mjs
if errorlevel 1 (
  echo [错误] 构建失败，请把上方错误信息反馈给开发者。
  pause
  exit /b 1
)

REM ---- 4. 启动应用（黑窗会自动关闭，应用独立运行） ----
echo [3/3] 启动 DanmuDesk 弹幕桌面...
start "" node scripts\launch.cjs
if errorlevel 1 (
  echo [错误] 启动失败。
  pause
  exit /b 1
)

echo.
echo 应用窗口即将弹出。若想查看运行日志，可改用命令行运行：
echo   node scripts\launch.cjs
echo.
timeout /t 2 >nul
