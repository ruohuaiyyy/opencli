import argparse
import json
import logging
import os
import re
import subprocess
import sys
import time

import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)

# 任务中心配置
TASK_CENTER_URL = os.environ.get("TASK_CENTER_URL", "http://mkt-openclaw-center.openclaw-center.inner3.beta.qunar.com")
WORKER_ID = os.environ.get("WORKER_ID", "source_detail_worker")
TASK_TYPE = os.environ.get("TASK_TYPE", "source_detail")
# 任务类型前缀列表，按顺序尝试拉取
TASK_TYPE_PREFIXES = os.environ.get("TASK_TYPE_PREFIXES", "yuanbao,doubao,qwen,deepseek").split(",")
PULL_INTERVAL = int(os.environ.get("PULL_INTERVAL", "120"))
EXECUTE_INTERVAL = int(os.environ.get("EXECUTE_INTERVAL", "10"))
HTTP_TIMEOUT = 30

# OTA品牌同义词（URL域名即可识别部分平台）
URL_PLATFORM_MAP = {
    'qunar.com': '去哪儿',
    'ctrip.com': '携程',
    'trip.com': '携程',
    'fliggy.com': '飞猪',
    'meituan.com': '美团',
    'ly.com': '同程',
    'tongcheng.com': '同程',
}

# 头条缓存目录
DEFAULT_CACHE_DIR = os.path.join(os.path.expanduser('~'), '.opencli', 'toutiao_cache')

# 口令码上下文匹配窗口大小（前后字符数）
CODE_CONTEXT_WINDOW = 30

# OTA配置文件路径
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OTA_CODES_FILE = os.path.join(SCRIPT_DIR, 'ota口令码.json')
OTA_BRAND_FILE = os.path.join(SCRIPT_DIR, 'ota-brand.json')


def is_toutiao_url(url):
    """判断是否为今日头条URL"""
    return bool(re.search(r'toutiao\.com', url))


def normalize_toutiao_url(url):
    """标准化头条URL为 m.toutiao.com/group/{id}/ 格式"""
    match = re.search(r'/(?:group|article)/(\d+)', url)
    if match:
        return f'http://m.toutiao.com/group/{match.group(1)}/'
    return url


def extract_platform_from_url(url):
    """通过URL域名识别平台"""
    for domain, platform in URL_PLATFORM_MAP.items():
        if domain in url:
            return platform
    return ''


def fetch_toutiao_content(url, cache_dir):
    """调用 opencli toutiao extract 获取文章内容，返回 (content, publish_time, file_path)"""
    match = re.search(r'group/(\d+)', url)
    if not match:
        return '', '', None
    group_id = match.group(1)
    cache_file = os.path.join(cache_dir, f'{group_id}.json')

    if os.path.exists(cache_file):
        with open(cache_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data.get('content', ''), data.get('publishTime', ''), cache_file

    os.makedirs(cache_dir, exist_ok=True)
    cmd = ['opencli', 'toutiao', 'extract', '--url', url, '-f', 'json']
    log.info('调用 opencli extract: %s', url)
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60, shell=True, encoding='utf-8')

    if result.returncode != 0:
        log.error('opencli extract 失败: %s', result.stderr.strip())
        return '', '', None

    try:
        cli_output = json.loads(result.stdout.strip())
        if not isinstance(cli_output, list) or not cli_output:
            return '', '', None
        detail = cli_output[0].get('detail', '')
        saved_path_match = re.search(r'已保存至\s+(.+)', detail)
        if not saved_path_match:
            return '', '', None
        saved_path = saved_path_match.group(1).strip()

        if not os.path.exists(saved_path):
            return '', '', None

        with open(saved_path, 'r', encoding='utf-8') as f:
            data = json.load(f)

        with open(cache_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

        return data.get('content', ''), data.get('publishTime', ''), saved_path
    except json.JSONDecodeError as e:
        log.error('解析 extract 输出失败: %s', e)
        return '', '', None


def fetch_toutiao_author(url, cache_dir):
    """调用 opencli toutiao author 获取作者信息（含实名认证信息）"""
    match = re.search(r'group/(\d+)', url)
    if not match:
        return '', ''
    group_id = match.group(1)
    cache_file = os.path.join(cache_dir, f'{group_id}_author.json')

    if os.path.exists(cache_file):
        with open(cache_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data.get('screen_name', ''), data.get('auth_info', '')

    os.makedirs(cache_dir, exist_ok=True)
    cmd = ['opencli', 'toutiao', 'author', '--url', url, '-f', 'json']
    log.info('调用 opencli author: %s', url)
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60, shell=True, encoding='utf-8')

    if result.returncode != 0:
        log.error('opencli author 失败: %s', result.stderr.strip())
        return '', ''

    try:
        cli_output = json.loads(result.stdout.strip())
        if not isinstance(cli_output, list) or not cli_output:
            return '', ''

        first_item = cli_output[0]
        screen_name = first_item.get('screen_name', '')
        auth_info = first_item.get('auth_info', '')

        cache_data = {'screen_name': screen_name, 'auth_info': auth_info}
        with open(cache_file, 'w', encoding='utf-8') as f:
            json.dump(cache_data, f, ensure_ascii=False, indent=2)

        return screen_name, auth_info
    except json.JSONDecodeError as e:
        log.error('解析 author 输出失败: %s', e)
        return '', ''


def load_ota_codes():
    """加载OTA口令码配置"""
    if os.path.exists(OTA_CODES_FILE):
        with open(OTA_CODES_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {}


def load_brand_synonyms():
    """加载OTA品牌同义词配置"""
    if os.path.exists(OTA_BRAND_FILE):
        with open(OTA_BRAND_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data.get('brandSynonyms', {})
    return {}


def find_earliest_platform(content, brand_synonyms):
    """在文章中找到最先出现的OTA平台名称"""
    if not content or not brand_synonyms:
        return ''
    earliest_pos = -1
    earliest_platform = ''
    for platform, synonyms in brand_synonyms.items():
        for synonym in synonyms:
            pos = content.find(synonym)
            if pos != -1 and (earliest_pos == -1 or pos < earliest_pos):
                earliest_pos = pos
                earliest_platform = platform
    return earliest_platform


def match_platform_by_content(content, ota_codes, brand_synonyms):
    """根据文章内容匹配发布平台（口令码 + 上下文品牌名匹配）"""
    if not content or not ota_codes:
        return ''

    context_assigned = {}
    for platform, codes in ota_codes.items():
        synonyms = brand_synonyms.get(platform, [platform])
        for code in codes:
            pos = content.find(code)
            if pos == -1:
                continue
            ctx_start = max(0, pos - CODE_CONTEXT_WINDOW)
            ctx_end = min(len(content), pos + len(code) + CODE_CONTEXT_WINDOW)
            context = content[ctx_start:ctx_end]
            found = False
            for synonym in synonyms:
                if synonym in context:
                    context_assigned[platform] = context_assigned.get(platform, 0) + 1
                    found = True
                    break
            if not found:
                context_assigned[platform] = context_assigned.get(platform, 0) + 1

    if context_assigned:
        return max(context_assigned.keys(), key=lambda p: context_assigned[p])

    return find_earliest_platform(content, brand_synonyms)


def process_url(url, ota_codes, brand_synonyms):
    """处理单个URL，返回 {source_url, platform, author, auth_info, publish_time}"""
    result = {
        'source_url': url,
        'platform': '',
        'author': '',
        'auth_info': '',
        'publish_time': '',
    }

    if is_toutiao_url(url):
        normalized_url = normalize_toutiao_url(url)
        result['source_url'] = normalized_url

        content, publish_time, _ = fetch_toutiao_content(normalized_url, DEFAULT_CACHE_DIR)
        if publish_time:
            result['publish_time'] = publish_time
        platform = match_platform_by_content(content, ota_codes, brand_synonyms)
        if platform:
            result['platform'] = platform

        author, auth_info = fetch_toutiao_author(normalized_url, DEFAULT_CACHE_DIR)
        if author:
            result['author'] = author
        if auth_info:
            result['auth_info'] = auth_info
    else:
        platform = extract_platform_from_url(url)
        if platform:
            result['platform'] = platform

    return result


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


def run_loop(worker_id, task_type):
    """主循环：按前缀顺序拉取任务 -> 处理 -> 回调 -> 上报结果"""

    ota_codes = load_ota_codes()
    brand_synonyms = load_brand_synonyms()
    log.info("OTA配置: %s 个平台口令码, %s 个品牌同义词", len(ota_codes), len(brand_synonyms))

    while True:
        try:
            task = None
            # 按前缀顺序尝试拉取任务
            for prefix in TASK_TYPE_PREFIXES:
                full_type = f"{prefix}—{task_type}" if prefix else task_type
                log.info("full_type: %s", full_type)
                task = pull_task(worker_id, full_type)
                if task:
                    log.info("从 %s 拉取到任务", full_type)
                    break
                log.info("%s 无任务，继续尝试下一个前缀", full_type)

            if not task:
                time.sleep(PULL_INTERVAL)
                continue

            task_id = task["id"]
            log.info("Got task: %s", task_id)

            prompt = task.get("prompt", "")
            try:
                input_data = json.loads(prompt)
            except json.JSONDecodeError:
                log.error("Failed to parse task prompt as JSON")
                report_result(task_id, 0, worker_id)
                time.sleep(EXECUTE_INTERVAL)
                continue

            urls = input_data.get("urls", [])
            callback_url = input_data.get("callbackUrl", "")
            query_word = input_data.get("queryWord", "")
            query_word_id = input_data.get("queryWordId", "")

            if not urls:
                log.info("urls为空，跳过")
                report_result(task_id, 1, worker_id)
                time.sleep(EXECUTE_INTERVAL)
                continue

            report_start(task_id, worker_id)
            log.info("处理query: %s(%s), URL数量: %s", query_word, query_word_id, len(urls))

            results = []
            for url in urls:
                log.info("处理: %s", url)
                result = process_url(url, ota_codes, brand_synonyms)
                results.append(result)

            log.info("处理完成，共 %s 条结果", len(results))

            if callback_url:
                payload = {
                    'taskId': task_id,
                    'status': 'completed',
                    'result': results,
                }
                log.info("回调: %s", callback_url)
                resp = _post_json(callback_url, payload)
                log.info("回调响应: %s", resp)

            report_result(task_id, 1, worker_id)
            time.sleep(EXECUTE_INTERVAL)

        except requests.RequestException as e:
            log.error("Network error in task loop: %s", str(e))
            time.sleep(PULL_INTERVAL)
        except Exception as e:
            log.error("Unexpected error in task loop: %s", str(e))
            time.sleep(PULL_INTERVAL)


def main():
    parser = argparse.ArgumentParser(description='Source Detail Task Runner - 拉取任务处理URL平台/作者信息')
    parser.add_argument("worker_id", nargs="?", default=None, help="Worker ID")
    parser.add_argument("--type", default=TASK_TYPE, help="任务类型")
    args = parser.parse_args()

    worker = args.worker_id or WORKER_ID
    log.info("Starting source detail worker: %s, base type: %s, prefixes: %s", worker, args.type, TASK_TYPE_PREFIXES)
    run_loop(worker, args.type)


if __name__ == '__main__':
    main()