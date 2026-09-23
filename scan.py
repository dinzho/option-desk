#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OptionDesk 每日掃描器 —— 全自動篩出當日最適合做期權嘅標的。

完全免費，唔使 API key、唔使註冊。資料來源 Nasdaq 官方公開 API。

流程：
    Stage 1  池子    screener（~7,132 檔）→ 市值/成交量過濾 → Top N
    Stage 2  抓取    並行，每檔 7 個請求（報價/歷史/期權鏈/財報日/評級/空頭/機構持倉）
    Stage 3  評分    呼叫 node src/score.js（復用已測試嘅 engine.js，唔重寫數學）
    Stage 4  可選    --build 直接烤入 OptionDesk.html

用法：
    python3 scan.py                      # 掃 Top 60
    python3 scan.py --top 12             # 快啲，試味用
    python3 scan.py --symbols PLTR,NVDA,TSLA
    python3 scan.py --top 60 --build     # 掃完即刻烤入 HTML
    python3 scan.py --skip-fetch         # 用上次嘅 raw 檔重新評分（慳時間）
"""

import argparse
import concurrent.futures as cf
import datetime
import io
import json
import os
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SCAN_DIR = os.path.join(HERE, "scan")
SCORE_JS = os.path.join(HERE, "src", "score.js")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
BASE = "https://api.nasdaq.com"

# 唔使 verify，純公開只讀數據
_SSL = ssl.create_default_context()
_SSL.check_hostname = False
_SSL.verify_mode = ssl.CERT_NONE


# ---------------------------------------------------------------------------- HTTP
def _get(url, timeout=12, retries=2):
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "en-US,en;q=0.9",
                "Referer": "https://www.nasdaq.com/",
            })
            with urllib.request.urlopen(req, timeout=timeout, context=_SSL) as r:
                raw = r.read().decode("utf-8", "replace")
            if not raw.strip():
                raise ValueError("empty")
            return json.loads(raw)
        except Exception as e:                              # noqa: BLE001
            last = e
            if attempt < retries:
                time.sleep(0.4 * (attempt + 1))
    raise RuntimeError(str(last))


def num(s):
    if s is None:
        return None
    t = str(s).strip()
    if t in ("", "--", "—", "-", "N/A", "null"):
        return None
    neg = t.startswith("-")
    t = t.lstrip("+-").replace("$", "").replace(",", "").replace("%", "").strip()
    try:
        v = float(t)
    except ValueError:
        return None
    return -v if neg else v


# ---------------------------------------------------------------------------- Stage 1 池子
def _kfmt(v):
    """股數縮寫：1.1亿 / 3500万"""
    try:
        v = float(v)
    except Exception:                                      # noqa: BLE001
        return "—"
    if v >= 1e8:
        return "%.2f亿" % (v / 1e8)
    if v >= 1e4:
        return "%.0f万" % (v / 1e4)
    return "%.0f" % v


def fetch_universe(args):
    """由 screener 攞全市場，過濾後按成交額拎 Top N。"""
    print("→ 池子：由 Nasdaq screener 取全市場 ...")
    rows = []
    offset = 0
    page = 2500
    while True:
        url = "%s/api/screener/stocks?tableonly=true&limit=%d&offset=%d&download=true" % (
            BASE, page, offset)
        try:
            j = _get(url, timeout=45, retries=2)
        except Exception as e:                              # noqa: BLE001
            print("  ! screener 第 %d 頁失敗：%s" % (offset, e))
            break
        d = (j or {}).get("data") or {}
        chunk = d.get("rows") or []
        rows.extend(chunk)
        if len(chunk) < page:
            break
        offset += page
        if offset > 12000:
            break
    print("   screener 共 %d 檔" % len(rows))

    cands = []
    seen = set()
    for r in rows:
        sym = (r.get("symbol") or "").strip().upper()
        if not sym or "/" in sym or "." in sym or "^" in sym:
            continue                       # 掉單位信託、優先股、指數
        if len(sym) > 5:
            continue                       # 掉權證之類
        # screener 會把同一批資料重複返 5 份（實測 35660 = 7132 × 5）。
        # 唔去重嘅話一檔會抓 5 次、評 5 次，池子實際得 12 檔。
        if sym in seen:
            continue
        seen.add(sym)
        mc = num(r.get("marketCap"))
        vol = num(r.get("volume"))
        px = num(r.get("lastsale"))
        if mc is None or vol is None or px is None:
            continue
        if mc < args.min_mcap:
            continue
        if not (args.min_price <= px <= args.max_price):
            continue
        if vol < args.min_volume:
            continue
        cands.append({
            "symbol": sym, "name": r.get("name"),
            "price": px, "volume": vol, "marketCap": mc,
            "dollarVol": vol * px,
            "sector": r.get("sector"), "industry": r.get("industry"),
        })

    # 資金聚焦要睇「成交額」而唔係「股數」。
    # 用股數排會全部係低價股（實測 Top 係 WBD $30 1.1億股、NOK $10 1.07億股），
    # 完全唔係市場熱點；用股數×股價排先係真正嘅資金流。
    cands.sort(key=lambda c: c["dollarVol"], reverse=True)
    picked = cands[:args.top]
    print("   過濾後 %d 檔合格，取成交額 Top %d" % (len(cands), len(picked)))
    for c in picked[:10]:
        print("      %-5s $%-9.0f亿  px=%-8s vol=%s" % (
            c["symbol"], c["dollarVol"] / 1e8, c["price"], _kfmt(c["volume"])))
    return picked


# ---------------------------------------------------------------------------- Stage 2 單檔深度抓取
def _parse_earnings_date(sym):
    """下次財報日。Nasdaq 用自然語言畀，要自己摳日期出嚟。"""
    try:
        j = _get("%s/api/analyst/%s/earnings-date" % (BASE, sym), timeout=10)
        txt = ((j or {}).get("data") or {}).get("reportText") or ""
        m = None
        import re
        m = re.search(r"report earnings on\s+(\d{1,2}/\d{1,2}/\d{4})", txt)
        if not m:
            m = re.search(r"(\d{1,2}/\d{1,2}/\d{4})", txt)
        if not m:
            return None
        mm, dd, yy = m.group(1).split("/")
        return "%s-%s-%s" % (yy, mm.zfill(2), dd.zfill(2))
    except Exception:                                       # noqa: BLE001
        return None


def _parse_earnings_surprise(sym):
    """過去各季財報後單日實際變動幅度，用嚟判斷 straddle 值唔值。"""
    try:
        j = _get("%s/api/company/%s/earnings-surprise" % (BASE, sym), timeout=10)
        rows = (((j or {}).get("data") or {}).get("earningsSurpriseTable") or {}).get("rows") or []
        out = []
        for r in rows:
            d = r.get("dateReported")
            if not d:
                continue
            try:
                mm, dd, yy = d.split("/")
                out.append({"date": "%s-%s-%s" % (yy, mm.zfill(2), dd.zfill(2)),
                            "surprisePct": num(r.get("percentageSurprise"))})
            except Exception:                               # noqa: BLE001
                pass
        return out
    except Exception:                                       # noqa: BLE001
        return []


def _parse_ratings(sym):
    try:
        j = _get("%s/api/analyst/%s/ratings" % (BASE, sym), timeout=10)
        d = (j or {}).get("data") or {}
        return {"mean": d.get("meanRatingType"),
                "summary": d.get("ratingsSummary"),
                "count": len(d.get("brokerNames") or [])}
    except Exception:                                       # noqa: BLE001
        return {}


def _parse_short(sym):
    try:
        j = _get("%s/api/quote/%s/short-interest?assetClass=stocks" % (BASE, sym), timeout=10)
        rows = (((j or {}).get("data") or {}).get("shortInterestTable") or {}).get("rows") or []
        if not rows:
            return {}
        r = rows[0]
        return {"interest": num(r.get("interest")),
                "avgDailyVolume": num(r.get("avgDailyShareVolume")),
                "daysToCover": num(r.get("daysToCover")),
                "settlement": r.get("settlementDate")}
    except Exception:                                       # noqa: BLE001
        return {}


def _parse_institutional(sym):
    try:
        j = _get("%s/api/company/%s/institutional-holdings" % (BASE, sym), timeout=10)
        d = (j or {}).get("data") or {}
        own = (d.get("ownershipSummary") or {}).get("SharesOutstandingPCT") or {}
        inc = dec = 0
        for row in ((d.get("activePositions") or {}).get("rows") or []):
            label = (row.get("positions") or "").lower()
            h = num(row.get("holders")) or 0
            if "increased" in label:
                inc = h
            elif "decreased" in label:
                dec = h
        return {"ownershipPct": num(own.get("value")), "holdersIncreased": inc, "holdersDecreased": dec}
    except Exception:                                       # noqa: BLE001
        return {}


def _parse_history(sym, asset="stocks", years=1.2):
    end = datetime.date.today()
    start = end - datetime.timedelta(days=int(365 * years))
    j = _get("%s/api/quote/%s/historical?assetclass=%s&fromdate=%s&todate=%s&limit=9999"
             % (BASE, sym, asset, start.isoformat(), end.isoformat()), timeout=15)
    rows = (((j or {}).get("data") or {}).get("tradesTable") or {}).get("rows") or []
    out = []
    for r in rows:
        c = num(r.get("close"))
        if not (c and c > 0):
            continue
        try:
            mm, dd, yy = r["date"].split("/")
            dt = "%s-%s-%s" % (yy, mm.zfill(2), dd.zfill(2))
        except Exception:                                   # noqa: BLE001
            continue
        out.append({"date": dt, "open": num(r.get("open")), "high": num(r.get("high")),
                    "low": num(r.get("low")), "close": c, "volume": num(r.get("volume"))})
    out.sort(key=lambda x: x["date"])
    return out


def _parse_chain(sym, months=3, asset="stocks"):
    today = datetime.date.today()
    end = today + datetime.timedelta(days=int(30.4 * months))
    j = _get("%s/api/quote/%s/option-chain?assetclass=%s&fromdate=%s&todate=%s&limit=99999"
             % (BASE, sym, asset, today.isoformat(), end.isoformat()), timeout=30)
    rows = (((j or {}).get("data") or {}).get("table") or {}).get("rows") or []
    chains, cur = [], None
    for r in rows:
        if r.get("expirygroup"):
            try:
                dt = datetime.datetime.strptime(r["expirygroup"], "%B %d, %Y").strftime("%Y-%m-%d")
            except Exception:                               # noqa: BLE001
                continue
            cur = {"expiry": dt, "raw": r["expirygroup"], "calls": [], "puts": []}
            chains.append(cur)
            continue
        if cur is None:
            continue
        K = num(r.get("strike"))
        if K is None:
            continue
        for side, pre in (("calls", "c_"), ("puts", "p_")):
            bid, ask, last = num(r.get(pre + "Bid")), num(r.get(pre + "Ask")), num(r.get(pre + "Last"))
            if bid is None and ask is None and last is None:
                continue
            cur[side].append({"strike": K, "bid": bid, "ask": ask, "last": last,
                              "volume": int(num(r.get(pre + "Volume")) or 0),
                              "openInterest": int(num(r.get(pre + "Openinterest")) or 0)})
    return [c for c in chains if c["calls"] or c["puts"]]


def _assetclass(sym):
    """ETF（SPY/QQQ/IWM 等）要用 assetclass=etf，否則報價同鏈都係空。"""
    if sym in ("SPY", "QQQ", "IWM", "DIA", "VOO", "VTI", "EEM", "XLF", "XLK", "XLE",
               "TLT", "GLD", "SLV", "ARKK", "KWEB", "SOXL", "TQQQ", "SQQQ"):
        return "etf"
    return "stocks"


def scan_one(sym, months=3, verbose=False):
    """單檔深度抓取。任何子項目失敗都唔會令成檔報廢，只係標 missing。"""
    rec = {"symbol": sym, "ok": True, "missing": []}
    ac = _assetclass(sym)

    def guard(key, fn, default=None):
        try:
            v = fn()
            if v in (None, [], {}):
                rec["missing"].append(key)
                return default
            return v
        except Exception as e:                              # noqa: BLE001
            rec["missing"].append(key)
            if verbose:
                sys.stderr.write("   %s %s 失敗：%s\n" % (sym, key, e))
            return default

    def quote_of(asset):
        return _get("%s/api/quote/%s/info?assetclass=%s" % (BASE, sym, asset), timeout=12)

    quote = guard("quote", lambda: quote_of(ac))
    # 股票試唔到就當 ETF 再試一次（Nasdaq 嘅分類有時唔跟常識）
    if not quote and ac == "stocks":
        quote = guard("quote", lambda: quote_of("etf"))
        if quote:
            ac = "etf"
    if quote:
        d = (quote.get("data") or {})
        p = d.get("primaryData") or {}
        s = d.get("secondaryData") or {}
        rec["quote"] = {
            "symbol": (d.get("symbol") or sym).upper(),
            "name": d.get("companyName"),
            "price": num(p.get("lastSalePrice")) or num(s.get("lastSalePrice")),
            "bid": num(p.get("bidPrice")) or num(s.get("bidPrice")),
            "ask": num(p.get("askPrice")) or num(s.get("askPrice")),
            "volume": num(p.get("volume")) or num(s.get("volume")),
            "change": num(p.get("netChange")),
            "changePct": num(p.get("percentageChange")),
            "asOf": p.get("lastTradeTimestamp"),
            "assetclass": ac,
        }
    rec["history"] = guard("history", lambda: _parse_history(sym, ac), [])
    rec["chains"] = guard("chain", lambda: _parse_chain(sym, months, ac), [])
    rec["earningsDate"] = guard("earnings", lambda: _parse_earnings_date(sym))
    rec["earningsHistory"] = guard("earningsHist", lambda: _parse_earnings_surprise(sym), [])
    rec["ratings"] = guard("ratings", lambda: _parse_ratings(sym), {})
    rec["short"] = guard("short", lambda: _parse_short(sym), {})
    rec["institutional"] = guard("inst", lambda: _parse_institutional(sym), {})

    # 冇報價又冇鏈 → 呢檔徹底廢
    if not rec.get("quote") and not rec.get("chains"):
        rec["ok"] = False
    return rec


# ---------------------------------------------------------------------------- 主流程
def main():
    ap = argparse.ArgumentParser(description="OptionDesk 每日掃描器（免費、免 key）")
    ap.add_argument("--top", type=int, default=60, help="掃描池大小（默認 60）")
    ap.add_argument("--symbols", default=None, help="直接指定代碼，逗號分隔（跳過 screener）")
    ap.add_argument("--workers", type=int, default=8, help="並行數（默認 8）")
    ap.add_argument("--months", type=float, default=3, help="期權到期日範圍（月）")
    ap.add_argument("--min-mcap", type=float, default=2e9, help="最小市值（默認 20 億）")
    ap.add_argument("--min-volume", type=float, default=1e6, help="最小成交量（默認 100 萬股）")
    ap.add_argument("--min-price", type=float, default=8.0, help="最低股價")
    ap.add_argument("--max-price", type=float, default=800.0, help="最高股價（AMD 已 600+，400 會篩走佢）")
    # 注意：help 字串入面嘅 % 要寫成 %%，否則 argparse 會當格式化符，--help 直接崩
    ap.add_argument("--rate", type=float, default=0.04, help="無風險利率（默認 4%%）")
    ap.add_argument("--out", default=None, help="輸出 scan JSON 路徑")
    ap.add_argument("--skip-fetch", default=None, help="用現有 raw 檔重新評分，唔再抓")
    ap.add_argument("--build", action="store_true", help="掃完即烤入 OptionDesk.html")
    ap.add_argument("--keep-raw", action="store_true", help="保留 raw 抓取檔（默認保留）")
    args = ap.parse_args()

    os.makedirs(SCAN_DIR, exist_ok=True)
    today = datetime.date.today().isoformat()

    # ---- Stage 1 & 2 ----
    if args.skip_fetch:
        raw_path = args.skip_fetch
        if not os.path.isabs(raw_path):
            raw_path = os.path.join(HERE, raw_path)
        print("→ 跳過抓取，讀取 %s" % raw_path)
        with io.open(raw_path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    else:
        if args.symbols:
            universe = [{"symbol": s.strip().upper()} for s in args.symbols.split(",") if s.strip()]
            print("→ 指定池子：%d 檔" % len(universe))
        else:
            universe = fetch_universe(args)

        print("→ 深度抓取 %d 檔（%d 條並行）..." % (len(universe), args.workers))
        t0 = time.time()
        raw = {"date": today, "rate": args.rate, "universe": universe, "records": [],
               "params": {"top": args.top, "months": args.months, "minMcap": args.min_mcap,
                          "minVolume": args.min_volume}}
        done = [0]
        with cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
            futures = {ex.submit(scan_one, u["symbol"], args.months): u for u in universe}
            for fut in cf.as_completed(futures):
                rec = fut.result()
                # 補返 screener 嘅市值/板塊入去
                u = futures[fut]
                if isinstance(rec.get("quote"), dict):
                    for k in ("marketCap", "sector", "industry"):
                        if k in u and rec["quote"].get(k) in (None, ""):
                            rec["quote"][k] = u[k]
                raw["records"].append(rec)
                done[0] += 1
                if done[0] % 10 == 0 or done[0] == len(universe):
                    print("   %d/%d  (%.0fs)" % (done[0], len(universe), time.time() - t0))
        raw["fetchSeconds"] = round(time.time() - t0, 1)
        ok = sum(1 for r in raw["records"] if r.get("ok"))
        print("   抓取完成：%d/%d 成功，耗時 %.0fs" % (ok, len(raw["records"]), raw["fetchSeconds"]))

        raw_path = os.path.join(SCAN_DIR, "raw-%s.json" % today)
        with io.open(raw_path, "w", encoding="utf-8") as f:
            json.dump(raw, f, ensure_ascii=False, separators=(",", ":"))
        print("   原始檔：%s (%.0f KB)" % (raw_path, os.path.getsize(raw_path) / 1024.0))

    # ---- Stage 3 評分（交畀 node，復用 engine.js）----
    if not os.path.exists(SCORE_JS):
        raise SystemExit("缺少評分模組：%s" % SCORE_JS)
    out_path = args.out or os.path.join(SCAN_DIR, "scan-%s.json" % today)
    if not os.path.isabs(out_path):
        out_path = os.path.join(HERE, out_path)

    print("→ 評分（node src/score.js）...")
    t1 = time.time()
    proc = subprocess.run(["node", SCORE_JS, raw_path, out_path],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout or "")
        sys.stderr.write(proc.stderr or "")
        raise SystemExit("評分失敗（exit %d）" % proc.returncode)
    if proc.stdout.strip():
        print(proc.stdout.rstrip())
    print("   評分耗時 %.1fs" % (time.time() - t1))

    # latest.json 方便 build 抓
    latest = os.path.join(SCAN_DIR, "latest.json")
    with io.open(out_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    with io.open(latest, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))

    print("\n✓ 掃描完成 → %s (%.1f KB)" % (out_path, os.path.getsize(out_path) / 1024.0))
    summary = data.get("summary") or {}
    print("  池子 %s 檔 · 存活 %s 檔 · 值得睇 %s 檔" %
          (summary.get("scanned", "?"), summary.get("survived", "?"), summary.get("actionable", "?")))

    # ---- Stage 4 烤入 ----
    if args.build:
        print("\n→ 烤入 OptionDesk.html ...")
        subprocess.run([sys.executable, os.path.join(HERE, "build.py"),
                        "--scan", out_path], cwd=HERE)


if __name__ == "__main__":
    main()
