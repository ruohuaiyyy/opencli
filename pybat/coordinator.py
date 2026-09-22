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

# 主导任务 task_type 前缀：仅这些前缀的任务具备主导资格，可发起 Chrome 切换
LEADER_ELIGIBLE_PREFIXES = ("opencli-analysis-yuanbao", "opencli-analysis-qwen")
# Leader 心跳超时（秒）：心跳 = 最近一次执行任务时间（last_busy_time），
# 超过该时长未执行任务视为失联/无任务，允许其他主导任务接管
LEADER_HEARTBEAT_TIMEOUT = 600


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


def is_leader_task_type(task_type):
    """判断 task_type 是否具备主导资格（yuanbao/qwen 前缀）"""
    return task_type.startswith(LEADER_ELIGIBLE_PREFIXES)


def _leader_takeover_allowed(state, unique_key, task_type):
    """判断 unique_key 是否可成为/接管 leader，返回 (allowed, took_over)

    took_over=True 表示发生接管（原 leader 被替换），调用方需更新 state["leader"]
    判定规则：
    1. 我就是 leader → 允许
    2. 我不具备主导资格 → 拒绝（除非当前没有 leader，见规则 3 的兜底）
    3. leader 不存在/记录丢失 → 允许（非主导任务兜底担任临时 leader）
    4. leader 超过 LEADER_HEARTBEAT_TIMEOUT 未执行任务 → 允许接管
    5. leader 10 分钟内执行过任务 → 拒绝
    """
    if unique_key == state.get("leader"):
        return True, False

    leader_key = state.get("leader")
    leader_info = state.get("workers", {}).get(leader_key, {}) if leader_key else {}

    # 我不具备主导资格：仅当没有 leader 或 leader 记录丢失时兜底担任临时 leader
    if not is_leader_task_type(task_type):
        if not leader_key or not leader_info:
            return True, True
        return False, False

    # 我是主导任务：
    if not leader_key or not leader_info:
        # leader 不存在或记录丢失 → 接管
        return True, True

    # 现 leader 不具备主导资格 → 立即接管（注册即接管，避免等待）
    leader_task_type = leader_info.get("type", "")
    if not is_leader_task_type(leader_task_type):
        return True, True

    # leader 心跳超时（超过阈值未执行任务）→ 接管
    last_busy = leader_info.get("last_busy_time", 0)
    if time.time() - last_busy > LEADER_HEARTBEAT_TIMEOUT:
        return True, True

    # leader 最近仍在执行任务 → 拒绝
    return False, False


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
    """注册工作进程，返回是否为主导任务（leader 或被允许接管的进程）

    用 worker_id + task_type 作为唯一标识，允许不同 task_type 共用同一个 worker_id
    选主规则见 _leader_takeover_allowed：无 leader 时接任（非主导兜底为临时 leader）；
    leader 心跳超时或我不合格 leader 而我合格时接管
    """
    init_shared_dir()

    # 用 worker_id + task_type 作为唯一 key
    unique_key = f"{worker_id}_{task_type}"

    with _lock():
        state = _load_state()

        # 检查是否已经注册过（用 unique_key 判断）
        is_first_registration = unique_key not in state["workers"]

        state["workers"][unique_key] = {
            "worker_id": worker_id,
            "type": task_type,
            "status": WorkerStatus.IDLE.value,
            "task_count": 0,
            "last_active": time.time(),
            # 心跳：最近一次执行任务时间，注册时初始化为当前时间防止刚启动即被接管
            "last_busy_time": time.time()
        }

        # 选主：无 leader / leader 失联 / 我合格且 leader 不合格 → 接任或接管
        allowed, took_over = _leader_takeover_allowed(state, unique_key, task_type)
        if allowed and took_over:
            logging.info("Leader takeover: %s takes over leadership from %s",
                         unique_key, state.get("leader"))
            state["leader"] = unique_key
            # 清理可能残留的切换状态，避免死锁
            state.pop("switch_initiator", None)
            state.pop("switch_start_time", None)

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
        if unique_key in state["workers"]:
            state["workers"][unique_key]["status"] = status
            if task_count is not None:
                state["workers"][unique_key]["task_count"] = task_count
            state["workers"][unique_key]["last_active"] = time.time()
            # 心跳：进入 BUSY 即视为执行了一次任务，刷新 leader 心跳
            if status == WorkerStatus.BUSY.value:
                state["workers"][unique_key]["last_busy_time"] = time.time()
            _save_state(state)


def request_switch(worker_id, task_type):
    """请求切换（主导任务发起；leader 失联/无任务时允许合格任务接管）

    参数:
        worker_id: 工作进程 ID
        task_type: 任务类型
    """
    unique_key = f"{worker_id}_{task_type}"
    with _lock():
        state = _load_state()

        # 判定是否允许切换（leader 心跳超时会触发接管）
        allowed, took_over = _leader_takeover_allowed(state, unique_key, task_type)
        if not allowed:
            logging.info("request_switch denied for %s (leader=%s active)",
                         unique_key, state.get("leader"))
            return False

        if took_over:
            logging.info("Leader takeover via request_switch: %s takes over from %s",
                         unique_key, state.get("leader"))
            state["leader"] = unique_key
            # 清理可能残留的切换状态，避免死锁
            state.pop("switch_initiator", None)
            state.pop("switch_start_time", None)

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
        
        # state["switch_pending"] = False
        state.pop("switch_initiator", None)
        state.pop("switch_start_time", None)
        _save_state(state)