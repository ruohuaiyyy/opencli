"""
Task Runner - 完整任务处理脚本
流程：拉取任务 -> 上报开始 -> 执行命令 -> 发送回调 -> 上报结果

支持每 N 条任务后重启 Chrome 并切换 Doubao 账号。
"""

import argparse
import json
import logging
import os
import re
import shutil
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

# ---------- Doubao Account & Chrome Profile ----------

ACCOUNTS_FILE = Path.home() / ".opencli" / "accounts" / "doubao.json"
STATE_FILE = Path.home() / ".opencli" / "accounts" / "doubao-task-state.json"
PROFILES_DIR = Path.home() / ".opencli" / "profiles"


def get_doubao_accounts() -> list[str]:
    """从 doubao.json 读取账号名列表"""
    try:
        if ACCOUNTS_FILE.exists():
            data = json.loads(ACCOUNTS_FILE.read_text(encoding="utf-8"))
            accounts = data.get("accounts", {})
            if isinstance(accounts, dict) and accounts:
                return list(accounts.keys())
        # 兜底：读取旧格式或空配置
        return ["default"]
    except Exception as e:
        log.warning("Failed to read doubao accounts: %s, using 'default'", e)
        return ["default"]


def load_state() -> dict:
    """加载轮换状态，无状态文件时返回初始值"""
    try:
        if STATE_FILE.exists():
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {
        "accountIndex": 0,
        "taskCountSinceRestart": 0,
    }


def save_state(state: dict) -> None:
    """持久化轮换状态"""
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(
            json.dumps({**state, "lastUpdated": time.strftime("%Y-%m-%dT%H:%M:%S")}, indent=2),
            encoding="utf-8",
        )
    except Exception as e:
        log.warning("Failed to save task state: %s", e)


def find_chrome_exe() -> Path:
    """查找 Chrome 可执行文件路径"""
    # 优先用 PATH 中的 chrome
    chrome_in_path = shutil.which("chrome")
    if chrome_in_path:
        return Path(chrome_in_path)

    # 常见 Windows 安装路径
    for path in [
        Path(os.environ.get("PROGRAMFILES", "C:\\Program Files"))
        / "Google" / "Chrome" / "Application" / "chrome.exe",
        Path(os.environ.get("PROGRAMFILES(X86)", "C:\\Program Files (x86)"))
        / "Google" / "Chrome" / "Application" / "chrome.exe",
        Path(os.environ.get("LOCALAPPDATA", "C:\\Users")
        / os.environ.get("USERNAME", "default")[:8]  # truncated username fallback
        / "AppData" / "Local" / "Google" / "Chrome" / "Application" / "chrome.exe"),
    ]:
        if path.exists():
            return path

    raise RuntimeError("Chrome executable not found in PATH or common install locations")


def restart_chrome(account: str) -> None:
    """杀掉当前 Chrome 进程，并用指定账号的 profile 重新启动（headless）"""
    log.info("Restarting Chrome with account: %s", account)

    # 1. 杀掉 Chrome
    try:
        subprocess.run(
            ["taskkill", "/f", "/im", "chrome.exe"],
            capture_output=True,
            timeout=10,
        )
    except Exception as e:
        log.warning("taskkill returned non-zero or timed out: %s", e)

    time.sleep(2)

    # 2. 用新 profile 启动 Chrome（headless）
    profile_dir = PROFILES_DIR / account
    profile_dir.mkdir(parents=True, exist_ok=True)

    # chrome_exe = find_chrome_exe()

    try:
        subprocess.Popen(
            [
                # str(chrome_exe),
                "chrome",
                f"--user-data-dir={profile_dir}",
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
        )
    except Exception as e:
        log.error("Failed to start Chrome: %s", e)
        raise

    # 等待 Chrome 完全启动
    time.sleep(5)
    log.info("Chrome started with profile: %s (dir: %s)", account, profile_dir)


# ---------- HTTP Helpers ----------


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

    path_match = re.search(r"Saved to\s+(.+\.json)", result.stderr)
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


def load_result_file(file_path: str):
    """从 JSON 文件加载结果数据"""
    with open(file_path, "r", encoding="utf-8") as f:
        return json.load(f)


# ---------- Main Loop ----------


def process_task(task: dict, worker_id: str, account: str) -> bool:
    """处理单个任务，返回是否成功"""
    task_id = task["id"]
    prompt = task.get("prompt", "")

    try:
        command, callback_config = parse_prompt(prompt)
        log.info("Parsed command: %s", command)
        log.info("Callback config: %s", callback_config)

        # 追加 --account 参数（如果命令中还没有的话）
        if "--account" not in command:
            command = f"{command.rstrip()} --account {account}"

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
                "result": result_data,
                "workerId": worker_id,
            }
            success = False
        else:
            # 有有效的 references，正常回调
            callback_payload = {
                "taskId": callback_task_id,
                "type": "analysis",
                "status": "completed",
                "result": result_data,
                "workerId": worker_id,
            }
            success = True

        # 发送回调
        if callback_url:
            log.info(
                "Sending callback to: %s, status: %s",
                callback_url,
                callback_payload["status"],
            )
            resp = _post_json(callback_url, callback_payload)
            log.info("Callback response: %s", resp)

        return success

    except Exception as e:
        log.error("Task processing failed: %s", str(e))
        return False


def check_references_empty(result_data) -> bool:
    """
    检查结果数据中是否存在有效的 references。
    返回 True 表示没有有效的 references（需要标记失败），
    False 表示有有效的 references。
    """
    if not result_data:
        return True

    if isinstance(result_data, list):
        for item in result_data:
            if isinstance(item, dict):
                references = item.get("references")
                if references is not None and isinstance(references, list) and len(references) > 0:
                    return False
        return True

    elif isinstance(result_data, dict):
        references = result_data.get("references")
        if references is not None and isinstance(references, list) and len(references) > 0:
            return False
        return True

    return True


def run_loop(worker_id: str, task_type: str, restart_after: int) -> None:
    """主循环：持续拉取并处理任务"""
    accounts = get_doubao_accounts()
    if not accounts:
        accounts = ["default"]
    log.info(
        "Task runner started, worker=%s, type=%s, restart_after=%d, accounts=%s",
        worker_id,
        task_type,
        restart_after,
        accounts,
    )

    # 加载轮换状态
    state = load_state()
    account_index = state.get("accountIndex", 0) % len(accounts)
    task_count_since_restart = state.get("taskCountSinceRestart", 0)
    current_account = accounts[account_index]

    log.info(
        "Resuming state: accountIndex=%d, taskCountSinceRestart=%d, currentAccount=%s",
        account_index,
        task_count_since_restart,
        current_account,
    )

    # 初始启动 Chrome（确保第一次执行前 Chrome 已运行）
    restart_chrome(current_account)

    consecutive_failures = 0

    while True:
        try:
            # ---------- 检查是否需要切换账号 ----------
            if task_count_since_restart > 0 and task_count_since_restart % restart_after == 0:
                account_index = (account_index + 1) % len(accounts)
                current_account = accounts[account_index]
                task_count_since_restart = 0

                log.info(
                    "[Account Switch] Task #%d reached, switching to account: %s (index %d/%d)",
                    restart_after,
                    current_account,
                    account_index,
                    len(accounts),
                )

                restart_chrome(current_account)

                # 保存状态
                save_state({
                    "accountIndex": account_index,
                    "taskCountSinceRestart": task_count_since_restart,
                })

            task = pull_task(worker_id, task_type)
            if not task:
                time.sleep(PULL_INTERVAL)
                consecutive_failures = 0
                continue

            task_id = task["id"]
            log.info(
                "Got task: %s (%s) [account=%s, #%d since restart]",
                task_id,
                task.get("name", ""),
                current_account,
                task_count_since_restart,
            )

            report_start(task_id, worker_id)

            success = process_task(task, worker_id, current_account)

            # 上报结果（status: 1=成功, 0=失败）
            report_result(task_id, status=1 if success else 0, worker_id=worker_id)

            # 更新计数器和状态
            task_count_since_restart += 1
            save_state({
                "accountIndex": account_index,
                "taskCountSinceRestart": task_count_since_restart,
            })

            if success:
                consecutive_failures = 0
                log.info("Task completed successfully: %s", task_id)
            else:
                consecutive_failures += 1
                log.warning(
                    "Task failed: %s, consecutive failures: %d/%d",
                    task_id,
                    consecutive_failures,
                    MAX_CONSECUTIVE_FAILURES,
                )

            # 检查是否达到最大连续失败次数
            if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                log.error(
                    "Reached max consecutive failures (%d), stopping task runner",
                    MAX_CONSECUTIVE_FAILURES,
                )
                # break  # 暂时不停止，持续运行

            time.sleep(EXECUTE_INTERVAL)

        except requests.RequestException as e:
            log.error("Network error in task loop: %s", str(e))
            time.sleep(PULL_INTERVAL)
            consecutive_failures = 0
        except Exception as e:
            log.error("Unexpected error in task loop: %s", str(e))
            time.sleep(PULL_INTERVAL)

    log.info("Task runner stopped")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Task Runner - 完整任务处理脚本")
    parser.add_argument("worker_id", nargs="?", default=None, help="Worker ID (可选)")
    parser.add_argument("--type", default=TASK_TYPE, help="任务类型 (默认: default)")
    parser.add_argument(
        "--restart-after",
        type=int,
        default=20,
        help="每执行多少条任务后重启 Chrome 并切换账号 (默认: 20)",
    )
    args = parser.parse_args()

    worker = args.worker_id or WORKER_ID
    run_loop(worker, args.type, args.restart_after)
