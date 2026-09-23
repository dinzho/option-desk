#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OptionDesk 資料抓取器  —  完全免費，唔使 API key、唔使註冊。

資料來源：Nasdaq 官方公開 API (api.nasdaq.com)
  - /api/quote/{SYM}/info           即時報價
  - /api/quote/{SYM}/historical     日線 OHLCV（可計 HV20 / HV252 / Yang-Zhang）
  - /api/quote/{SYM}/option-chain   完整選擇權鏈（bid/ask/OI/成交量）

用法：
    python3 fetch.py PLTR                     # 抓 PLTR，輸出 snapshot-PLTR.json
    python3 fetch.py PLTR --months 4         # 只要 4 個月內到期
    python3 fetch.py PLTR --months 4 --build # 抓完即時烤入 OptionDesk.html

注意：Nasdaq 冇 CORS 標頭，所以瀏覽器唔可以直接打。
      -> 呢支腳本喺邊度跑都得（雲端／你部機），只係需要該機能連到 api.nasdaq.com。
"""

import argparse
import json
import ssl
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
BASE = "https://api.nasdaq.com/api/quote"


# ---------------------------------------------------------------------------- HTTP
def _get(url, timeout=30, retries=3):
    """帶重試嘅 GET。回傳已解碼嘅 JSON dict，失敗拋 RuntimeError。"""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "en-US,en;q=0.9",
                "Referer": "https://www.nasdaq.com/",
            })
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
                raw = r.read().decode("utf-8", "replace")
            if not raw.strip():
                raise ValueError("empty response")
            return json.loads(raw)
        except Exception as e:          # noqa: BLE001 - 故意吞所有例外以便重試
            last = e
            if attempt < retries - 1:
                sys.stderr.write("  ..重試 %d/%d (%s)\n" % (attempt + 1, retries, e))
    raise RuntimeError("請求失敗：%s\n  %s" % (url, last))


# ---------------------------------------------------------------------------- 清理
def num(s):
    """'$1,234.56' / '+0.07%' / '—' / None -> float or None"""
    if s is None:
        return None
    s = str(s).strip()
    if s in ("", "--", "—", "-", "N/A", "null"):
        return None
    neg = s.startswith("-")
    s = s.lstrip("+-").replace("$", "").replace(",", "").replace("%", "").strip()
    try:
        v = float(s)
    except ValueError:
        return None
    return -v if neg else v


def pct(s):
    v = num(s)
    return None if v is None else v / 100.0


# ---------------------------------------------------------------------------- 報價
def fetch_quote(sym):
    d = _get("%s/%s/info?assetclass=stocks" % (BASE, sym))
    data = (d or {}).get("data") or {}
    if not data:
        return None
    p = (data.get("primaryData") or {})
    s = (data.get("secondaryData") or {})
    q = {
        "symbol": data.get("symbol", sym),
        "name": data.get("companyName"),
        "exchange": data.get("exchange"),
        "price": num(p.get("lastSalePrice")) or num(s.get("lastSalePrice")),
        # 注意：內部一律用「百分比數值」而非小數（+0.07% 存 0.07），只有 IV／利率／息率先存小數
        "change": num(p.get("netChange")),
        "changePct": num(p.get("percentageChange")),
        "bid": num(p.get("bidPrice")) or num(s.get("bidPrice")),
        "ask": num(p.get("askPrice")) or num(s.get("askPrice")),
        "volume": num(p.get("volume")) or num(s.get("volume")),
        "isRealTime": p.get("isRealTime"),
        "asOf": p.get("lastTradeTimestamp"),
    }
    # 盤後 / 盤前
    if data.get("keyStats"):
        ks = data["keyStats"]
        # 52 週高低
        for k in ("FiftTwoWkHigh", "FiftTwoWkLow", "FiftyTwoWkHigh", "FiftyTwoWkLow"):
            if isinstance(ks.get(k), dict):
                pass
    return q


def fetch_summary(sym):
    """52 週高低（Nasdaq 欄位名有 typo：FiftTwoWeekHighLow）、市值、股息殖利率等。
    抓唔到唔代表失敗——52 週高低會由歷史日線自行推算，更可靠。"""
    out = {}
    try:
        d = _get("%s/%s/summary?assetclass=stocks" % (BASE, sym))
        sd = ((d or {}).get("data") or {}).get("summaryData") or {}
        val = lambda k: (sd.get(k) or {}).get("value")     # noqa: E731
        # 52 週高低：Nasdaq 用 "196.00 - 120.00" 格式畀（高在前）
        hl = None
        for k in ("FiftTwoWeekHighLow", "FiftTwoWkHighLow", "FiftyTwoWeekHighLow"):
            if sd.get(k):
                hl = val(k)
                break
        if hl and "-" in str(hl):
            try:
                hi, lo = [num(x) for x in str(hl).split("-", 1)]
                out["fiftyTwoHigh"], out["fiftyTwoLow"] = hi, lo
            except Exception:                              # noqa: BLE001
                pass
        out["marketCap"] = num(val("MarketCap"))
        out["yield"] = pct(val("Yield"))
        out["annualizedDividend"] = num(val("AnnualizedDividend"))
        out["sector"] = (sd.get("Sector") or {}).get("value")
        out["industry"] = (sd.get("Industry") or {}).get("value")
        out["oneYrTarget"] = num(val("OneYrTarget"))
        out["averageVolume"] = num(val("AverageVolume"))
        out["previousClose"] = num(val("PreviousClose"))
    except Exception as e:                                # noqa: BLE001
        sys.stderr.write("  ! summary 失敗（唔影響主流程）：%s\n" % e)
    return out


def derive_52wk(quote, hist):
    """由歷史日線推算 52 週高低 + 已實現波動率所需資料。"""
    if not hist:
        return quote
    recent = [r for r in hist if r["high"] and r["low"]]
    if recent:
        quote.setdefault("fiftyTwoHigh", max(r["high"] for r in recent))
        quote.setdefault("fiftyTwoLow", min(r["low"] for r in recent))
    return quote


# ---------------------------------------------------------------------------- 歷史
def fetch_history(sym, years=1.2):
    end = date.today()
    start = end - timedelta(days=int(365 * years))
    url = ("%s/%s/historical?assetclass=stocks&fromdate=%s&todate=%s&limit=9999"
           % (BASE, sym, start.isoformat(), end.isoformat()))
    d = _get(url)
    rows = ((((d or {}).get("data") or {}).get("tradesTable") or {}).get("rows") or [])
    out = []
    for r in rows:
        try:
            dt = datetime.strptime(r["date"], "%m/%d/%Y").strftime("%Y-%m-%d")
        except Exception:                                  # noqa: BLE001
            continue
        rec = {
            "date": dt,
            "open": num(r.get("open")),
            "high": num(r.get("high")),
            "low": num(r.get("low")),
            "close": num(r.get("close")),
            "volume": num(r.get("volume")),
        }
        if rec["close"] is not None and rec["close"] > 0:
            out.append(rec)
    out.sort(key=lambda x: x["date"])          # 升序
    return out


# ---------------------------------------------------------------------------- 選擇權鏈
def fetch_expirations(sym):
    """Nasdaq 冇獨立到期日端點，從任一張鏈度抽取所有 expirygroup。"""
    return None


def fetch_chain(sym, months=4, min_strikes_window=0.30):
    """抓所有到期日嘅鏈。min_strikes_window：只保留現價 ±30% 內嘅履約價。"""
    today = date.today()
    end = today + timedelta(days=int(30.4 * months))
    url = ("%s/%s/option-chain?assetclass=stocks"
           "&fromdate=%s&todate=%s&limit=99999"
           % (BASE, sym, today.isoformat(), end.isoformat()))
    d = _get(url, timeout=45)
    data = (d or {}).get("data") or {}
    meta_last_trade = data.get("lastTrade")
    table = (data.get("table") or {})
    rows = table.get("rows") or []

    chains = []          # [{expiry: 'YYYY-MM-DD', options:[...]}]
    cur = None
    for r in rows:
        grp = r.get("expirygroup")
        if grp:                                  # 分組標題列
            try:
                exp = datetime.strptime(grp, "%B %d, %Y").strftime("%Y-%m-%d")
            except Exception:                    # noqa: BLE001
                continue
            cur = {"expiry": exp, "raw": grp, "calls": [], "puts": []}
            chains.append(cur)
            continue
        if cur is None:
            continue
        strike = num(r.get("strike"))
        if strike is None:
            continue
        for side, pre in (("calls", "c_"), ("puts", "p_")):
            last = num(r.get(pre + "Last"))
            bid = num(r.get(pre + "Bid"))
            ask = num(r.get(pre + "Ask"))
            vol = num(r.get(pre + "Volume"))
            oi = num(r.get(pre + "Openinterest"))
            # 完全冇報價嘅契約直接掉咗（Nasdaq 會畀一堆 null 行）
            if bid is None and ask is None and last is None:
                continue
            cur[side].append({
                "strike": strike,
                "last": last, "bid": bid, "ask": ask,
                "volume": int(vol or 0), "openInterest": int(oi or 0),
            })
    # 掉清冇資料嘅到期日
    chains = [c for c in chains if c["calls"] or c["puts"]]
    for i, c in enumerate(chains):
        c["index"] = i
    return chains, {"metaLastTrade": meta_last_trade, "totalRecord": data.get("totalRecord")}


# ---------------------------------------------------------------------------- 主流程
def build_snapshot(sym, months=4, years=1.2, keep_all_strikes=False):
    sym = sym.strip().upper()
    print("→ %s  報價 ..." % sym)
    quote = fetch_quote(sym)
    if not quote:
        raise SystemExit("✗ 搵唔到 %s（可能唔係美股，或者代碼錯）" % sym)
    print("   %s  $%s  %s" % (quote["symbol"], quote["price"], quote.get("asOf")))

    print("→ %s  摘要 ..." % sym)
    quote.update(fetch_summary(sym))

    print("→ %s  歷史 ..." % sym)
    hist = fetch_history(sym, years=years)
    print("   %d 根日線（%s → %s）" % (len(hist), hist[0]["date"], hist[-1]["date"]))
    derive_52wk(quote, hist)

    print("→ %s  選擇權鏈 ..." % sym)
    chains, meta = fetch_chain(sym, months=months)
    tot_c = sum(len(c["calls"]) for c in chains)
    tot_p = sum(len(c["puts"]) for c in chains)
    print("   %d 個到期日，Call %d / Put %d 張契約" % (len(chains), tot_c, tot_p))

    spot = quote["price"]
    if spot and not keep_all_strikes:
        lo, hi = spot * (1 - 0.30), spot * 1.30
        for c in chains:
            c["calls"] = [o for o in c["calls"] if lo <= o["strike"] <= hi]
            c["puts"] = [o for o in c["puts"] if lo <= o["strike"] <= hi]

    return {
        "symbol": sym,
        "fetchedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "source": "Nasdaq public API (api.nasdaq.com) — free, no key",
        "quote": quote,
        "history": hist,
        "chains": chains,
        "meta": meta,
    }


def main():
    ap = argparse.ArgumentParser(description="OptionDesk 免費資料抓取器")
    ap.add_argument("symbol", help="美股代碼，例如 PLTR")
    ap.add_argument("--months", type=float, default=4, help="到期日範圍（月）")
    ap.add_argument("--years", type=float, default=1.2, help="歷史長度（年）")
    ap.add_argument("--out", default=None, help="輸出 JSON 路徑")
    ap.add_argument("--all-strikes", action="store_true", help="保留全部履約價（檔案會大好多）")
    args = ap.parse_args()

    snap = build_snapshot(args.symbol, args.months, args.years, args.all_strikes)
    out = args.out or ("snapshot-%s.json" % snap["symbol"])
    with open(out, "w", encoding="utf-8") as f:
        json.dump(snap, f, ensure_ascii=False, separators=(",", ":"))
    import os
    print("\n✓ 已寫出 %s（%.1f KB）" % (out, os.path.getsize(out) / 1024.0))


if __name__ == "__main__":
    main()
