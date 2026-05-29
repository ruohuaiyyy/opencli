# -*- coding: utf-8 -*-

"""
Task Runner - 带进程协调的任务处理脚本
流程：拉取任务 -> 上报开始 -> 执行命令 -> 发送回调 -> 上报结果

支持多进程协调：只有主导任务能触发 Chrome 切换，
其他任务等待切换完成后再继续。
"""
import argparse
import json
import logging
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Optional
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

# 配置（同原脚本）
TASK_CENTER_URL = os.environ.get("TASK_CENTER_URL", "http://openclawtaskcenter.beta.qunar.com")
WORKER_ID = os.environ.get("WORKER_ID", "lqxCopaw")
TASK_TYPE = os.environ.get("TASK_TYPE", "default")
PULL_INTERVAL = int(os.environ.get("PULL_INTERVAL", "5"))
EXECUTE_INTERVAL = int(os.environ.get("EXECUTE_INTERVAL", "100"))
HTTP_TIMEOUT = 30
COMMAND_TIMEOUT = int(os.environ.get("COMMAND_TIMEOUT", "300"))
MAX_CONSECUTIVE_FAILURES = 2
MAX_TASKS_PER_ACCOUNT = 20  # 每个账号每天最多执行任务次数
ACCOUNT_LIMIT_TASK_TYPES = {"opencli-analysis-doubao", "opencli-analysis-doubaoTest"}  # 需要限制账号次数的 task_type

# 账号文件
ACCOUNTS_FILE = Path.home() / ".opencli" / "accounts" / "doubao.json"
PROFILES_DIR = Path.home() / ".opencli" / "profiles"


def get_doubao_accounts():
    """从 doubao.json 读取账号名列表（排除 default）
    奇数日期取 accounts，偶数日期取 accounts2
    """
    try:
        # 根据日期奇偶性选择账号文件夹
        day = datetime.now().day
        folder_name = "accounts" if day % 2 == 1 else "accounts"
        accounts_file = Path.home() / ".opencli" / folder_name / "doubao.json"

        if accounts_file.exists():
            data = json.loads(accounts_file.read_text(encoding="utf-8"))
            accounts = data.get("accounts", {})
            if isinstance(accounts, dict) and accounts:
                log.info("Using account folder: %s, found %d accounts", folder_name, len(accounts))
                return [k for k in accounts.keys() if k != "default"]
        return []
    except Exception as e:
        log.warning("Failed to read doubao accounts: %s, using empty list", e)
        return []

# 每个 task_type 使用独立的状态文件，避免冲突
def get_state_file(task_type):
    base = Path.home() / ".opencli" / "accounts"
    return base / f"doubao-task-state-{task_type}.json"


def load_state(task_type):
    """加载指定 task_type 的轮换状态"""
    state_file = get_state_file(task_type)
    today = datetime.now().strftime("%Y-%m-%d")
    try:
        if state_file.exists():
            state = json.loads(state_file.read_text(encoding="utf-8"))
            # 如果日期变了，重置计数
            if state.get("date") != today:
                log.info("New day detected (%s -> %s), resetting account task counts", state.get("date"), today)
                return {"accountIndex": 0, "taskCountSinceRestart": 0, "date": today, "accountTaskCounts": {}}
            # 兼容旧状态文件：缺少 date 字段时补充
            if "date" not in state:
                state["date"] = today
            return state
    except Exception:
        pass
    return {"accountIndex": 0, "taskCountSinceRestart": 0, "date": today, "accountTaskCounts": {}}


def save_state(task_type, state):
    """保存指定 task_type 的轮换状态"""
    state_file = get_state_file(task_type)
    try:
        state_file.parent.mkdir(parents=True, exist_ok=True)
        today = datetime.now().strftime("%Y-%m-%d")
        state["date"] = today
        state_file.write_text(
            json.dumps({**state, "lastUpdated": time.strftime("%Y-%m-%dT%H:%M:%S")}, indent=2),
            encoding="utf-8",
        )
    except Exception as e:
        log.warning("Failed to save task state: %s", e)


def restart_chrome(account):
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


def coordinated_restart_chrome(worker_id, task_type, account):
    """协调版本的 Chrome 重启"""
    log.info("[%s_%s] Requesting Chrome switch...", worker_id, task_type)
    
    # 请求切换（只有主导任务能发起）
    if not request_switch(worker_id, task_type):
        log.info("[%s_%s] Not leader or switch already pending", worker_id, task_type)
        return False
    
    # # 等待其他任务完成
    # log.info("[%s_%s] Waiting for other workers to finish...", worker_id, task_type)
    # if not wait_for_switch_complete(worker_id, task_type, timeout=300):
    #     log.warning("[%s_%s] Timeout waiting for workers", worker_id, task_type)
    #     # 超时时也尝试切换
    #     pass
    
    # 执行切换
    log.info("[%s_%s] Executing Chrome restart...", worker_id, task_type)
    restart_chrome(account)
    finish_switch(worker_id, task_type, account)
    log.info("[%s_%s] Chrome switch completed", worker_id, task_type)
    return True


def _get(url, params=None):
    resp = requests.get(url, params=params, timeout=HTTP_TIMEOUT)
    resp.raise_for_status()
    return resp.json()


def _post_json(url, data):
    resp = requests.post(url, json=data, timeout=HTTP_TIMEOUT)
    resp.raise_for_status()
    return resp.json()


def pull_task(worker_id, task_type):
    result = _get(f"{TASK_CENTER_URL}/api/tasks/pull", {"workerId": worker_id, "type": task_type})
    if result and isinstance(result, dict) and result.get("status") == "assigned":
        return result
    return None


def report_start(task_id, worker_id):
    _get(f"{TASK_CENTER_URL}/api/tasks/{task_id}/start")
    log.info("Task started: %s", task_id)


def report_result(task_id, status, worker_id):
    _get(f"{TASK_CENTER_URL}/api/tasks/{task_id}/result", {"status": status, "workerId": worker_id})
    log.info("Task result reported: task=%s, status=%s", task_id, status)


def parse_prompt(prompt):
    json_match = re.search(r'\{[^{}]*"type"\s*:\s*"[^"]+"[^{}]*\}', prompt)
    callback_config = {}
    if json_match:
        try:
            callback_config = json.loads(json_match.group())
        except json.JSONDecodeError:
            log.error("Failed to parse callback config")
    command_section = prompt[: json_match.start()].strip() if json_match else prompt
    cmd_match = re.search(r"执行命令\s+(.+?)\s+(?:生成结果文件|；|;)", command_section)
    if cmd_match:
        command = cmd_match.group(1).strip()
    else:
        command = command_section.split(";")[0].split("；")[0].strip()
    return command, callback_config


def run_command(command):
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

    if result.returncode != 0:
        raise RuntimeError(f"Command failed with code {result.returncode}: {result.stderr}")
    return None


def check_references_empty(result_data):
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


def process_task(task, worker_id, account, task_type):
    task_id = task["id"]
    prompt = task.get("prompt", "")
    try:
        command, callback_config = parse_prompt(prompt)
        log.info("Parsed command: %s", command)
        if "--account" not in command:
            command = f"{command.rstrip()} --account {account}"
        callback_url = callback_config.get("url", "")
        callback_task_id = callback_config.get("taskId", task_id)

        result_ref = run_command(command)

        if result_ref and Path(result_ref).exists():
            with open(result_ref, "r", encoding="utf-8") as f:
                result_data = json.load(f)
        elif result_ref and isinstance(result_ref, str):
            result_data = json.loads(result_ref)
        else:
            result_data = []

        has_empty_references = check_references_empty(result_data)

        if has_empty_references:
            callback_payload = {
                "taskId": callback_task_id,
                "type": "analysis",
                "status": "failed",
                "result": result_data,
                "workerId": worker_id,
                "model": task_type,
            }
            success = False
        else:
            callback_payload = {
                "taskId": callback_task_id,
                "type": "analysis",
                "status": "completed",
                "result": result_data,
                "workerId": worker_id,
                "model": task_type,
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


def run_loop(worker_id, task_type, restart_after):
    """主循环"""
    # 初始化共享目录
    init_shared_dir()
    
    # 设置重启函数到协调模块
    set_restart_chrome_func(restart_chrome)
    
    # 注册工作进程，获取是否为主导
    is_leader = register_worker(worker_id, task_type)
    log.info("Worker %s registered, is_leader=%s", worker_id, is_leader)

    accounts = get_doubao_accounts()
    if not accounts:
        accounts = ["default"]

    state = load_state(task_type)
    account_index = state.get("accountIndex", 0) % len(accounts)
    task_count_since_restart = state.get("taskCountSinceRestart", 0)
    account_task_counts = state.get("accountTaskCounts", {})
    current_account = accounts[account_index]
    current_account_count = account_task_counts.get(current_account, 0)

    log.info("Resuming: accountIndex=%d, taskCountSinceRestart=%d, currentAccount=%s, todayTaskCount=%d",
           account_index, task_count_since_restart, current_account, current_account_count)

    # 修复：仅由 Leader 负责初始启动，防止非 Leader 启动时强制 kill 掉已运行的 Chrome
    if is_leader:
        log.info("[%s] This worker is the Leader, initializing Chrome.", worker_id)
        restart_chrome(current_account)
    else:
        # Follower 短暂等待，确保 Leader 已经启动好 Chrome 环境，避免抢跑
        log.info("[%s] This worker is a Follower, waiting 5s for Leader to start Chrome...", worker_id)
        time.sleep(5)

    consecutive_failures = 0

    while True:
        try:
            # ========== 日期变化检查：跨天后重置账号计数 ==========
            today = datetime.now().strftime("%Y-%m-%d")
            if state.get("date") != today:
                log.info("[%s] New day detected (%s -> %s), resetting account task counts", worker_id, state.get("date"), today)
                account_task_counts = {}
                task_count_since_restart = 0
                state = {"accountIndex": 0, "taskCountSinceRestart": 0, "date": today, "accountTaskCounts": {}}

            # ========== 时间窗口检查：只在 10:00 - 22:00 执行 ==========
            current_hour = datetime.now().hour
            if current_hour < 10 or current_hour >= 22:
                update_status(worker_id, task_type, WorkerStatus.WAITING.value, task_count_since_restart)
                time.sleep(60)
                continue

            # ========== 关键修改：检查是否需要切换 ==========
            if task_type in ACCOUNT_LIMIT_TASK_TYPES and task_count_since_restart > 0 and task_count_since_restart % restart_after == 0:
                original_index = account_index
                switched = False

                # 跳过已用尽的账号，找到下一个可用账号
                while True:
                    account_index = (account_index + 1) % len(accounts)
                    new_account = accounts[account_index]

                    if account_task_counts.get(new_account, 0) < MAX_TASKS_PER_ACCOUNT:
                        switched = True
                        break
                    if account_index == original_index:
                        # 所有账号都耗尽，等待一天重置
                        log.info("[%s] All accounts exhausted for task_type, waiting for day reset...", worker_id)
                        update_status(worker_id, task_type, WorkerStatus.WAITING.value, task_count_since_restart)
                        time.sleep(60)
                        break

                if switched:
                    task_count_since_restart = 0
                    log.info("[%s] Task #%d reached, switching to account: %s",
                          worker_id, restart_after, new_account)

                    # 只有主导任务才能执行切换
                    if is_leader:
                        coordinated_restart_chrome(worker_id, task_type, new_account)

                    current_account = new_account
                    save_state(task_type, {"accountIndex": account_index, "taskCountSinceRestart": task_count_since_restart})
                else:
                    continue

            # 拉取任务
            update_status(worker_id, task_type, WorkerStatus.IDLE.value, task_count_since_restart)
            task = pull_task(worker_id, task_type)
            if not task:
                # 修复：没有拉取到任务时，显式更新为 WAITING 状态
                # 1. 刷新心跳，防止 Leader 因超时判定节点离线
                # 2. 强制清除可能残留的 BUSY 状态，确保 Leader 切换 Chrome 时不被卡死
                update_status(worker_id, task_type, WorkerStatus.WAITING.value, task_count_since_restart)
                time.sleep(PULL_INTERVAL)
                consecutive_failures = 0
                continue

            task_id = task["id"]
            log.info("Got task: %s (%s) [account=%s, #%d since restart]",
                   task_id, task.get("name", ""), current_account, task_count_since_restart)

            # 修复：拿到任务瞬间立刻设为 BUSY，防止竞态条件导致 Leader 误判并切杀 Chrome
            update_status(worker_id, task_type, WorkerStatus.BUSY.value, task_count_since_restart)
            
            report_start(task_id, worker_id)

            success = process_task(task, worker_id, current_account, task_type)

            report_result(task_id, status=1 if success else 0, worker_id=worker_id)

            task_count_since_restart += 1
            account_task_counts[current_account] = account_task_counts.get(current_account, 0) + 1

            # ========== 检查当前账号是否达到每天执行上限（仅限特定 task_type） ==========
            if task_type in ACCOUNT_LIMIT_TASK_TYPES and account_task_counts.get(current_account, 0) >= MAX_TASKS_PER_ACCOUNT:
                log.info("[%s] Account %s exhausted after %d tasks today", worker_id, current_account, MAX_TASKS_PER_ACCOUNT)

                # 找到下一个未用尽的账号
                original_index = account_index
                while True:
                    account_index = (account_index + 1) % len(accounts)
                    new_account = accounts[account_index]
                    if account_task_counts.get(new_account, 0) < MAX_TASKS_PER_ACCOUNT:
                        break
                    if account_index == original_index:
                        # 所有账号当天都用尽了
                        log.info("[%s] All accounts exhausted for today, waiting...", worker_id)
                        update_status(worker_id, task_type, WorkerStatus.WAITING.value, task_count_since_restart)
                        time.sleep(60)
                        break

                if account_index != original_index:
                    new_account = accounts[account_index]
                    task_count_since_restart = 0
                    log.info("[%s] Switching to account: %s", worker_id, new_account)
                    if is_leader:
                        coordinated_restart_chrome(worker_id, task_type, new_account)
                    current_account = new_account

            update_status(worker_id, task_type, WorkerStatus.IDLE.value, task_count_since_restart)
            log.info("[%s] 打印看看内容: %s，【%s】", account_index, task_count_since_restart,account_task_counts)
            save_state(task_type, {"accountIndex": account_index, "taskCountSinceRestart": task_count_since_restart, "accountTaskCounts": account_task_counts})

            if success:
                consecutive_failures = 0
                log.info("Task completed successfully: %s", task_id)
            else:
                consecutive_failures += 1
                log.warning("Task failed: %s, consecutive failures: %d/%d",
                           task_id, consecutive_failures, MAX_CONSECUTIVE_FAILURES)

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


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Task Runner - 带进程协调的任务处理脚本")
    parser.add_argument("worker_id", nargs="?", default=None, help="Worker ID")
    parser.add_argument("--type", default=TASK_TYPE, help="任务类型")
    parser.add_argument("--restart-after", type=int, default=20, help="每多少条任务后切换 Chrome")
    args = parser.parse_args()

    worker = args.worker_id or WORKER_ID
    run_loop(worker, args.type, args.restart_after)