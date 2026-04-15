#!/bin/bash
clear
cd "$(dirname "$0")" || exit 1

# 你的 Python 路径
PYTHON="/usr/local/bin/python3"
# 你的脚本绝对路径
SCRIPT_FILE="/Users/qixin/Desktop/work/task_runner-2.py"
# 获取当前用户名
IDENTIFIER="$USER"


check_process() {
  pgrep -f "$1" >/dev/null 2>&1
}

if ! check_process "opencli-analysis-qwen"; then
  nohup "$PYTHON" "$SCRIPT_FILE" IDENTIFIER --type opencli-analysis-qwen > nohup_qwen.log 2>&1 &
fi

if ! check_process "opencli-analysis-deepseek"; then
  nohup "$PYTHON" "$SCRIPT_FILE" IDENTIFIER --type opencli-analysis-deepseek > nohup_deepseek.log 2>&1 &
fi

if ! check_process "opencli-analysis-yuanbao"; then
  nohup "$PYTHON" "$SCRIPT_FILE" IDENTIFIER --type opencli-analysis-yuanbao > nohup_yuanbao.log 2>&1 &
fi

if ! check_process "opencli-analysis-doubao"; then
  nohup "$PYTHON" "$SCRIPT_FILE" IDENTIFIER --type opencli-analysis-doubao > nohup_doubao.log 2>&1 &
fi

echo "✅ 全部启动完成！"