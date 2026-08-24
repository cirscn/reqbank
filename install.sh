#!/usr/bin/env bash
# harness-kit 安装脚本
# 用法（二选一）：
#   curl -fsSL <raw-url>/install.sh | bash
#   bash install.sh [--agents codex,claude] [--repo /path/to/repo]
set -euo pipefail

AGENTS="${HARNESS_AGENTS:-codex}"
REPO=""
KIT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agents) AGENTS="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --kit-dir) KIT_DIR="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$REPO" ]]; then
  REPO=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
fi

# 定位 kit 本体：本地目录优先；curl 场景下载 release tarball
if [[ -z "$KIT_DIR" ]]; then
  SCRIPT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -f "$SCRIPT_SRC/bin/harness.mjs" ]]; then
    KIT_DIR="$SCRIPT_SRC"
  fi
fi
if [[ -z "$KIT_DIR" ]]; then
  KIT_RAW_URL="${HARNESS_KIT_URL:-https://github.com/cirscn/harness-kit}"
  TMP=$(mktemp -d)
  echo "[reqbank] downloading kit from $KIT_RAW_URL"
  git clone --depth 1 -q "$KIT_RAW_URL.git" "$TMP/harness-kit"
  KIT_DIR="$TMP/harness-kit"
fi

echo "[reqbank] target repo: $REPO"

mkdir -p "$REPO/.harness"
cp -R "$KIT_DIR/engine" "$REPO/.harness/"
cp -R "$KIT_DIR/templates" "$REPO/.harness/"
mkdir -p "$REPO/.harness/bin" "$REPO/.harness/scripts"
cp "$KIT_DIR/bin/harness.mjs" "$REPO/.harness/bin/"
[[ -f "$KIT_DIR/VERSION" ]] && cp "$KIT_DIR/VERSION" "$REPO/.harness/"
[[ -f "$KIT_DIR/scripts/smoke.mjs" ]] && cp "$KIT_DIR/scripts/smoke.mjs" "$REPO/.harness/scripts/"

# init 必须落在目标仓库：显式锚定根目录，防止在调用者 cwd 误建脚手架
export HARNESS_PROJECT_ROOT="$REPO"
cd "$REPO"
node .harness/bin/harness.mjs init --agents "$AGENTS"

cat <<'NEXT'

安装完成。三步开始：
  1. 填充 .agentdoc/harness/global/index.md（命中范围 + 标签）
  2. 沉淀第一条需求：在 modules/<模块名>/{index,requirements,tests}.md 记录契约与验证命令
  3. 验证召回：node .harness/bin/harness.mjs scope "你的任务描述"

钩子已按所选 agent 注册。会话中 Agent 会自动收到 REQ/TC 召回；
确定性冲突会被 Stop 拦截，其余只记审计日志。
NEXT
