# -*- coding: utf-8 -*-
"""
Task Runner - 文章发布任务处理脚本（支持多账号+冷却时间）
流程：拉取任务 -> 上报开始 -> 执行命令 -> 发送回调 -> 上报结果

支持多进程协调：
- 只有主导任务能触发 Chrome 切换
- 非主导任务在切换期间禁止拉取新任务（防止主进程饥饿）
- 账号冷却逻辑：每个账号发布后需等待 N 小时才能再次使用
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
from typing import Optional, Tuple, List, Dict
import requests

# 导入协调模块
from coordinator import (
    init_shared_dir,
    register_worker,
    update_status,
    WorkerStatus,
    request_switch,
    wait_for_switch_complete,
    finish_switch,
    all_workers_idle,
    set_restart_chrome_func,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)

# 配置
TASK_CENTER_URL = os.environ.get(
    "TASK_CENTER_URL",
    "http://openclawtaskcenter.beta.qunar.com",
)
WORKER_ID = os.environ.get("WORKER_ID", "lqxCopaw")
TASK_TYPE = os.environ.get("TASK_TYPE", "default")
PULL_INTERVAL = int(os.environ.get("PULL_INTERVAL", "5"))
EXECUTE_INTERVAL = int(os.environ.get("EXECUTE_INTERVAL", "600"))
HTTP_TIMEOUT = 30
COMMAND_TIMEOUT = int(os.environ.get("COMMAND_TIMEOUT", "300"))
MAX_CONSECUTIVE_FAILURES = 2

# 账号文件路径
ACCOUNTS_FILE = Path.home() / ".opencli" / "accounts" / "toutiao.json"
PROFILES_DIR = Path.home() / ".opencli" / "profiles"


def _get(url: str, params: dict | None = None) -> dict:
    resp = requests.get(url, params=params, timeout=HTTP_TIMEOUT)
    resp.raise_for_status()
    return resp.json()


def _post_json(url: str, data: dict) -> dict:
    resp = requests.post(url, json=data, timeout=HTTP_TIMEOUT)
    resp.raise_for_status()
    return resp.json()


# ---------- 账号管理 ----------

def get_toutiao_accounts() -> List[str]:
    """从 toutiao.json 读取账号名列表（排除 default）"""
    try:
        if ACCOUNTS_FILE.exists():
            data = json.loads(ACCOUNTS_FILE.read_text(encoding="utf-8"))
            accounts = data.get("accounts", {})
            if isinstance(accounts, dict) and accounts:
                return [k for k in accounts.keys() if k != "default"]
        return []
    except Exception as e:
        log.warning("Failed to read toutiao accounts: %s, using empty list", e)
        return []


def get_account_last_publish_time(account: str) -> int:
    """获取账号上次发布时间（时间戳，毫秒）"""
    try:
        if ACCOUNTS_FILE.exists():
            data = json.loads(ACCOUNTS_FILE.read_text(encoding="utf-8"))
            accounts = data.get("accounts", {})
            if isinstance(accounts, dict) and account in accounts:
                return accounts[account].get("lastPublishTime", 0)
        return 0
    except Exception as e:
        log.warning("Failed to read lastPublishTime for %s: %s", account, e)
        return 0


def is_account_cooled(account: str, cooldown_hours: float) -> bool:
    """
    判断账号是否冷却到期

    参数:
        account: 账号名
        cooldown_hours: 冷却小时数

    返回:
        True = 冷却已到期可以使用, False = 还在冷却中
    """
    last_time_ms = get_account_last_publish_time(account)
    if last_time_ms == 0:
        # 没有记录，视为已冷却
        return True

    last_time_sec = last_time_ms / 1000
    elapsed_hours = (time.time() - last_time_sec) / 3600
    cooled = elapsed_hours >= cooldown_hours

    log.info(
        "Account %s: elapsed=%.2f hours, cooldown=%s hours, cooled=%s",
        account, elapsed_hours, cooldown_hours, cooled
    )
    return cooled


def find_available_account(
    accounts: List[str], current_account: str, cooldown_hours: float
) -> Tuple[Optional[str], bool]:
    """
    查找可用的账号

    参数:
        accounts: 所有账号列表
        current_account: 当前账号
        cooldown_hours: 冷却小时数

    返回:
        (available_account, should_switch)
        - available_account: 可用账号，如果都冷却则返回 None
        - should_switch: 是否需要切换账号
    """
    if not accounts:
        return None, False

    # 优先使用当前账号
    if current_account and current_account in accounts:
        if is_account_cooled(current_account, cooldown_hours):
            return current_account, False

    # 当前账号不可用，遍历找冷却到期的
    for account in accounts:
        if account != current_account and is_account_cooled(account, cooldown_hours):
            return account, True

    # 所有账号都在冷却中
    return None, False


# ---------- 状态管理 ----------

def get_state_file(task_type: str) -> Path:
    """获取指定 task_type 的状态文件路径"""
    base = Path.home() / ".opencli" / "accounts"
    return base / f"toutiao-publish-state-{task_type}.json"


def load_state(task_type: str) -> Dict:
    """加载指定 task_type 的轮换状态"""
    state_file = get_state_file(task_type)
    try:
        if state_file.exists():
            return json.loads(state_file.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {"accountIndex": 0, "taskCountSinceRestart": 0}


def save_state(task_type: str, state: Dict) -> None:
    """保存指定 task_type 的轮换状态"""
    state_file = get_state_file(task_type)
    try:
        state_file.parent.mkdir(parents=True, exist_ok=True)
        state_file.write_text(
            json.dumps({**state, "lastUpdated": time.strftime("%Y-%m-%dT%H:%M:%S")}, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception as e:
        log.warning("Failed to save task state: %s", e)


# ---------- Chrome 管理 ----------

def restart_chrome(account: str) -> None:
    """重启 Chrome（杀掉并重新启动）"""
    log.info("Restarting Chrome with account: %s", account)
    try:
        subprocess.run(["taskkill", "/f", "/im", "chrome.exe"], capture_output=True, timeout=10)
    except Exception as e:
        log.warning("taskkill returned non-zero or timed out: %s", e)
    time.sleep(2)

    profile_dir = PROFILES_DIR / account
    profile_dir.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.Popen(
            ["chrome", f"--user-data-dir={profile_dir}",
             "--disable-background-timer-throttling",
             "--disable-backgrounding-occluded-windows",
             "--disable-renderer-backgrounding"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
        )
    except Exception as e:
        log.error("Failed to start Chrome: %s", e)
        raise
    time.sleep(5)
    log.info("Chrome started with profile: %s", account)


def coordinated_restart_chrome(worker_id: str, task_type: str, account: str) -> bool:
    """协调版本的 Chrome 重启"""
    log.info("[%s_%s] Requesting Chrome switch...", worker_id, task_type)

    if not request_switch(worker_id, task_type):
        log.info("[%s_%s] Not leader or switch already pending", worker_id, task_type)
        return False

    log.info("[%s_%s] Executing Chrome restart...", worker_id, task_type)
    restart_chrome(account)
    finish_switch(worker_id, task_type, account)
    log.info("[%s_%s] Chrome switch completed", worker_id, task_type)
    return True


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

def get_temp_content_file() -> str:
    """创建临时文件存储 content 内容，返回文件路径"""
    temp_dir = Path.home() / ".opencli" / "temp"
    temp_dir.mkdir(parents=True, exist_ok=True)
    return str(temp_dir / f"content_{uuid.uuid4().hex[:8]}.txt")


import uuid


def parse_prompt(prompt: str) -> Tuple[str, dict, list]:
    """
    从 prompt 中提取执行命令和回调配置。
    返回 (command, callback_config, temp_files_to_cleanup)
    """
    json_match = re.search(r"\{[^{}]*\"type\"\s*:\s*\"[^\"]+\"[^{}]*\}", prompt)
    callback_config = {}
    temp_files = []

    if json_match:
        try:
            callback_config = json.loads(json_match.group())
        except json.JSONDecodeError:
            log.error("Failed to parse callback config from prompt")

    command_section = prompt[: json_match.start()].strip() if json_match else prompt

    cmd_match = re.search(r"执行命令\s+(.*?)\s+生成结果文件", command_section, re.DOTALL)
    if cmd_match:
        command = cmd_match.group(1).strip()

        content_start_match = re.search(r'--content\s+"', command)
        if content_start_match:
            content_start = content_start_match.end() - 1

            end_pattern = r'"\s+(?=--cover|\s*生成结果文件)'
            end_match = re.search(end_pattern, command[content_start + 1:])

            if end_match:
                content_inner = command[content_start + 1: content_start + 1 + end_match.start()]

                if '\n' in content_inner:
                    temp_file = get_temp_content_file()
                    Path(temp_file).write_text(content_inner, encoding='utf-8')
                    temp_files.append(temp_file)

                    before_content = command[:content_start_match.start()]
                    after_content = command[content_start + 1 + end_match.start() + 1:]
                    command = f'{before_content}--content-file "{temp_file}"{after_content}'
        else:
            command = command.split(";")[0].split("；")[0].strip()
    else:
        command = command_section.split(";")[0].split("；")[0].strip()

    return command, callback_config, temp_files


# ---------- Command Execution ----------

def run_command(command: str) -> Optional[str]:
    """执行命令，返回输出 JSON 文件路径"""
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

    # 对于 publish 类命令，解析 stdout 中的状态
    stdout = result.stdout or ""
    stderr = result.stderr or ""
    combined = stdout + stderr
    if "toutiao publish" in command or "xhs publish" in command:
        if "⚠️ 操作完成，请在浏览器中确认" in combined:
            log.info("Publish command succeeded (操作完成)")
            return "PUBLISH_SUCCESS"
        if "✗" in combined or "失败" in combined or "error" in combined.lower():
            log.error("Publish command failed")
            raise RuntimeError(f"Publish command failed: {combined[:500]}")

    if result.returncode != 0:
        raise RuntimeError(
            f"Command failed with code {result.returncode}: {result.stderr}"
        )

    # 命令执行成功但没有 JSON 输出，视为成功（如 publish 命令）
    if result.returncode == 0 and not path_match:
        log.info("Command executed successfully (no result file)")
        return "PUBLISH_SUCCESS"

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




def process_task(task: dict, worker_id: str, account: str) -> bool:
    """处理单个任务，返回是否成功"""
    task_id = task["id"]
    prompt = task.get("prompt", "")
    temp_files = []

    try:
        command, callback_config, temp_files = parse_prompt(prompt)
        log.info("Parsed command: %s", command)
        log.info("Callback config: %s", callback_config)

        callback_url = callback_config.get("url", "")
        callback_task_id = callback_config.get("taskId", task_id)

        # 确保命令包含 --account 参数
        if "--account" not in command:
            command = f"{command.rstrip()} --account {account}"
        else:
            # 替换现有账号为当前账号
            command = re.sub(r'--account\s+\S+', f'--account {account}', command)

        result_ref = run_command(command)

        if result_ref == "PUBLISH_SUCCESS":
            # publish 类命令成功执行
            result_data = {"status": "completed", "message": "操作完成"}
        else:
            result_data = {"status": "failed", "message": "操作失败"}


        if result_ref != "PUBLISH_SUCCESS":
            callback_payload = {
                "taskId": callback_task_id,
                "type": "publish",
                "status": "failed",
                "result": result_data,
                "workerId": worker_id,
            }
            success = False
        else:
            callback_payload = {
                "taskId": callback_task_id,
                "type": "publish",
                "status": "completed",
                "result": result_data,
                "workerId": worker_id,
            }
            success = True

        if callback_url:
            log.info("Sending callback to: %s, status: %s", callback_url, callback_payload["status"])
            resp = _post_json(callback_url, callback_payload)
            log.info("Callback response: %s", resp)

        return success

    except Exception as e:
        log.error("Task processing failed: %s", str(e))
        return False
    finally:
        for tf in temp_files:
            try:
                Path(tf).unlink(missing_ok=True)
            except Exception:
                pass


# ---------- 防饥饿检查用锁 ----------
from filelock import FileLock
from contextlib import contextmanager

SHARED_DIR = Path(os.environ.get("TASK_RUNNER_SHARED_DIR", "/tmp/task_runner"))
LOCK_FILE = SHARED_DIR / "coordinator.lock"


@contextmanager
def _lock():
    """跨平台文件锁"""
    lock = FileLock(str(LOCK_FILE), timeout=30)
    lock.acquire()
    try:
        yield
    finally:
        lock.release()


# ---------- Main Loop ----------

def run_loop(worker_id: str, task_type: str, restart_after: int, cooldown_hours: float) -> None:
    """主循环：持续拉取并处理任务"""
    log.info(
        "Task runner started, worker=%s, type=%s, restart_after=%d, cooldown_hours=%.1f",
        worker_id, task_type, restart_after, cooldown_hours
    )

    # 初始化共享目录
    init_shared_dir()

    # 设置重启函数到协调模块
    set_restart_chrome_func(restart_chrome)

    # 注册工作进程，获取是否为主导
    is_leader = register_worker(worker_id, task_type)
    log.info("Worker %s registered, is_leader=%s", worker_id, is_leader)

    accounts = get_toutiao_accounts()
    if not accounts:
        accounts = ["default"]

    state = load_state(task_type)
    account_index = state.get("accountIndex", 0) % len(accounts)
    task_count_since_restart = state.get("taskCountSinceRestart", 0)
    current_account = accounts[account_index]

    log.info(
        "Resuming: accountIndex=%d, taskCountSinceRestart=%d, currentAccount=%s",
        account_index, task_count_since_restart, current_account
    )

    # 仅由 Leader 负责初始启动
    if is_leader:
        log.info("[%s] This worker is the Leader, initializing Chrome.", worker_id)
        restart_chrome(current_account)
    else:
        log.info("[%s] This worker is a Follower, waiting 5s for Leader to start Chrome...", worker_id)
        time.sleep(5)

    consecutive_failures = 0

    while True:
        try:
            # ========== 1. 防止饥饿：拉取前检查切换状态 ==========
            if not is_leader:
                with _lock():
                    from coordinator import _load_state
                    state_check = _load_state()
                    if state_check.get("switch_pending"):
                        log.info(
                            "[%s_%s] Switch pending, waiting for leader to complete...",
                            worker_id, task_type
                        )
                        wait_for_switch_complete(worker_id, task_type, timeout=600)
                        refreshed_state = load_state(task_type)
                        account_index = refreshed_state.get("accountIndex", 0) % len(accounts)
                        current_account = accounts[account_index]
                        log.info("[%s_%s] Reloaded account after switch: %s", worker_id, task_type, current_account)

            # ========== 2. 冷却检查：所有进程拉取前都检查 ==========
            if not is_account_cooled(current_account, cooldown_hours):
                if is_leader:
                    available_account, need_switch = find_available_account(
                        accounts, current_account, cooldown_hours
                    )
                    if need_switch and available_account:
                        for i, acc in enumerate(accounts):
                            if acc == available_account:
                                account_index = i
                                break
                        new_account = available_account
                        task_count_since_restart = 0
                        coordinated_restart_chrome(worker_id, task_type, new_account)
                        current_account = new_account
                        save_state(task_type, {"accountIndex": account_index, "taskCountSinceRestart": task_count_since_restart})
                        log.info("[%s] Account %s in cooldown, switched to: %s", worker_id, current_account, new_account)
                    else:
                        log.info("[%s_%s] All accounts in cooldown, waiting...", worker_id, task_type)
                        update_status(worker_id, task_type, WorkerStatus.WAITING.value, task_count_since_restart)
                        time.sleep(60)
                        continue
                else:
                    log.info("[%s_%s] Current account %s in cooldown, waiting for leader...",
                            worker_id, task_type, current_account)
                    update_status(worker_id, task_type, WorkerStatus.WAITING.value, task_count_since_restart)
                    time.sleep(60)
                    continue

            # ========== 3. 拉取任务 ==========
            update_status(worker_id, task_type, WorkerStatus.IDLE.value, task_count_since_restart)
            task = pull_task(worker_id, task_type)
            if not task:
                update_status(worker_id, task_type, WorkerStatus.WAITING.value, task_count_since_restart)
                time.sleep(PULL_INTERVAL)
                consecutive_failures = 0
                continue

            task_id = task["id"]
            log.info(
                "Got task: %s (%s) [account=%s, #%d since restart]",
                task_id, task.get("name", ""), current_account, task_count_since_restart
            )

            update_status(worker_id, task_type, WorkerStatus.BUSY.value, task_count_since_restart)

            report_start(task_id, worker_id)

            success = process_task(task, worker_id, current_account)

            report_result(task_id, status=1 if success else 0, worker_id=worker_id)

            task_count_since_restart += 1
            update_status(worker_id, task_type, WorkerStatus.IDLE.value, task_count_since_restart)
            save_state(
                task_type,
                {"accountIndex": account_index, "taskCountSinceRestart": task_count_since_restart}
            )

            if success:
                consecutive_failures = 0
                log.info("Task completed successfully: %s", task_id)
            else:
                consecutive_failures += 1
                log.warning(
                    "Task failed: %s, consecutive failures: %d/%d",
                    task_id, consecutive_failures, MAX_CONSECUTIVE_FAILURES
                )

            time.sleep(EXECUTE_INTERVAL)

        except requests.RequestException as e:
            log.error("Network error in task loop: %s", str(e))
            time.sleep(PULL_INTERVAL)
            update_status(worker_id, task_type, WorkerStatus.IDLE.value, task_count_since_restart)
            consecutive_failures = 0
        except Exception as e:
            log.error("Unexpected error in task loop: %s", str(e))
            time.sleep(PULL_INTERVAL)
            update_status(worker_id, task_type, WorkerStatus.IDLE.value, task_count_since_restart)


# ---------- Entry Point ----------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Task Runner - 文章发布任务处理脚本（支持多账号+冷却时间）"
    )
    parser.add_argument("worker_id", nargs="?", default=None, help="Worker ID")
    parser.add_argument("--type", default=TASK_TYPE, help="任务类型")
    parser.add_argument(
        "--restart-after",
        type=int,
        default=1,
        help="每多少条任务后切换 Chrome（默认1）"
    )
    parser.add_argument(
        "--cooldown-hours",
        type=float,
        default=2.0,
        help="账号冷却小时数（默认2.0小时）"
    )
    args = parser.parse_args()

    worker = args.worker_id or WORKER_ID
    run_loop(worker, args.type, args.restart_after, args.cooldown_hours)
