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
    STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def _check_and_elect_leader(state, current_key):
    # """
    # 如果 Leader 失联，则自动接任。由当前存活进程调用。
    # 支持动态超时：根据 Leader 状态（BUSY/IDLE）设置不同的容忍度。
    # """
    # current_leader = state.get("leader")
    # if not current_leader:
    #     # 本来就没有 Leader，直接接任
    #     state["leader"] = current_key
    #     return True

    # leader_info = state["workers"].get(current_leader, {})
    # last_active = leader_info.get("last_active", 0)
    # status = leader_info.get("status", "idle")

    # # 动态计算超时时间：
    # # 1. 如果 Leader 正在执行任务 (busy)，容忍较长超时（覆盖 COMMAND_TIMEOUT）
    # # 2. 如果 Leader 空闲 (idle)，使用较短超时以便快速发现崩溃
    # if status == "busy":
    #     timeout = BUSY_TIMEOUT
    # else:
    #     timeout = IDLE_TIMEOUT

    # if time.time() - last_active > timeout:
    #     # Leader 失联，当前进程接任
    #     logging.warning("Leader %s appears dead (status=%s, inactive for %.1fs). Electing %s as new leader.",
    #                     current_leader, status, time.time() - last_active, current_key)
    #     state["leader"] = current_key
    #     state["switch_pending"] = False  # 清理未完成的切换死锁
    #     state.pop("switch_initiator", None)
    #     state.pop("switch_start_time", None)
    #     return True
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
    
    # 用 worker_id + task_type 作为唯一 key
    unique_key = f"{worker_id}_{task_type}"
    
    with _lock():
        state = _load_state()
        
        # 检查 Leader 是否失联，如果失联则自动接任
        _check_and_elect_leader(state, unique_key)

        # 检查是否已经注册过（用 unique_key 判断）
        is_first_registration = unique_key not in state["workers"]
        
        state["workers"][unique_key] = {
            "worker_id": worker_id,
            "type": task_type,
            "status": WorkerStatus.IDLE.value,
            "task_count": 0,
            "last_active": time.time()
        }
        
        # 注册逻辑更新：此时 leader 已在 _check_and_elect_leader 中自动处理
        # 只有当 leader 依然为空时，且我是首次注册，才接任 leader
        if is_first_registration and not state.get("leader"):
            state["leader"] = unique_key
        
        is_leader = (unique_key == state["leader"])
        _save_state(state)
        return is_leader


def update_status(worker_id, task_type, status, task_count=None):
    """更新工作进程状态
    
    参数:
        worker_id: 工作进程 ID
        task_type: 任务类型（用于构建唯一标识）
        status: 新状态
        task_count: 可选的任务计数
    """
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
    """请求切换（只有主导任务能发起）
    
    参数:
        worker_id: 工作进程 ID
        task_type: 任务类型
    """
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
    """等待切换完成（非主导任务调用）
    
    参数:
        worker_id: 工作进程 ID
        task_type: 任务类型
        timeout: 超时时间（秒）
    
    返回 True=切换完成, False=超时
    """
    unique_key = f"{worker_id}_{task_type}"
    start = time.time()
    while time.time() - start < timeout:
        with _lock():
            state = _load_state()
            
            # 检查 Leader 是否失联，如果是，接任并清理状态
            if _check_and_elect_leader(state, unique_key) and state.get("switch_initiator") != unique_key:
                # 我接任了，但之前的切换不是我发起的，需要清理死锁
                state["switch_pending"] = False
                state.pop("switch_initiator", None)
                state.pop("switch_start_time", None)
                _save_state(state)
                return True
            
            if not state.get("switch_pending"):
                return True
            
            # 不是主导任务才需要等待
            if unique_key == state.get("leader"):
                return True
            
            # 检查其他工作进程是否有正在执行的任务
            leader = state.get("leader")
            other_workers = [w for w in state["workers"] if w != unique_key and w != leader]
            busy = [w for w in other_workers 
                   if state["workers"].get(w, {}).get("status") == WorkerStatus.BUSY.value]
            
            if busy:
                # 有任务在执行，设置为等待状态并等待
                update_status(worker_id, task_type, WorkerStatus.WAITING.value)
                time.sleep(1)
                continue
            # 没有 busy 的任务，可以继续
            return True
    return False


def get_leader(task_type=None):
    """获取当前主导任务的唯一标识
    
    参数:
        task_type: 可选，如果提供则返回对应的 leader（兼容旧代码）
    返回:
        主导任务的唯一标识（worker_id_task_type）
    """
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


# 外部传入的重启函数
_restart_chrome = None


def set_restart_chrome_func(func):
    """设置重启函数"""
    global _restart_chrome
    _restart_chrome = func


def finish_switch(worker_id, task_type, new_account):
    """完成切换（主导任务调用，仅负责清理切换状态）
    
    参数:
        worker_id: 工作进程 ID
        task_type: 任务类型
        new_account: 新的账号（保留参数以兼容接口）
    """
    unique_key = f"{worker_id}_{task_type}"
    with _lock():
        state = _load_state()
        if state.get("switch_initiator") != unique_key:
            return
        
        state["switch_pending"] = False
        state.pop("switch_initiator", None)
        state.pop("switch_start_time", None)
        _save_state(state)