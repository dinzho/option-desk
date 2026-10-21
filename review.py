#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
績效覆盤（review.py）—— 每日掃描後自動跑，跟進過往「可出手」建議嘅實際結果。

指標定義（UI 顯示同報告都用呢套，唔可以隱瞞）：
  信號命中（10 個交易日）：
    買方結構（debit）：任一日 high >= 上損平，或 low <= 下損平 → 盈利區間被觸及
    賣方結構（credit）：第 10 個交易日 close 仍處於 [下損平, 上損平] → 區間守住
  到期結算：
    到期日（或之後首個交易日）close 代入結構腿，計出每手（100 股）盈虧；
    win = 每手盈虧 > 0。pnlPct = 盈虧 / 淨權利金（賣方即回報／收取嘅權利金）。

repo 體積控制（用戶明確要求唔好撐爆 repo）：
  perf.json 只保留「最近 90 筆已完全結算」+「所有未結算」紀錄；
  更舊嘅已併入累計摘要後刪除 → 檔案大小有上限（約 40-50KB），不會每日變大。
  超過 60 日仍拿不到結算價（API 壞咗）嘅紀錄標記 no-data，唔會無限累積。

用法：
  python3 review.py                      # 用預設路徑（scan/ → scan/perf.json）
  python3 review.py --keep 90 --verbose  # 參數見 --help
"""

import argparse
import glob
import io
import json
import os
import re
import sys
import time
import datetime

import requests

HERE = os.path.dirname(os.path.abspath(__file__))

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

# 可出手判定要同 score.js / dashboard 完全一致
SCORE_MIN = 65


def log(msg):
    print(msg)
    sys.stdout.flush()


# ---------------------------------------------------------------- 歷史價格

def _num(v):
    """Nasdaq 數值帶 '$' 同千位逗號，例如 '$339.50' / '35,851,380'。"""
    if v is None:
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).replace("$", "").replace(",", "").strip()
    try:
        return float(s)
    except ValueError:
        return 0.0


def fetch_history(symbol, from_date, to_date, retries=2):
    """Nasdaq 歷史日線（ascending）。失敗 return None，唔 raise——覆盤要容忍單隻壞檔。"""
    url = ("https://api.nasdaq.com/api/quote/%s/historical?assetclass=stocks"
           "&fromdate=%s&todate=%s&limit=9999" % (
               requests.utils.quote(symbol, safe=""),
               from_date.isoformat(), to_date.isoformat()))
    for attempt in range(retries):
        try:
            r = requests.get(url, headers={"User-Agent": UA, "Accept": "application/json"},
                             timeout=15)
            if r.status_code != 200:
                raise RuntimeError("HTTP %s" % r.status_code)
            j = r.json()
            rows = (((j or {}).get("data") or {}).get("tradesTable") or {}).get("rows") or []
            out = []
            for row in rows:
                m = re.match(r"^(\d{2})/(\d{2})/(\d{4})$", row.get("date") or "")
                if not m:
                    continue
                rec = {
                    "date": datetime.date(int(m.group(3)), int(m.group(1)), int(m.group(2))),
                    "high": _num(row.get("high")),
                    "low": _num(row.get("low")),
                    "close": _num(row.get("close")),
                }
                if rec["close"] > 0:
                    out.append(rec)
            out.sort(key=lambda x: x["date"])
            return out if out else None
        except Exception as e:
            if attempt == retries - 1:
                log("  ! %s 歷史抓取失敗：%s" % (symbol, e))
                return None
            time.sleep(1.5)


def nth_trading_day_after(hist, start_date, n):
    """start_date 之後第 n 個交易日（唔計 start_date 當日）。唔夠 return None。"""
    days = [r["date"] for r in hist if r["date"] > start_date]
    return days[n - 1] if len(days) >= n else None


def first_row_on_or_after(hist, d):
    for r in hist:
        if r["date"] >= d:
            return r
    return None


# ---------------------------------------------------------------- 結構盈虧

def payoff_per_share(price, legs):
    """到期結算：每成份股盈虧（正數=賺）。legs = [{act, kind, K, mid}]"""
    total = 0.0
    for L in legs or []:
        K = float(L.get("K") or 0)
        mid = float(L.get("mid") or 0)
        intr = max(price - K, 0.0) if L.get("kind") == "call" else max(K - price, 0.0)
        if L.get("act") == "sell":
            total += mid - intr
        else:
            total += intr - mid
    return total


# ---------------------------------------------------------------- 紀錄處理

def load_scans(scans_dir):
    """讀所有 scan-*.json，拎出可出手建議。"""
    out = []
    for path in sorted(glob.glob(os.path.join(scans_dir, "scan-*.json"))):
        try:
            with io.open(path, "r", encoding="utf-8") as f:
                d = json.load(f)
        except Exception as e:
            log("  ! 讀取 %s 失敗：%s" % (os.path.basename(path), e))
            continue
        scan_date = d.get("date")
        if not scan_date:
            continue
        try:
            sday = datetime.date(*[int(x) for x in scan_date.split("-")])
        except ValueError:
            continue
        for r in d.get("results") or []:
            score = r.get("score") or 0
            if score < SCORE_MIN or not r.get("multiTrigger"):
                continue
            st = r.get("structure") or {}
            legs = st.get("legs") or []
            be = st.get("breakEven") or {}
            if not legs or be.get("lower") is None or be.get("upper") is None:
                continue
            debit, credit = st.get("debit"), st.get("credit")
            net = debit if isinstance(debit, (int, float)) else (
                credit if isinstance(credit, (int, float)) else None)
            if net is None or net <= 0:
                continue
            out.append({
                "key": "%s@%s" % (r.get("symbol"), scan_date),
                "sym": r.get("symbol"),
                "date": scan_date,
                "_sday": sday,
                "tag": r.get("tag") or "",
                "score": round(float(score), 1),
                "struct": st.get("name") or "",
                "dir": "sell" if isinstance(credit, (int, float)) else "buy",
                "be": {"lower": float(be["lower"]), "upper": float(be["upper"])},
                "scanPrice": float(r.get("price") or 0),
                "expiry": st.get("expiry") or "",
                "legs": [{"act": L.get("act"), "kind": L.get("kind"),
                          "K": float(L.get("K") or 0), "mid": float(L.get("mid") or 0)}
                         for L in legs],
                "net": float(net),
            })
    return out


def blank_record(rec):
    return {
        "sym": rec["sym"], "date": rec["date"], "tag": rec["tag"], "score": rec["score"],
        "struct": rec["struct"], "dir": rec["dir"], "be": rec["be"],
        "scanPrice": rec["scanPrice"], "expiry": rec["expiry"], "net": rec["net"],
        "legs": rec["legs"],
        "chk10": None,   # {"due":..., "close":..., "hit": true/false}
        "exp": None,     # {"date":..., "close":..., "pnlPerLot":..., "pnlPct":..., "win":...}
        "status": "pending",
    }


def resolve_record(rec, hist, today):
    """用歷史數據補齊 chk10 / exp。就嚟唔到數據就保持 pending。"""
    sday = datetime.date(*[int(x) for x in rec["date"].split("-")])
    lower, upper = rec["be"]["lower"], rec["be"]["upper"]

    # ---- chk10：建議後第 10 個交易日 ----
    if rec["chk10"] is None and hist:
        due = nth_trading_day_after(hist, sday, 10)
        if due is not None and due <= today:
            rows = [r for r in hist if sday < r["date"] <= due]
            if len(rows) >= 10:
                if rec["dir"] == "sell":
                    hit = all(lower <= r["close"] <= upper for r in rows)
                else:
                    hit = any(r["high"] >= upper or r["low"] <= lower for r in rows)
                rec["chk10"] = {"due": due.isoformat(),
                                "close": rows[-1]["close"], "hit": bool(hit)}

    # ---- exp：到期結算 ----
    if rec["exp"] is None and rec["expiry"]:
        try:
            xday = datetime.date(*[int(x) for x in rec["expiry"].split("-")])
        except ValueError:
            xday = None
        if xday is not None and hist and xday <= today:
            row = first_row_on_or_after(hist, xday)
            if row is not None:
                pnl = payoff_per_share(row["close"], rec["legs"]) * 100.0
                rec["exp"] = {
                    "date": row["date"].isoformat(), "close": row["close"],
                    "pnlPerLot": round(pnl, 2),
                    "pnlPct": round(pnl / (rec["net"] * 100.0), 4),
                    "win": bool(pnl > 0),
                }

    # ---- 狀態 ----
    if rec["chk10"] is not None and rec["exp"] is not None:
        rec["status"] = "done"
    elif rec["exp"] is None and rec["expiry"] and \
            datetime.date(*[int(x) for x in rec["expiry"].split("-")]) < today - datetime.timedelta(days=60):
        # 超過 60 日都拿唔到結算價：標記後剔除，防止紀錄無限累積
        rec["exp"] = {"date": None, "close": None, "pnlPerLot": None,
                      "pnlPct": None, "win": None, "status": "no-data"}
        rec["status"] = "done"


def summarize(records, today=None):
    """由紀錄清單直接計數（唔靠舊摘要，避免重複計錯數）。

    touchTotal = chk10 已出結果嘅紀錄數（10 個交易日信號）
    settled   = 到期已結算嘅紀錄數
    """
    touch_total = sum(1 for r in records if r.get("chk10") is not None)
    touch_hit = sum(1 for r in records if (r.get("chk10") or {}).get("hit"))
    settled = [r for r in records
               if (r.get("exp") or {}).get("pnlPerLot") is not None]
    settle_win = sum(1 for r in settled if r["exp"]["win"])
    pnl_sum = sum(r["exp"]["pnlPct"] for r in settled)
    by_tag = {}
    for r in records:
        t = by_tag.setdefault(r["tag"], {"tracked": 0, "touchHit": 0,
                                         "settled": 0, "settleWin": 0})
        t["tracked"] += 1
        if (r.get("chk10") or {}).get("hit"):
            t["touchHit"] += 1
        if (r.get("exp") or {}).get("pnlPerLot") is not None:
            t["settled"] += 1
            if r["exp"]["win"]:
                t["settleWin"] += 1
    return {
        "generated": (today or datetime.date.today()).isoformat(),
        "tracked": len(records),
        "touchHit": touch_hit,
        "touchTotal": touch_total,
        "settled": len(settled),
        "settleWin": settle_win,
        "pnlSum": round(pnl_sum, 4),
        "byTag": by_tag,
    }


def _merge_summary(a, b):
    """兩份局部摘要合併（歸檔 + 在冊 = 全量）。"""
    out = dict(a)
    for k in ("tracked", "touchHit", "touchTotal", "settled", "settleWin"):
        out[k] = a.get(k, 0) + b.get(k, 0)
    out["pnlSum"] = round(a.get("pnlSum", 0.0) + b.get("pnlSum", 0.0), 4)
    out["byTag"] = _merge_by_tag(a.get("byTag") or {}, b.get("byTag") or {})
    return out


def _merge_by_tag(old, new):
    out = {}
    for k, v in old.items():
        out[k] = {kk: v.get(kk, 0) for kk in ("tracked", "touchHit", "settled", "settleWin")}
    for k, v in new.items():
        b = out.setdefault(k, {"tracked": 0, "touchHit": 0, "settled": 0, "settleWin": 0})
        for kk in b:
            b[kk] = b.get(kk, 0) + v.get(kk, 0)
    return out


def rotate(records, keep):
    """保留：所有未完全結算 + 最近 keep 筆已結算。其餘交回 caller 併入摘要。"""
    pending = [r for r in records if r.get("status") != "done"]
    done = sorted([r for r in records if r.get("status") == "done"],
                  key=lambda r: r["date"], reverse=True)
    kept_done, folded = done[:keep], done[keep:]
    return pending + kept_done, folded


def main():
    ap = argparse.ArgumentParser(description="績效覆盤：跟進過往可出手建議")
    ap.add_argument("--scans-dir", default=os.path.join(HERE, "scan"))
    ap.add_argument("--out", default=os.path.join(HERE, "scan", "perf.json"))
    ap.add_argument("--keep", type=int, default=90, help="保留最近 N 筆已結算紀錄")
    ap.add_argument("--max-fetch", type=int, default=40, help="單次最多抓幾隻歷史")
    ap.add_argument("--asof", default=None, help="模擬指定日期（YYYY-MM-DD），測試／補跑用")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    today = datetime.date.today()
    if args.asof:
        today = datetime.date(*[int(x) for x in args.asof.split("-")])
    log("→ 覆盤 %s" % today.isoformat())

    # 1. 讀舊 ledger
    prev = None
    if os.path.exists(args.out):
        try:
            with io.open(args.out, "r", encoding="utf-8") as f:
                prev = json.load(f)
        except Exception as e:
            log("  ! 舊 perf.json 讀唔到（%s），由零開始" % e)

    # ledger 入面嘅紀錄唔存 key（慳空間），讀嗰陣由 sym@date 重建
    records = {}
    for r in (prev or {}).get("records", []):
        k = r.get("key") or ("%s@%s" % (r.get("sym"), r.get("date")))
        r["key"] = k
        records[k] = r
    # 合併新出現嘅建議（例如上次跑嗰陣 scan 檔未生成）
    for rec in load_scans(args.scans_dir):
        records.setdefault(rec["key"], blank_record(rec))

    # 2. 搵出要抓價格嘅 record（有 checkpoint 未結算）
    need = []
    for r in records.values():
        due = False
        if r["chk10"] is None and r["date"] < today.isoformat():
            due = True
        if r["exp"] is None and r["expiry"]:
            try:
                xday = datetime.date(*[int(x) for x in r["expiry"].split("-")])
                if xday <= today:
                    due = True
            except ValueError:
                pass
        if due:
            need.append(r)
    need.sort(key=lambda r: r["date"])
    if len(need) > args.max_fetch:
        log("  ! 待抓取 %d 隻超過上限 %d，今次先搞最近嗰批" % (len(need), args.max_fetch))
        need = need[-args.max_fetch:]

    # 3. 抓價 + 計指標（每隻只需要一次歷史請求）
    fetched = 0
    for r in need:
        sym = r["sym"]
        sday = datetime.date(*[int(x) for x in r["date"].split("-")])
        hist = fetch_history(sym, sday, today)
        fetched += 1
        if hist:
            resolve_record(r, hist, today)
        time.sleep(0.2)
    log("  抓取 %d 隻歷史，更新 %d 項" % (fetched, len(need)))

    # 4. 摘要 = 歸檔（旋轉走嘅舊紀錄）+ 在冊，全量重計，唔靠舊摘要（防重複計）
    kept, folded = rotate(list(records.values()), args.keep)
    summary = _merge_summary(summarize(folded, today), summarize(kept, today))

    kept.sort(key=lambda r: r["date"], reverse=True)
    # 寫檔前抌走 key（讀嗰陣會由 sym@date 重建，慳返每筆幾個 byte）
    for r in kept:
        r.pop("key", None)
    payload = {
        "generated": summary["generated"],
        "summary": summary,
        "records": kept,
    }
    tmp = args.out + ".tmp"
    with io.open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, args.out)

    s = summary
    rate = (s["touchHit"] / s["touchTotal"]) if s["touchTotal"] else None
    srate = (s["settleWin"] / s["settled"]) if s["settled"] else None
    log("✓ perf.json 已寫入：%d 筆在冊（%d 筆已併入累計摘要）" % (len(kept), len(folded)))
    log("  信號命中 %s ｜ 到期勝率 %s ｜ 平均報酬 %s" % (
        ("%.0f%%（%d/%d）" % (rate * 100, s["touchHit"], s["touchTotal"])) if rate is not None else "樣本不足",
        ("%.0f%%（%d/%d）" % (srate * 100, s["settleWin"], s["settled"])) if srate is not None else "樣本不足",
        ("%+.1f%%" % (s["pnlSum"] / s["settled"] * 100)) if s["settled"] else "—"))


if __name__ == "__main__":
    main()
