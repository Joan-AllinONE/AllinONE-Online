# -*- coding: utf-8 -*-
import io, os

ROOT = r"E:\Test Games\桌面宠物"
bat_path = os.path.join(ROOT, "启动桌面宠物.bat")

content = r"""@echo off
chcp 65001 >nul 2>&1
setlocal
title 桌宠小伙伴 - 桌面宠物模式

rem ===== 路径：使用 %~dp0 避免中文路径被命令行误读 =====
set "ROOT=%~dp0"
set "EDIR=%ROOT%electron"
set "EEXE=%EDIR%\node_modules\electron\dist\electron.exe"

echo.
echo ============================================================
echo   桌宠小伙伴 - 桌面宠物模式启动器
echo ============================================================
echo.

rem ---------- 1. 桌面组件是否已安装 ----------
if exist "%EEXE%" (
  echo [OK] 已检测到桌面组件，直接启动……
  goto :launch
)

echo [1/2] 首次启动，正在安装桌面宠物组件……
echo        体积约 100MB，只需安装一次，请耐心等待。
echo        （已配置国内镜像加速）
echo.

rem ---------- 2. 需要 npm 安装 ----------
where npm >nul 2>&1
if errorlevel 1 goto :need_install_tool

pushd "%EDIR%"
call npm.cmd install --no-audit --no-fund
set "IRC=%ERRORLEVEL%"
popd
if not "%IRC%"=="0" goto :install_failed
if not exist "%EEXE%" goto :install_failed

echo.
echo [OK] 组件安装完成，正在启动……
echo.

rem ---------- 3. 启动真·桌面宠物模式 ----------
:launch
rem 关键：清除该变量，否则 Electron 会退化成纯 Node 模式而启动失败
rem （VS Code 集成终端、部分 Node 版本管理器会注入它）
set ELECTRON_RUN_AS_NODE=

echo [2/2] 正在进入桌面宠物模式……
echo.
echo   - 宠物已置顶显示，可用鼠标自由拖拽
echo   - 除宠物与按钮外，点击会穿透到桌面，不影响办公
echo   - Ctrl+Shift+P    显示 / 隐藏宠物
echo   - 右键托盘图标     打开设置 / 重置位置 / 退出
echo   - 关闭宠物：右键托盘图标选择“退出”
echo.

rem 注册 desktoppet:// 启动协议（写入 HKCU，无需管理员）
rem 注册后网页上的「进入桌面宠物模式」按钮才能一键唤起本程序。
rem 失败不影响本次启动，静默忽略。
if exist "%ROOT%register-protocol.vbs" (
  cscript //nologo "%ROOT%register-protocol.vbs" /silent >nul 2>&1
)

pushd "%EDIR%"
start "" "%EEXE%" .
popd

rem 短暂等待后检测进程是否真的起来了
timeout /t 3 /nobreak >nul
tasklist /fi "imagename eq electron.exe" 2>nul | find /i "electron.exe" >nul
if errorlevel 1 (
  echo.
  echo [警告] 桌面宠物似乎未能启动，可能缺少运行库（如 Visual C++ Redistributable）。
  echo 请安装后重试，或暂时使用网页版（浏览器窗口模式）。
  echo.
  start "" "%ROOT%index.html"
  pause
)
goto :end

rem ---------- 错误分支 ----------
:need_install_tool
echo [错误] 未检测到 npm（Node.js），无法自动安装桌面组件。
echo.
echo 请先安装 Node.js（LTS 版本，一路下一步即可）：
echo     https://nodejs.org/
echo 安装后重新双击本文件即可。
echo.
echo 现在改用网页版（浏览器窗口模式）打开。
echo.
start "" "%ROOT%index.html"
pause
goto :end

:install_failed
echo.
echo [错误] 组件安装失败，请检查网络连接后重新双击本文件。
echo 也可手动执行： cd electron 然后 npm install
echo.
echo 现在改用网页版（浏览器窗口模式）打开。
echo.
start "" "%ROOT%index.html"
pause
goto :end

:end
endlocal
"""

with io.open(bat_path, "w", encoding="utf-8-sig") as f:
    f.write(content)

print("written:", bat_path, "bytes:", os.path.getsize(bat_path))
