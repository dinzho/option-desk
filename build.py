#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 src/ 下的模块内联成单个 index.html，方便直接打开或部署到任意静态托管（GitHub Pages 等）。

用法：
    python3 build.py                              # 输出到 ./OptionDesk.html（纯 demo 数据）
    python3 build.py --snapshot snapshot-PLTR.json   # 把真实数据烤进 HTML，打开即用、零联网
    python3 build.py --snapshot snapshot-PLTR.json -o PLTR.html
"""
import argparse
import datetime
import io
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")

# 内联顺序：依赖在前
JS_ORDER = ["engine.js", "strategies.js", "data.js", "charts.js", "scan.js", "app.js"]


def read(p):
    with io.open(p, "r", encoding="utf-8") as f:
        return f.read()


def bake_json(obj):
    """把物件安全地內聯成 <script> 可以執行嘅賦值語句。

    唔可以寫成 ("window.X = JSON.parse('%s')" % raw) ——
    只要資料入面有任何一個單引號（實測 McDonald's 令成頁白屏），
    字串就會提早閉合，瀏覽器報 "missing ) after argument list"。
    正確做法：先 json.dumps 成合法 JS 字面量，再轉義 </>
    """
    raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    # </script 會提早閉合；< > & 一併轉義最保險
    return raw.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def main():
    ap = argparse.ArgumentParser(description="构建 OptionDesk 单档 HTML")
    ap.add_argument("-o", "--out", default=None, help="输出文件（默认 ./OptionDesk.html）")
    ap.add_argument("--snapshot", default=None,
                    help="fetch.py 产生的 JSON 快照，烤入后打开即显示真实数据，完全不需要联网")
    ap.add_argument("--scan", default=None,
                    help="scan.py 产生的每日扫描 JSON，烤入后首屏直接显示今日机会")
    ap.add_argument("--perf", default=None,
                    help="review.py 产生的绩效覆盤 JSON，烤入后显示過往建議勝率")
    args = ap.parse_args()
    out_path = args.out or os.path.join(HERE, "OptionDesk.html")

    html = read(os.path.join(SRC, "index.html"))
    css = read(os.path.join(SRC, "styles.css"))

    # ---- 績效覆盤烤入 ----
    perf_html = ""
    if args.perf:
        pp = args.perf
        if not os.path.isabs(pp):
            pp = os.path.join(HERE, pp)
        if not os.path.exists(pp):
            raise SystemExit("找不到績效文件: %s" % pp)
        with io.open(pp, "r", encoding="utf-8") as f:
            perf = json.load(f)
        raw = bake_json(perf)
        sm = perf.get("summary") or {}
        print("烤入績效: %s  跟蹤 %s 筆 · 命中 %s/%s · 到期 %s/%s  (%.1f KB)" % (
            perf.get("generated") or "?", sm.get("tracked") or 0,
            sm.get("touchHit") or 0, sm.get("touchTotal") or 0,
            sm.get("settleWin") or 0, sm.get("settled") or 0,
            len(raw.encode("utf-8")) / 1024.0))
        perf_html = "<script>\nwindow.__DESK_PERF__ = %s;\n</script>\n" % raw

    # ---- 快照烤入 ----
    snap_html = ""
    if args.snapshot:
        sp = args.snapshot
        if not os.path.isabs(sp):
            sp = os.path.join(HERE, sp)
        if not os.path.exists(sp):
            raise SystemExit("找不到快照文件: %s" % sp)
        with io.open(sp, "r", encoding="utf-8") as f:
            snap = json.load(f)
        raw = bake_json(snap)
        sym = (snap.get("symbol") or "?").upper()
        stamp = snap.get("fetchedAt") or "?"
        print("烤入快照: %s  %s  (%.1f KB)" % (sym, stamp, len(raw.encode("utf-8")) / 1024.0))
        # 直接用 JS 对象字面量，唔再经 JSON.parse('...')，避开引号问题
        snap_html = ("<script>\nwindow.__DESK_SNAPSHOT__ = %s;\n"
                     "window.__DESK_SNAPSHOT_META__ = %s;\n</script>\n"
                     % (raw, bake_json({"symbol": sym, "fetchedAt": stamp})))

    # ---- 每日扫描烤入 ----
    scan_html = ""
    if args.scan:
        sp = args.scan
        if not os.path.isabs(sp):
            sp = os.path.join(HERE, sp)
        if not os.path.exists(sp):
            raise SystemExit("找不到扫描文件: %s" % sp)
        with io.open(sp, "r", encoding="utf-8") as f:
            scan = json.load(f)
        raw = bake_json(scan)
        sm = scan.get("summary") or {}
        print("烤入扫描: %s  %d 档（机会 %d / 观察 %d）  %.1f KB" % (
            scan.get("date") or "?", sm.get("survived") or 0,
            sm.get("actionable") or 0, sm.get("watch") or 0,
            len(raw.encode("utf-8")) / 1024.0))
        scan_html = "<script>\nwindow.__DESK_SCAN__ = %s;\n</script>\n" % raw

    js_parts = []
    for name in JS_ORDER:
        p = os.path.join(SRC, name)
        if not os.path.exists(p):
            raise SystemExit("缺少模块: %s" % p)
        src = read(p).rstrip()
        # 防御：模块末尾必须有分号。否则内联后会被解析成对前一个表达式的调用
        # （例如 charts.js 结尾 "})" 紧接 app.js 的 "(function(){...})()" →
        #   "})(...)" 抛 "is not a function"）
        if not src.endswith(";"):
            src += ";"
        js_parts.append("/* ===== %s ===== */\n%s" % (name, src))
    js = ";\n".join(js_parts) + ";\n"

    # 安全：内联的 JS 里若出现 </script 会提前闭合标签
    if re.search(r"</script", js, re.I):
        raise SystemExit("JS 中含有 </script，需转义后再内联")
    if re.search(r"</style", css, re.I):
        raise SystemExit("CSS 中含有 </style，需转义后再内联")

    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")

    html = html.replace(
        '<link rel="stylesheet" href="styles.css">',
        "<style>\n%s\n</style>" % css
    )
    # 把 5 个 script 标签替换为一个内联块（快照排在最前，否则 init() 已经跑完）
    block = perf_html + scan_html + snap_html + "<script>\n%s\n</script>" % js
    script_tags = "\n".join(
        '<script src="%s"></script>' % n for n in JS_ORDER
    )
    if script_tags in html:
        html = html.replace(script_tags, block, 1)
    else:
        # 容错：逐个清掉旧标签，再从 </body> 前插入
        for n in JS_ORDER:
            html = html.replace('<script src="%s"></script>' % n, "")
        html = html.replace("</body>", block + "\n</body>", 1)

    if perf_html and "__DESK_PERF__" not in html:
        raise SystemExit("績效注入失敗")
    if snap_html and "__DESK_SNAPSHOT__" not in html:
        raise SystemExit("快照注入失败：index.html 里找不到 script 占位或未找到 </body>")
    if scan_html and "__DESK_SCAN__" not in html:
        raise SystemExit("扫描注入失败：index.html 里找不到 script 占位或未找到 </body>")

    html = html.replace(
        "<title>OptionDesk · 期权交易工作台</title>",
        "<title>OptionDesk · 期权交易工作台</title>\n<meta name=\"build\" content=\"%s\">" % stamp
    )

    with io.open(out_path, "w", encoding="utf-8") as f:
        f.write(html)

    size = os.path.getsize(out_path)
    print("已构建: %s" % out_path)
    print("大小:   %.1f KB" % (size / 1024.0))
    print("内联模块: %s" % ", ".join(JS_ORDER))


if __name__ == "__main__":
    main()
