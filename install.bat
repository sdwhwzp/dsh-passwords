@echo off
setlocal EnableExtensions
chcp 65001 >nul
rem dsh-passwords 一键安装（Windows 引导壳；实际逻辑在 scripts\install.mjs）
rem
rem 用法（二选一）:
rem   1) 双击本文件（推荐）：自动装依赖、下载项目、完成安装，装完停在窗口里显示 SETUP_KEY
rem   2) 已 clone：在项目目录里双击或运行 install.bat（跳过依赖安装和下载）
rem
rem 做什么：检查 Node.js 22.5+ / git / dsh，缺了用 winget / npm 自动装；
rem 然后下载项目，交给 scripts\install.mjs 完成安装（pnpm 缺了也会自动装）。

call :main
set "EXIT_CODE=%errorlevel%"
echo.
echo [dsh-passwords] 按任意键退出…
pause >nul
exit /b %EXIT_CODE%

:main
set "SCRIPT_DIR=%~dp0"

rem ── 0. 已在 clone 的项目目录里：直接执行安装 ──
if exist "%SCRIPT_DIR%scripts\install.mjs" goto run

rem ── 1. Node.js（缺了用 winget 自动装；版本不够直接报错） ──
where node >nul 2>nul
if not errorlevel 1 goto node_ok
echo [dsh-passwords] 未找到 Node.js，正在自动安装…
where winget >nul 2>nul
if errorlevel 1 goto node_manual
winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
if errorlevel 1 goto node_manual
rem winget 装的 node 通常不在当前 PATH，先补上再校验
set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo [dsh-passwords] Node.js 已安装但当前终端看不到，请新开一个终端再运行本脚本。
  exit /b 1
)

:node_ok
for /f "tokens=1 delims=v." %%a in ('node -v') do set "NODE_MAJOR=%%a"
if not defined NODE_MAJOR (
  echo [dsh-passwords] 无法读取 Node.js 版本，请检查安装。
  exit /b 1
)
if %NODE_MAJOR% LSS 22 (
  echo [dsh-passwords] Node.js 版本过低（当前 v%NODE_MAJOR%），需要 22.5+，请升级后重试。
  exit /b 1
)
echo [dsh-passwords] Node.js v%NODE_MAJOR% ✓
goto git_check

:node_manual
echo [dsh-passwords] 无法自动安装 Node.js，请手动安装 22.5+（https://nodejs.org/）后重试。
exit /b 1

:git_check
rem ── 2. git（缺了用 winget 自动装） ──
where git >nul 2>nul
if not errorlevel 1 goto git_ok
echo [dsh-passwords] 未找到 git，正在自动安装…
where winget >nul 2>nul
if errorlevel 1 goto git_manual
winget install Git.Git --accept-source-agreements --accept-package-agreements
if errorlevel 1 goto git_manual
set "PATH=%ProgramFiles%\Git\cmd;%PATH%"
where git >nul 2>nul
if errorlevel 1 (
  echo [dsh-passwords] git 已安装但当前终端看不到，请新开一个终端再运行本脚本。
  exit /b 1
)

:git_ok
echo [dsh-passwords] git ✓
goto dsh_check

:git_manual
echo [dsh-passwords] 无法自动安装 git，请手动安装（https://git-scm.com/download/win）后重试。
exit /b 1

:dsh_check
rem ── 3. dsh（DeepSeek Harness，缺了自动装） ──
where dsh >nul 2>nul
if not errorlevel 1 goto dsh_ok
echo [dsh-passwords] 未找到 dsh（DeepSeek Harness），正在自动安装…
rem dsh 依赖原生构建，npm 新版会拦截脚本，先放行再装
call npm config set allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs --location=user
call npm install -g @deepseek-ai/dsh
if errorlevel 1 goto dsh_manual
where dsh >nul 2>nul
if errorlevel 1 (
  echo [dsh-passwords] dsh 已安装但当前终端看不到，请新开一个终端再运行本脚本。
  exit /b 1
)

:dsh_ok
echo [dsh-passwords] dsh ✓
goto prepare_dest

:dsh_manual
echo [dsh-passwords] dsh 自动安装失败，请手动执行：npm install -g @deepseek-ai/dsh
echo [dsh-passwords] 然后用 DEEPSEEK_API_KEY=sk-你的key dsh web 先跑一次确认能用，再重跑本脚本。
exit /b 1

:prepare_dest
rem ── 4. 安装目录（DSH_PASSWORDS_DIR 可自定义） ──
set "DEST=%USERPROFILE%\dsh-passwords"
if defined DSH_PASSWORDS_DIR set "DEST=%DSH_PASSWORDS_DIR%"
if exist "%DEST%" (
  echo [dsh-passwords] 目标目录已存在：%DEST%
  echo [dsh-passwords] 重装请先手动删除该目录（注意备份里面的 .env 和 data\）。
  exit /b 1
)

rem ── 5. 下载项目 + 执行安装 ──
echo [dsh-passwords] 下载项目到 %DEST% …
git clone --depth 1 https://github.com/slywalker2006/dsh-passwords.git "%DEST%"
if errorlevel 1 (
  echo [dsh-passwords] 项目下载失败，请检查网络后重试。
  exit /b 1
)
cd /d "%DEST%"
set "SCRIPT_DIR=%CD%\"

:run
rem 实际安装逻辑（装依赖 / 编译 / 生成 SETUP_KEY / 注册插件 / 应用补丁）
echo [dsh-passwords] 开始安装：装依赖 → 编译 → 生成 SETUP_KEY → 注册插件 → 应用补丁…
node "%SCRIPT_DIR%scripts\install.mjs"
if errorlevel 1 exit /b %errorlevel%

echo.
echo [dsh-passwords] 安装完成！
echo [dsh-passwords] 首次配置密钥（SETUP_KEY）见上方输出；也保存在：
echo [dsh-passwords]   %SCRIPT_DIR%setup-key.txt（首次配置成功后自动删除）
echo [dsh-passwords] 接下来：启动 dsh（dsh web）→ 浏览器打开 https://服务器IP.sslip.io
echo [dsh-passwords]   → 输入 SETUP_KEY 创建主用户，之后所有人访问都先过登录页。
exit /b 0