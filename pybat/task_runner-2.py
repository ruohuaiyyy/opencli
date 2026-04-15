"""
Task Runner - 完整任务处理脚本
流程：拉取任务 -> 上报开始 -> 执行命令 -> 发送回调 -> 上报结果
"""

import argparse
import json
import logging
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)

TASK_CENTER_URL = os.environ.get(
    "TASK_CENTER_URL",
    "http://openclawtaskcenter.beta.qunar.com",
)
WORKER_ID = os.environ.get("WORKER_ID", "lqxCopaw")
TASK_TYPE = os.environ.get("TASK_TYPE", "default")
PULL_INTERVAL = int(os.environ.get("PULL_INTERVAL", "10"))
EXECUTE_INTERVAL = int(os.environ.get("EXECUTE_INTERVAL", "120"))
HTTP_TIMEOUT = 30
COMMAND_TIMEOUT = int(os.environ.get("COMMAND_TIMEOUT", "300"))
MAX_CONSECUTIVE_FAILURES = 2 

def _get(url: str, params: dict | None = None) -> dict:
    resp = requests.get(url, params=params, timeout=HTTP_TIMEOUT)
    resp.raise_for_status()
    return resp.json()


def _post_json(url: str, data: dict) -> dict:
    resp = requests.post(url, json=data, timeout=HTTP_TIMEOUT)
    resp.raise_for_status()
    return resp.json()


# ---------- Task Center API ----------


def pull_task(worker_id: str, task_type: str) -> Optional[dict]:
    """拉取待执行任务，无任务时返回 None"""
    result = _get(
        f"{TASK_CENTER_URL}/api/tasks/pull",
        {"workerId": worker_id, "type": task_type},
    )
    if result and isinstance(result, dict) and result.get("status") == "assigned":
        return result
    return None


def report_start(task_id: str, worker_id: str) -> None:
    _get(f"{TASK_CENTER_URL}/api/tasks/{task_id}/start")
    log.info("Task started: %s", task_id)


def report_result(task_id: str, status: int, worker_id: str) -> None:
    _get(
        f"{TASK_CENTER_URL}/api/tasks/{task_id}/result",
        {"status": status, "workerId": worker_id},
    )
    log.info("Task result reported: task=%s, status=%s", task_id, status)


# ---------- Prompt Parsing ----------


def parse_prompt(prompt: str) -> tuple[str, dict]:
    """
    从 prompt 中提取执行命令和回调配置。
    返回 (command, callback_config)
    """
    # 提取末尾的 JSON 配置块（最后一个独立的 JSON 对象）
    json_match = re.search(r"\{[^{}]*\"type\"\s*:\s*\"[^\"]+\"[^{}]*\}", prompt)
    callback_config = {}
    if json_match:
        try:
            callback_config = json.loads(json_match.group())
        except json.JSONDecodeError:
            log.error("Failed to parse callback config from prompt")

    # 命令是 prompt 中 JSON 配置块之前的部分
    command_section = prompt[: json_match.start()].strip() if json_match else prompt

    # 从自然语言描述中提取真实命令
    # 匹配 "执行命令 xxx" 模式，提取 xxx 部分
    cmd_match = re.search(r"执行命令\s+(.+?)\s+(?:生成结果文件|；|;)", command_section)
    if cmd_match:
        command = cmd_match.group(1).strip()
    else:
        # 兜底：取分号前第一句
        command = command_section.split(";")[0].split("；")[0].strip()

    return command, callback_config


# ---------- Command Execution ----------


def run_command(command: str) -> Optional[str]:
    """
    执行命令，返回输出 JSON 文件路径。
    命令执行后应生成一个 JSON 文件，返回该文件路径。
    """
    log.info("Executing command: %s", command)
    result = subprocess.run(
        command,
        shell=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=COMMAND_TIMEOUT,
    )

    if result.stdout:
        log.info("Command stdout: %s", result.stdout[:500])
    if result.stderr:
        log.info("Command stderr: %s", result.stderr[:500])

    # 从 stdout 中提取 JSON 文件路径（opencli 输出格式：💾 Saved to <path>）
    path_match = re.search(r"Saved to\s+(.+\.json)", result.stdout)
    if path_match:
        file_path = path_match.group(1).strip()
        if Path(file_path).exists():
            log.info("Result file found: %s", file_path)
            return file_path

    # 如果命令成功但没输出文件路径，尝试从输出中找 JSON 内容
    if result.returncode == 0:
        # 尝试从 stdout 中解析 JSON 数组/对象
        json_match = re.search(r"(\[[\s\S]*\]|\{[\s\S]*\})", result.stdout)
        if json_match:
            return json_match.group(1)

    if result.returncode != 0:
        raise RuntimeError(
            f"Command failed with code {result.returncode}: {result.stderr}"
        )

    return None


# ---------- Callback ----------


def send_callback(callback_url: str, task_id: str, result_data) -> dict:
    """发送回调请求"""
    payload = {
        "taskId": task_id,
        "type": "analysis",
        "status": "completed",
        "result": result_data,
    }

    log.info("Sending callback to: %s", callback_url)
    resp = _post_json(callback_url, payload)
    log.info("Callback response: %s", resp)
    return resp


def load_result_file(file_path: str):
    """从 JSON 文件加载结果数据"""
    with open(file_path, "r", encoding="utf-8") as f:
        return json.load(f)


# ---------- Main Loop ----------


def process_task(task: dict) -> bool:
    """处理单个任务，返回是否成功"""
    task_id = task["id"]
    prompt = task.get("prompt", "")

    try:
        command, callback_config = parse_prompt(prompt)
        log.info("Parsed command: %s", command)
        log.info("Callback config: %s", callback_config)

        callback_url = callback_config.get("url", "")
        callback_task_id = callback_config.get("taskId", task_id)

        # 执行命令
        result_ref = run_command(command)

        # 解析结果
        if result_ref and Path(result_ref).exists():
            result_data = load_result_file(result_ref)
        elif result_ref and isinstance(result_ref, str):
            result_data = json.loads(result_ref)
        else:
            result_data = []

        # 检查是否有有效的 references
        has_empty_references = check_references_empty(result_data)

        # 根据是否有有效结果决定回调状态
        if has_empty_references:
            # 没有有效的 references，回调状态为 failed
            callback_payload = {
                "taskId": callback_task_id,
                "type": "analysis",
                "status": "failed",
                "result": result_data
            }
            success = False
        else:
            # 有有效的 references，正常回调
            callback_payload = {
                "taskId": callback_task_id,
                "type": "analysis",
                "status": "completed",
                "result": result_data
            }
            success = True

        # 发送回调
        if callback_url:
            log.info("Sending callback to: %s, status: %s", callback_url, callback_payload["status"])
            resp = _post_json(callback_url, callback_payload)
            log.info("Callback response: %s", resp)

        return success

    except Exception as e:
        log.error("Task processing failed: %s", str(e))
        return False


def check_references_empty(result_data) -> bool:
    """
    检查结果数据中是否存在有效的 references。
    返回 True 表示没有有效的 references（需要标记失败），False 表示有有效的 references。
    
    有效 references 的定义：
    - 存在 references 字段
    - references 是非空列表（长度 > 0）
    """
    if not result_data:
        return True
    
    # 处理列表格式
    if isinstance(result_data, list):
        for item in result_data:
            if isinstance(item, dict):
                # 检查是否存在 references 字段且非空
                references = item.get("references")
                if references is not None and isinstance(references, list) and len(references) > 0:
                    return False  # 找到有效的 references
        return True  # 没有找到有效的 references
    
    # 处理字典格式
    elif isinstance(result_data, dict):
        references = result_data.get("references")
        if references is not None and isinstance(references, list) and len(references) > 0:
            return False  # 找到有效的 references
        return True  # 没有 references 字段或为空
    
    return True


def run_loop(worker_id: str, task_type: str) -> None:
    """主循环：持续拉取并处理任务"""
    log.info("Task runner started, worker=%s, type=%s", worker_id, task_type)
    
    consecutive_failures = 0  # 连续失败计数器

    while True:
        try:
            task = pull_task(worker_id, task_type)
            if not task:
                time.sleep(PULL_INTERVAL)
                consecutive_failures = 0  # 无任务时重置计数器
                continue

            task_id = task["id"]
            log.info("Got task: %s (%s)", task_id, task.get("name", ""))

            report_start(task_id, worker_id)

            success = process_task(task)

            # 上报结果（status: 1=成功, 0=失败）
            report_result(task_id, status=1 if success else 0, worker_id=worker_id)
            
            # 更新连续失败计数器
            if success:
                consecutive_failures = 0
                log.info("Task completed successfully: %s", task_id)
            else:
                consecutive_failures += 1
                log.warning("Task failed: %s, consecutive failures: %d/%d", 
                           task_id, consecutive_failures, MAX_CONSECUTIVE_FAILURES)
            
            # 检查是否达到最大连续失败次数
            if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                log.error("Reached max consecutive failures (%d), stopping task runner", 
                         MAX_CONSECUTIVE_FAILURES)
                # break
            
            time.sleep(EXECUTE_INTERVAL)

        except requests.RequestException as e:
            log.error("Network error in task loop: %s", str(e))
            time.sleep(PULL_INTERVAL)
            consecutive_failures = 0  # 网络错误重置计数器（可选，根据需求调整）
        except Exception as e:
            log.error("Unexpected error in task loop: %s", str(e))
            time.sleep(PULL_INTERVAL)
            consecutive_failures = 0  # 异常重置计数器（可选，根据需求调整）
    
    log.info("Task runner stopped")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Task Runner - 完整任务处理脚本")
    parser.add_argument("worker_id", nargs="?", default=None, help="Worker ID (可选)")
    parser.add_argument("--type", default=TASK_TYPE, help="任务类型 (默认: default)")
    args = parser.parse_args()

    worker = args.worker_id or WORKER_ID
    run_loop(worker, args.type)
