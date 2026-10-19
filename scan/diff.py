#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
对比两次扫描结果：新上榜、跌出榜、标签变化、分数变化。

用法：
    python3 scan/diff.py scan/scan-2026-09-23.json scan/scan-2026-09-25.json
"""
import io
import json
import sys


def load(p):
    with io.open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def main():
    if len(sys.argv) < 3:
        print("用法: python3 scan/diff.py <旧.json> <新.json>")
        return 1
    old, new = load(sys.argv[1]), load(sys.argv[2])
    om = {r["symbol"]: r for r in (old.get("results") or [])}
    nm = {r["symbol"]: r for r in (new.get("results") or [])}
    tags = new.get("tags") or old.get("tags") or {}

    def lab(t):
        return (tags.get(t) or {}).get("label", t)

    print("=" * 74)
    print("  %s  →  %s" % (old.get("date"), new.get("date")))
    print("=" * 74)
    for name, a, b in (("合格", "survived", "survived"),
                       ("值得做", "actionable", "actionable"),
                       ("观察", "watch", "watch")):
        print("  %-6s %s → %s" % (name, (old.get("summary") or {}).get(a),
                                   (new.get("summary") or {}).get(b)))

    entered = [s for s in nm if s not in om]
    exited = [s for s in om if s not in nm]
    common = [s for s in nm if s in om]

    if entered:
        print("\n【新上榜 %d】" % len(entered))
        entered.sort(key=lambda s: -nm[s]["score"])
        for s in entered[:12]:
            r = nm[s]
            print("  + %-6s %-10s %5.1f分  IV30 %s  VR %s" % (
                s, lab(r["tag"]), r["score"],
                ("%.1f%%" % (r["iv30"] * 100)) if r.get("iv30") else "—",
                ("%.2f" % r["vr"]) if r.get("vr") else "—"))

    if exited:
        print("\n【跌出榜 %d】%s" % (len(exited), " ".join(exited[:16])))

    moved = []
    for s in common:
        o, n = om[s], nm[s]
        if o["tag"] != n["tag"] or abs(o["score"] - n["score"]) >= 5:
            moved.append((abs(n["score"] - o["score"]), s, o, n))
    if moved:
        moved.sort(reverse=True)
        print("\n【明显变化 %d】" % len(moved))
        for _, s, o, n in moved[:14]:
            d = n["score"] - o["score"]
            arrow = "↑" if d > 0 else "↓"
            tagtxt = "" if o["tag"] == n["tag"] else "  %s→%s" % (lab(o["tag"]), lab(n["tag"]))
            print("  %s %-6s %5.1f → %5.1f (%+.1f)%s" % (arrow, s, o["score"], n["score"], d, tagtxt))

    print("\n【今日前 12】")
    top = sorted(nm.values(), key=lambda r: -r["score"])[:12]
    for i, r in enumerate(top, 1):
        st = r.get("structure") or {}
        be = st.get("breakEven") or {}
        lo = ("%.2f" % be["lower"]) if be.get("lower") is not None else "—"
        hi = ("%.2f" % be["upper"]) if be.get("upper") is not None else "—"
        print("  %2d. %-6s %-10s %5.1f分  %s  IV30 %s  VR %s  到期 %s  损平 %s/%s" % (
            i, r["symbol"], lab(r["tag"]), r["score"], (st.get("name") or "—")[:16],
            ("%.1f%%" % (r["iv30"] * 100)) if r.get("iv30") else "—",
            ("%.2f" % r["vr"]) if r.get("vr") else "—",
            st.get("expiry") or "—", lo, hi))
    return 0


if __name__ == "__main__":
    sys.exit(main())
