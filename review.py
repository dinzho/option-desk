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
import math
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


# ---------------------------------------------------------------- 風險管理（提前平倉）

R_RATE = 0.043   # 無風險利率（估值用，同 dashboard 預設一致）
R_DIV = 0.0      # 股息（覆盤無每日股息數據，取 0，對短期估值影響極小）

# 平倉規則（同 UI 顯示完全一致）：
#   賣方（收權利金 net）：虧損達 2 倍權利金 → 止損；賺到 50% 權利金 → 止盈
#   買方（付權利金 net）：蝕 50% → 止損；翻倍 → 止盈
STOP_SELL, TAKE_SELL = 2.0, 0.5
STOP_BUY, TAKE_BUY = 0.5, 1.0


def _norm_cdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def bs_price(kind, S, K, T, iv, r=R_RATE, q=R_DIV):
    """Black-Scholes 期權價（每股）。T 以年計。"""
    if T <= 0 or iv is None or iv <= 0 or S <= 0 or K <= 0:
        return max(S - K, 0.0) if kind == "call" else max(K - S, 0.0)
    sq = iv * math.sqrt(T)
    d1 = (math.log(S / K) + (r - q + 0.5 * iv * iv) * T) / sq
    d2 = d1 - sq
    if kind == "call":
        return S * math.exp(-q * T) * _norm_cdf(d1) - K * math.exp(-r * T) * _norm_cdf(d2)
    return K * math.exp(-r * T) * _norm_cdf(-d2) - S * math.exp(-q * T) * _norm_cdf(-d1)


def implied_vol(kind, price, S, K, T, r=R_RATE, q=R_DIV):
    """由市價反解 IV（二分法）。解唔到 return None。"""
    if price is None or price <= 0 or S <= 0 or K <= 0 or T <= 0:
        return None
    lo, hi = 0.01, 4.0
    intrinsic = max(S - K, 0.0) if kind == "call" else max(K - S, 0.0)
    if price <= intrinsic + 1e-9:
        return None  # 深價內貼著內在值，IV 不可辨識
    for _ in range(60):
        mid = (lo + hi) / 2.0
        p = bs_price(kind, S, K, T, mid, r, q)
        if p < price:
            lo = mid
        else:
            hi = mid
    return round((lo + hi) / 2.0, 4)


def leg_ivs(rec):
    """用建倉日數據反解每條腿嘅 IV（之後每日凍結呢個 IV 估值平倉）。
    有任何一條腿解唔到 → return None（該紀錄只做到期結算，唔做提前平倉）。"""
    try:
        sday = datetime.date(*[int(x) for x in rec["date"].split("-")])
        xday = datetime.date(*[int(x) for x in rec["expiry"].split("-")])
    except (KeyError, ValueError):
        return None
    T_entry = max((xday - sday).days, 1) / 365.0
    S0 = float(rec.get("scanPrice") or 0)
    if S0 <= 0:
        return None
    out = []
    for L in rec.get("legs") or []:
        if L.get("kind") == "stock":
            out.append(0.0)
            continue
        iv = implied_vol(L.get("kind"), float(L.get("mid") or 0), S0,
                         float(L.get("K") or 0), T_entry)
        if iv is None:
            return None
        out.append(iv)
    return out if out else None


def position_value(S, legs, ivs, T_rem):
    """用凍結 IV 估值個倉而家值幾多（每股；買腿 +、賣腿 −）。"""
    V = 0.0
    for L, iv in zip(legs, ivs):
        if L.get("kind") == "stock":
            p = S
        else:
            p = bs_price(L.get("kind"), S, float(L.get("K") or 0), T_rem, iv)
        V += p if L.get("act") == "buy" else -p
    return V


def check_early_close(rec, hist, today):
    """每日收市風險檢查：觸及止損／止盈就提前平倉結算（模擬）。
    估值口徑：凍結建倉 IV + 當日收市價 + 剩餘時間值（Black-Scholes）。
    平倉日 strict 早過到期日——到期當日照到期結算，唔會重複計。"""
    if rec.get("exp") is not None:
        return
    ivs = rec.get("ivs")
    legs = rec.get("legs") or []
    if not ivs or len(ivs) != len(legs) or not hist:
        return
    try:
        sday = datetime.date(*[int(x) for x in rec["date"].split("-")])
        xday = datetime.date(*[int(x) for x in rec["expiry"].split("-")])
    except (KeyError, ValueError):
        return
    net = float(rec.get("net") or 0)
    if net <= 0 or xday <= sday:
        return
    is_sell = rec.get("dir") == "sell"
    stop_lvl = -STOP_SELL * net * 100.0 if is_sell else -STOP_BUY * net * 100.0
    take_lvl = TAKE_SELL * net * 100.0 if is_sell else TAKE_BUY * net * 100.0

    for row in hist:
        d = row["date"]
        if not (sday < d < xday) or d > today:
            continue
        T_rem = max((xday - d).days, 0.5) / 365.0
        V = position_value(row["close"], legs, ivs, T_rem)
        pnl_ps = (net + V) if is_sell else (V - net)
        pnl = pnl_ps * 100.0
        reason = None
        if pnl <= stop_lvl:
            reason = "止損"
        elif pnl >= take_lvl:
            reason = "止盈"
        if reason:
            rec["exp"] = {
                "date": d.isoformat(), "close": row["close"],
                "pnlPerLot": round(pnl, 2),
                "pnlPct": round(pnl / (net * 100.0), 4),
                "win": bool(pnl > 0),
                "early": reason,
                "note": "提前平倉：以建倉 IV 估值（未計 IV 變化）",
            }
            rec["status"] = "done"
            log("  ⚡ %s@%s 提前%s：close=%.2f 每手 %+.0f"
                % (rec["sym"], rec["date"], reason, row["close"], pnl))
            return


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
            sym = r.get("symbol")
            st = r.get("structure") or {}
            legs = st.get("legs") or []
            be = st.get("breakEven") or {}
            debit, credit = st.get("debit"), st.get("credit")
            net = debit if isinstance(debit, (int, float)) else (
                credit if isinstance(credit, (int, float)) else None)
            # 賣期權收租（SELL_PREMIUM）單邊結構（賣 Put / 賣 Call）只有一邊損平，
            # 另一邊係無界（價格越過越賺），唔可以因為缺邊就 skip。
            # 兩邊都係 None 先至真係計唔到，先 skip。
            if not legs or (be.get("lower") is None and be.get("upper") is None):
                log("  ⚠ 跳過 %s@%s [%s]：結構無腿或兩邊都無損平（structure=%s）"
                    % (sym, scan_date, r.get("tag"), st.get("name")))
                continue
            if net is None or net <= 0:
                log("  ⚠ 跳過 %s@%s [%s]：net 計唔到或非正數（debit=%s credit=%s）"
                    % (sym, scan_date, r.get("tag"), debit, credit))
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
                "be": {"lower": float(be["lower"]) if be.get("lower") is not None else None,
                       "upper": float(be["upper"]) if be.get("upper") is not None else None},
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
        "ivs": leg_ivs(rec),   # 每腿建倉 IV（提前平倉估值用；None = 只做到期結算）
        "chk10": None,   # {"due":..., "close":..., "hit": true/false}
        "exp": None,     # {"date":..., "close":..., "pnlPerLot":..., "pnlPct":..., "win":..., "early": ...}
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
                # 缺邊當無界：賣方（收租）單邊結構上/下邊係 +∞/−∞；
                # 買方（賺波）缺邊就當嗰邊唔會觸發命中。
                if rec["dir"] == "sell":
                    hit = all((lower is None or r["close"] >= lower) and
                              (upper is None or r["close"] <= upper) for r in rows)
                else:
                    hit = any((upper is not None and r["high"] >= upper) or
                              (lower is not None and r["low"] <= lower) for r in rows)
                rec["chk10"] = {"due": due.isoformat(),
                                "close": rows[-1]["close"], "hit": bool(hit)}

    # ---- 提前平倉（風險管理）：每日收市檢查，觸及止損／止盈即結算 ----
    check_early_close(rec, hist, today)

    # ---- exp：到期結算（提前平倉已結算嘅會跳過）----
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
    early_closed = sum(1 for r in records if (r.get("exp") or {}).get("early"))
    by_tag = {}
    for r in records:
        t = by_tag.setdefault(r["tag"], {"tracked": 0, "touchHit": 0,
                                         "settled": 0, "settleWin": 0,
                                         "earlyClosed": 0})
        t["tracked"] += 1
        if (r.get("chk10") or {}).get("hit"):
            t["touchHit"] += 1
        if (r.get("exp") or {}).get("pnlPerLot") is not None:
            t["settled"] += 1
            if r["exp"]["win"]:
                t["settleWin"] += 1
            if r["exp"].get("early"):
                t["earlyClosed"] += 1
    return {
        "generated": (today or datetime.date.today()).isoformat(),
        "tracked": len(records),
        "touchHit": touch_hit,
        "touchTotal": touch_total,
        "settled": len(settled),
        "settleWin": settle_win,
        "earlyClosed": early_closed,
        "pnlSum": round(pnl_sum, 4),
        "byTag": by_tag,
    }


def _merge_summary(a, b):
    """兩份局部摘要合併（歸檔 + 在冊 = 全量）。"""
    out = dict(a)
    for k in ("tracked", "touchHit", "touchTotal", "settled", "settleWin", "earlyClosed"):
        out[k] = a.get(k, 0) + b.get(k, 0)
    out["pnlSum"] = round(a.get("pnlSum", 0.0) + b.get("pnlSum", 0.0), 4)
    out["byTag"] = _merge_by_tag(a.get("byTag") or {}, b.get("byTag") or {})
    return out


def _merge_by_tag(old, new):
    out = {}
    for k, v in old.items():
        out[k] = {kk: v.get(kk, 0) for kk in ("tracked", "touchHit", "settled", "settleWin", "earlyClosed")}
    for k, v in new.items():
        b = out.setdefault(k, {"tracked": 0, "touchHit": 0, "settled": 0, "settleWin": 0, "earlyClosed": 0})
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
    ap.add_argument("--max-fetch", type=int, default=60, help="單次最多抓幾筆紀錄嘅歷史")
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

    # 舊 ledger 紀錄無 ivs 欄（提前平倉功能之前嘅版本）：補反解一次
    for r in records.values():
        if r.get("ivs") is None and r.get("exp") is None:
            r["ivs"] = leg_ivs(r)

    # 2. 搵出要抓價格嘅 record：
    #    - chk10 未出（建議後 10 個交易日）
    #    - exp 未出：到期結算 + 提前平倉每日風險檢查都要用到歷史價
    need = []
    for r in records.values():
        due = False
        if r["chk10"] is None and r["date"] < today.isoformat():
            due = True
        if r["exp"] is None:
            due = True
        if due:
            need.append(r)
    need.sort(key=lambda r: r["date"])
    if len(need) > args.max_fetch:
        log("  ! 待抓取 %d 筆超過上限 %d，今次先搞最近嗰批" % (len(need), args.max_fetch))
        need = need[-args.max_fetch:]

    # 3. 抓價 + 計指標——同一隻股票多筆紀錄只抓一次歷史（慳請求）
    by_sym = {}
    for r in need:
        by_sym.setdefault(r["sym"], []).append(r)
    fetched = 0
    for sym in sorted(by_sym):
        rs = by_sym[sym]
        start = min(datetime.date(*[int(x) for x in r["date"].split("-")]) for r in rs)
        hist = fetch_history(sym, start, today)
        fetched += 1
        if hist:
            for r in rs:
                resolve_record(r, hist, today)
        time.sleep(0.2)
    log("  抓取 %d 隻歷史（%d 筆紀錄），更新 %d 項" % (fetched, len(need), len(need)))

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
    log("  信號命中 %s ｜ 結算勝率 %s ｜ 提前平倉 %d 筆 ｜ 平均報酬 %s" % (
        ("%.0f%%（%d/%d）" % (rate * 100, s["touchHit"], s["touchTotal"])) if rate is not None else "樣本不足",
        ("%.0f%%（%d/%d）" % (srate * 100, s["settleWin"], s["settled"])) if srate is not None else "樣本不足",
        s.get("earlyClosed", 0),
        ("%+.1f%%" % (s["pnlSum"] / s["settled"] * 100)) if s["settled"] else "—"))


if __name__ == "__main__":
    main()
