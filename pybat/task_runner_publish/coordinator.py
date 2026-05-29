# -*- coding: utf-8 -*-
"""
进程协调模块 - 负责多任务间的 Chrome 切换同步
使用文件锁实现跨进程同步
"""
import json
import logging
import os
import time
from pathlib import Path
from contextlib import contextmanager
from enum import Enum
from filelock import FileLock

# 共享目录
SHARED_DIR = Path(os.environ.get("TASK_RUNNER_SHARED_DIR", "/tmp/task_runner"))
STATE_FILE = SHARED_DIR / "state.json"
LOCK_FILE = SHARED_DIR / "coordinator.lock"

# Leader 心跳超时时间
# IDLE_TIMEOUT: Leader 空闲时，超过 60s 未响应视为下线
IDLE_TIMEOUT = 60
# BUSY_TIMEOUT: Leader 忙碌时（执行长任务），容忍更长时间（COMMAND_TIMEOUT默认为300s）
BUSY_TIMEOUT = 400


def init_shared_dir():
    SHARED_DIR.mkdir(parents=True, exist_ok=True)


class WorkerStatus(Enum):
    IDLE = "idle"
    BUSY = "busy"
    WAITING = "waiting"
    LEADER = "leader"


def _load_state():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except:
            pass
    return {"workers": {}, "leader": None, "switch_pending": False}


def _save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")


def _check_and_elect_leader(state, current_key):
    current_leader = state.get("leader")
    if not current_leader:
        state["leader"] = current_key
        return True

    leader_info = state["workers"].get(current_leader, {})
    last_active = leader_info.get("last_active", 0)
    status = leader_info.get("status", "idle")

    if status == "busy":
        timeout = BUSY_TIMEOUT
    else:
        timeout = IDLE_TIMEOUT

    if time.time() - last_active > timeout:
        logging.warning("Leader %s appears dead (status=%s, inactive for %.1fs). Electing %s as new leader.",
                        current_leader, status, time.time() - last_active, current_key)
        state["leader"] = current_key
        state["switch_pending"] = False
        state.pop("switch_initiator", None)
        state.pop("switch_start_time", None)
        return True
    return False


@contextmanager
def _lock():
    """跨平台文件锁"""
    lock = FileLock(str(LOCK_FILE), timeout=30)
    lock.acquire()
    try:
        yield
    finally:
        lock.release()


def register_worker(worker_id, task_type):
    """注册工作进程，返回是否为主导任务（最先注册的就是主导）

    用 worker_id + task_type 作为唯一标识，允许不同 task_type 共用同一个 worker_id
    """
    init_shared_dir()

    unique_key = f"{worker_id}_{task_type}"

    with _lock():
        state = _load_state()

        _check_and_elect_leader(state, unique_key)

        is_first_registration = unique_key not in state["workers"]

        state["workers"][unique_key] = {
            "worker_id": worker_id,
            "type": task_type,
            "status": WorkerStatus.IDLE.value,
            "task_count": 0,
            "last_active": time.time()
        }

        if is_first_registration and not state.get("leader"):
            state["leader"] = unique_key

        is_leader = (unique_key == state["leader"])
        _save_state(state)
        return is_leader


def update_status(worker_id, task_type, status, task_count=None):
    """更新工作进程状态"""
    unique_key = f"{worker_id}_{task_type}"
    with _lock():
        state = _load_state()
        _check_and_elect_leader(state, unique_key)
        if unique_key in state["workers"]:
            state["workers"][unique_key]["status"] = status
            if task_count is not None:
                state["workers"][unique_key]["task_count"] = task_count
            state["workers"][unique_key]["last_active"] = time.time()
            _save_state(state)


def request_switch(worker_id, task_type):
    """请求切换（只有主导任务能发起）"""
    unique_key = f"{worker_id}_{task_type}"
    with _lock():
        state = _load_state()
        _check_and_elect_leader(state, unique_key)
        if state.get("leader") != unique_key:
            return False
        if state.get("switch_pending"):
            return False
        state["switch_pending"] = True
        state["switch_initiator"] = unique_key
        state["switch_start_time"] = time.time()
        _save_state(state)
        return True


def wait_for_switch_complete(worker_id, task_type, timeout=180.0):
    """等待切换完成（非主导任务调用）"""
    unique_key = f"{worker_id}_{task_type}"
    start = time.time()
    while time.time() - start < timeout:
        with _lock():
            state = _load_state()

            if _check_and_elect_leader(state, unique_key) and state.get("switch_initiator") != unique_key:
                state["switch_pending"] = False
                state.pop("switch_initiator", None)
                state.pop("switch_start_time", None)
                _save_state(state)
                return True

            if not state.get("switch_pending"):
                return True

            if unique_key == state.get("leader"):
                return True

            leader = state.get("leader")
            other_workers = [w for w in state["workers"] if w != unique_key and w != leader]
            busy = [w for w in other_workers
                   if state["workers"].get(w, {}).get("status") == WorkerStatus.BUSY.value]

            if busy:
                update_status(worker_id, task_type, WorkerStatus.WAITING.value)
                time.sleep(1)
                continue
            return True
    return False


def get_leader(task_type=None):
    """获取当前主导任务的唯一标识"""
    with _lock():
        state = _load_state()
        return state.get("leader")


def all_workers_idle():
    """检查是否所有工作进程都处于 idle 状态"""
    with _lock():
        state = _load_state()
        for w in state["workers"]:
            if state["workers"].get(w, {}).get("status") != WorkerStatus.IDLE.value:
                return False
        return True


_restart_chrome = None


def set_restart_chrome_func(func):
    """设置重启函数"""
    global _restart_chrome
    _restart_chrome = func


def finish_switch(worker_id, task_type, new_account):
    """完成切换（主导任务调用）"""
    unique_key = f"{worker_id}_{task_type}"
    with _lock():
        state = _load_state()
        if state.get("switch_initiator") != unique_key:
            return

        state["switch_pending"] = False
        state.pop("switch_initiator", None)
        state.pop("switch_start_time", None)
        _save_state(state)
