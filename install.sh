#!/usr/bin/env bash
# dsh-passwords 一键安装（Linux/macOS 引导壳；实际逻辑在 scripts/install.mjs）
#
# 用法（二选一）:
#   1) curl 直接装:  curl -fsSL https://raw.githubusercontent.com/slywalker2006/dsh-passwords/main/install.sh | bash
#   2) 先 clone 再装: git clone https://github.com/slywalker2006/dsh-passwords && cd dsh-passwords && bash install.sh
# Windows 用户请运行 install.bat。
set -euo pipefail

# 从任意 cwd 执行已 clone 的 install.sh 都应找到脚本自身所在目录。
# curl | bash 时 BASH_SOURCE 不是落盘文件，不能误把调用 cwd 当成项目目录，必须走 clone 分支。
SCRIPT_SOURCE="${BASH_SOURCE[0]:-$0}"
if [ -f "$SCRIPT_SOURCE" ]; then
  SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$SCRIPT_SOURCE")" && pwd)"
  if [ -f "$SCRIPT_DIR/scripts/install.mjs" ]; then
    exec node "$SCRIPT_DIR/scripts/install.mjs"
  fi
fi

command -v node >/dev/null 2>&1 || { echo "[dsh-passwords] 未找到 Node.js（需要 22.5+），请先安装"; exit 1; }
command -v git  >/dev/null 2>&1 || { echo "[dsh-passwords] 未找到 git，请先安装（apt-get install -y git）"; exit 1; }

if [ "$(id -u)" = "0" ]; then
  DEST="${DSH_PASSWORDS_DIR:-/opt/dsh-passwords}"
else
  DEST="${DSH_PASSWORDS_DIR:-$HOME/dsh-passwords}"
fi
if [ -d "$DEST" ]; then
  echo "[dsh-passwords] 目录已存在：$DEST（重装请先手动删除，注意备份 .env 和 data/）"
  exit 1
fi
git clone --depth 1 https://github.com/slywalker2006/dsh-passwords.git "$DEST"
cd "$DEST"
exec node scripts/install.mjs
