@echo off
chcp 65001 >nul
title DanmuDesk 一键打包
cd /d "%~dp0"

echo ============================================
echo    DanmuDesk 弹幕桌面 - 一键打包
echo    （生成安装包 + 免安装绿色版）
echo ============================================
echo.

REM ---- 1. 检查 Node.js 环境 ----
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装：https://nodejs.org/
  pause
  exit /b 1
)

REM ---- 2. 安装项目依赖 ----
if not exist "node_modules\electron\dist\electron.exe" (
  echo [1/4] 安装项目依赖，请稍候...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重新运行。
    pause
    exit /b 1
  )
) else (
  echo [1/4] 项目依赖已就绪
)

REM ---- 3. 安装打包工具 electron-builder（仅首次） ----
if not exist "node_modules\.bin\electron-builder.cmd" (
  echo [2/4] 安装打包工具 electron-builder，请稍候...
  call npm install --save-dev electron-builder --no-audit --no-fund
  if errorlevel 1 (
    echo [错误] electron-builder 安装失败，请检查网络后重新运行。
    pause
    exit /b 1
  )
) else (
  echo [2/4] 打包工具已就绪
)

REM ---- 4. 构建主进程 ----
echo [3/4] 构建主进程...
call node scripts\build.mjs
if errorlevel 1 (
  echo [错误] 构建失败，请把上方错误信息反馈给开发者。
  pause
  exit /b 1
)

REM ---- 5. 打包 ----
echo [4/4] 开始打包，请耐心等待（首次需下载打包组件，之后走缓存）...
echo.
REM 国内镜像加速（下载 nsis/winCodeSign 等组件用）
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
call npx electron-builder --win
if errorlevel 1 (
  echo.
  echo [错误] 打包失败，请查看上方错误信息。
  echo        常见原因：网络问题导致打包组件下载失败，可重试一次。
  pause
  exit /b 1
)

echo.
echo ============================================
echo  打包完成！产物位于 release 目录：
echo.
dir /b release\*.exe 2>nul
echo.
echo    * 安装版（Setup）：   双击安装后使用，带开始菜单快捷方式
echo    * 免安装版（portable）：直接双击运行，无需安装
echo ============================================
echo.
pause
