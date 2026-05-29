# -*- coding: utf-8 -*-
"""
ip_extrac.py - 从天启 IP 接口提取代理 IP

使用示例:
  python ip_extrac.py                    # 默认 region=510000, time=5
  python ip_extrac.py --region 110000    # 指定北京
  python ip_extrac.py --region 510000 --time 24  # 指定四川，时效24小时
"""
import argparse
import requests
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

BASE_URL = "http://api.tianqiip.com/getip"

DEFAULT_PARAMS = {
    "secret": "sxsdx",
    "num": 1,
    "type": "json",
    "port": 2,
    "mr": 2,
    "sign": "sdasdasda",
}


def get_ip(region: str = "510000", time: int = 5):
    """从 API 提取代理 IP 并输出到 stdout"""
    params = {**DEFAULT_PARAMS, "region": region, "time": time}
    
    log.info("Requesting IP with region=%s, time=%s", region, time)
    try:
        resp = requests.get(BASE_URL, params=params, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        
        code = data.get("code")
        if code == 0:
            result = data.get("data")
            if isinstance(result, list) and result:
                # 格式: [{"ip": "x.x.x.x", "port": 1234}, ...]
                for item in result:
                    ip = item.get("ip")
                    port = item.get("port")
                    if ip and port:
                        proxy = f"http://{ip}:{port}"
                        log.info("Extracted proxy: %s", proxy)
                        print(proxy)
            elif isinstance(result, str):
                # 格式: "x.x.x.x:1234" 或类似的字符串
                log.info("Extracted proxy: %s", result)
                print(result)
            else:
                log.warning("Unexpected data format or no IP: %s", data)
        else:
            log.error("API error (code=%s): %s", code, data.get("msg", "Unknown"))
            
    except requests.RequestException as e:
        log.error("Request failed: %s", e)
    except Exception as e:
        log.error("Parse failed: %s", e)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="从天启 IP 接口提取代理 IP")
    parser.add_argument("--region", default="510000", help="IP 地区代码 (默认: 510000)")
    parser.add_argument("--time", type=int, default=5, help="IP 有效时长/小时 (默认: 5)")
    args = parser.parse_args()
    
    get_ip(region=args.region, time=args.time)
