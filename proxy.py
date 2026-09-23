#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OptionDesk 本地代理 —— 零依赖、零费用、无 CORS 限制。

用途：期权工作台运行在浏览器里，直接请求交易所/财经 API 会被 CORS 拦截
（Nasdaq、Yahoo Finance 的响应都没有 Access-Control-Allow-Origin）。
本代理在本机转发请求，是最稳定、最隐私（不经过任何第三方）的方式。

需要先启动代理才能用「实时数据」模式；若不想开代理，用 fetch.py 抓取后
build.py --snapshot 烤进 HTML 即可完全离线。

用法：
    python3 proxy.py              # 默认监听 127.0.0.1:8787
    python3 proxy.py --port 9000

然后在工作台右上角「数据源」里把「本地代理」拖到第一位即可。
仅监听回环地址，外部设备无法访问。
"""
import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 只允许这些域名，防止被当作开放代理滥用
ALLOWED_HOSTS = (
    # 主数据源：Nasdaq 官方公开 API（报价 / 历史 OHLC / 完整期权链，含 OI 与买卖价）
    "api.nasdaq.com",
    "www.nasdaq.com",
    # 备用
    "query1.finance.yahoo.com",
    "query2.finance.yahoo.com",
    "finance.yahoo.com",
    "stooq.com",
)

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")


class Handler(BaseHTTPRequestHandler):
    server_version = "OptionDeskProxy/1.0"

    def log_message(self, fmt, *args):
        # 静默访问日志，避免刷屏
        pass

    def _send(self, code, body, ctype="text/plain; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, b"")

    def do_HEAD(self):
        self.do_GET(head_only=True)

    def do_GET(self, head_only=False):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)

        # 必须先取 url 参数：带 ?url=... 的请求 path 同样是 "/"
        target = (qs.get("url") or qs.get("quest") or [None])[0]

        if not target:
            if parsed.path in ("/", "/health", "/ping", ""):
                self._send(200, json.dumps({"ok": True, "service": "OptionDesk proxy"}),
                           "application/json")
            else:
                self._send(400, "缺少 url 参数。用法: /?url=<经过 URL 编码的目标地址>")
            return

        try:
            t = urllib.parse.urlparse(target)
        except Exception:
            self._send(400, "url 解析失败")
            return

        if t.scheme not in ("http", "https"):
            self._send(400, "仅支持 http/https")
            return
        if not any(t.hostname == h or (t.hostname or "").endswith("." + h) for h in ALLOWED_HOSTS):
            self._send(403, "域名不在白名单内: %s" % (t.hostname,))
            return

        req = urllib.request.Request(target, headers={
            "User-Agent": UA,
            "Accept": "application/json,text/plain,*/*",
            "Accept-Language": "en-US,en;q=0.9",
        })
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = resp.read()
                ctype = resp.headers.get("Content-Type", "application/octet-stream")
                self._send(200, data, ctype)
        except urllib.error.HTTPError as e:
            self._send(e.code, "上游返回 %s" % e.code)
        except Exception as e:
            self._send(502, "上游请求失败: %s" % e)


def main():
    ap = argparse.ArgumentParser(description="OptionDesk 本地 CORS 代理")
    ap.add_argument("--port", type=int, default=8787, help="监听端口（默认 8787）")
    ap.add_argument("--host", default="127.0.0.1", help="监听地址（默认仅本机）")
    args = ap.parse_args()

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print("OptionDesk 代理已启动: http://%s:%d" % (args.host, args.port))
    print("健康检查: http://%s:%d/health" % (args.host, args.port))
    print("按 Ctrl+C 停止。\n")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
        sys.exit(0)


if __name__ == "__main__":
    main()
