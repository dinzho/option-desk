/**
 * charts.js — 純 SVG 圖表渲染層（零依賴，UMD）
 *
 * 只負責「畫」：所有數值計算由上層引擎完成，本模組僅接受資料契約並輸出 SVG 字串。
 * 配色全部透過 CSS 變數（var(--c-*)），深/淺色主題自動生效。
 *
 * 導出：renderPayoff / renderMultiCurve / renderHeatmap / renderTermStructure
 *      renderSkew / renderDistribution / renderGreeksBars / renderIVHistory
 */
(function (root, factory) {
  var api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.OptionCharts = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'

  /* ============================================================
   * 0. 主題色（僅透過 CSS 變數，附 fallback 讓無主題環境也能看）
   * ========================================================== */
  var C = {
    profit: 'var(--c-profit,#16a34a)',
    loss: 'var(--c-loss,#dc2626)',
    accent: 'var(--c-accent,#3b82f6)',
    grid: 'var(--c-grid,rgba(128,128,128,.18))',
    axis: 'var(--c-axis,rgba(128,128,128,.6))',
    text: 'var(--c-text,currentColor)',
    muted: 'var(--c-muted,rgba(128,128,128,.9))',
    surface: 'var(--c-surface,transparent)',
    buy: 'var(--c-buy,#0ea5e9)',
    sell: 'var(--c-sell,#f59e0b)'
  }
  var FONT = "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif"

  /* ============================================================
   * 1. 基礎工具
   * ========================================================== */
  var ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ENT[c] })
  }
  function num(v) {
    if (typeof v === 'number') return v
    if (typeof v === 'string' && v.trim() !== '') return +v
    return NaN
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v) }
  function r2(v) { return isFinite(v) ? Math.round(v * 100) / 100 : 0 }
  function cl(v, a, b) { return v < a ? a : (v > b ? b : v) }
  var uid = 0
  function nid(p) { return 'oc-' + (p || 'x') + '-' + (++uid) }

  /** 軸標籤縮寫：1.2k / 3.4M / 12.1 */
  function fmt(v) {
    if (!isFinite(v)) return '—'
    var a = Math.abs(v)
    if (a >= 1e9) return (v / 1e9).toFixed(1) + 'B'
    if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M'
    if (a >= 1000) return (v / 1000).toFixed(a >= 10000 ? 0 : 1) + 'k'
    if (a >= 100) return v.toFixed(0)
    if (a >= 10) return v.toFixed(1)
    if (a >= 1) return v.toFixed(2)
    if (a === 0) return '0'
    return v.toFixed(3)
  }
  function money(v) { return (v < 0 ? '-' : '') + '$' + fmt(Math.abs(v)) }
  /** 價格標註用（保留小數，比軸標籤精確） */
  function price(v) {
    if (!isFinite(v)) return '—'
    return Math.abs(v) >= 10000 ? fmt(v) : v.toFixed(2)
  }
  function pct(v) { return (isFinite(v) ? v.toFixed(1) : '—') + '%' }
  /** 粗略文本寬度（CJK 計寬），用於圖例/徽章自適應 */
  function tw(s) {
    s = String(s == null ? '' : s)
    var w = 0
    for (var i = 0; i < s.length; i++) w += /[\u2e80-\u9fff\uff00-\uffef]/.test(s[i]) ? 10.5 : 6.2
    return w
  }

  /** 取值域，非法/空資料回退 [0,1] */
  function extent(vals) {
    var mn = Infinity, mx = -Infinity
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i]
      if (isNum(v)) { if (v < mn) mn = v; if (v > mx) mx = v }
    }
    if (mn > mx) return [0, 1]
    if (mn === mx) { var d = Math.abs(mn) * 0.1 || 1; return [mn - d, mx + d] }
    return [mn, mx]
  }
  function pad(mn, mx, f) {
    if (!isFinite(mn) || !isFinite(mx)) return [0, 1]
    if (mn === mx) { var d = Math.abs(mn) * 0.1 || 1; return [mn - d, mx + d] }
    var d = (mx - mn) * (f == null ? 0.06 : f)
    return [mn - d, mx + d]
  }
  /** 線性映射 */
  function sc(d0, d1, r0, r1) {
    var k = (d1 === d0) ? 0 : (r1 - r0) / (d1 - d0)
    return function (v) { return r0 + (v - d0) * k }
  }
  /** 好看的刻度 */
  function niceTicks(mn, mx, count) {
    count = count || 5
    if (!isFinite(mn) || !isFinite(mx)) return [0]
    if (mn === mx) { var e = Math.abs(mn) * 0.5 || 1; mn -= e; mx += e }
    var raw = (mx - mn) / count
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10))
    var n = raw / mag, step
    if (n <= 1) step = 1
    else if (n <= 2) step = 2
    else if (n <= 2.5) step = 2.5
    else if (n <= 5) step = 5
    else step = 10
    step *= mag
    var out = [], t = Math.ceil(mn / step) * step
    for (; t <= mx + step * 1e-6; t += step) out.push(Math.abs(t) < step * 1e-9 ? 0 : t)
    return out.length ? out : [mn]
  }
  /** 清洗點陣列 → [{x,y,raw}]，丟棄 NaN，按 x 升序（nosort 時保留原順序，x 用下標） */
  function cleanPts(arr, xk, yk, nosort) {
    var out = []
    if (arr && arr.length) {
      for (var i = 0; i < arr.length; i++) {
        var d = arr[i]
        if (!d) continue
        var x = nosort ? i : num(d[xk])
        var y = num(d[yk])
        if (isNum(x) && isNum(y)) out.push({ x: x, y: y, raw: d })
      }
    }
    if (!nosort) out.sort(function (a, b) { return a.x - b.x })
    return out
  }
  function mapv(a, f) {
    var o = []
    for (var i = 0; i < a.length; i++) o.push(f(a[i], i))
    return o
  }
  /** 點陣列的 x / y 值域 */
  function domX(pts) { return extent(mapv(pts, function (q) { return q.x })) }
  function domY(pts) { return extent(mapv(pts, function (q) { return q.y })) }

  /* ============================================================
   * 2. SVG 外殼 / 空狀態 / 路徑
   * ========================================================== */
  function open(W, H) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '"' +
      ' width="100%" preserveAspectRatio="xMidYMid meet"' +
      ' style="display:block;width:100%;height:auto;overflow:visible"' +
      ' font-family="' + FONT + '" role="img">'
  }
  function mount(el, svg) {
    if (el && typeof el === 'object' && 'innerHTML' in el) el.innerHTML = svg
    return svg
  }
  function emptyState(W, H, msg) {
    return open(W, H) +
      '<rect x="0" y="0" width="' + W + '" height="' + H + '" rx="10" style="fill:' + C.surface + ';stroke:' + C.grid + '"/>' +
      '<text x="' + (W / 2) + '" y="' + (H / 2) + '" text-anchor="middle" dominant-baseline="middle"' +
      ' font-size="13" style="fill:' + C.muted + '">' + esc(msg || '暂无数据') + '</text>' +
      '</svg>'
  }
  function titleSvg(t, W) {
    if (!t) return ''
    return '<text x="6" y="19" font-size="12.5" font-weight="600" style="fill:' + C.text + '">' + esc(t) + '</text>'
  }
  function poly(pts, xs, ys) {
    var d = ''
    for (var i = 0; i < pts.length; i++) {
      d += (i ? 'L' : 'M') + r2(xs(pts[i].x)) + ' ' + r2(ys(pts[i].y))
    }
    return d
  }
  function areaPath(pts, xs, ys, base) {
    if (!pts.length) return ''
    var d = 'M' + r2(xs(pts[0].x)) + ' ' + r2(base)
    for (var i = 0; i < pts.length; i++) d += 'L' + r2(xs(pts[i].x)) + ' ' + r2(ys(pts[i].y))
    return d + 'L' + r2(xs(pts[pts.length - 1].x)) + ' ' + r2(base) + 'Z'
  }
  /** 透明熱區 + <title> 原生 tooltip，取樣最多 ~30 點 */
  function hoverDots(pts, xs, ys, label) {
    var o = [], n = pts.length, step = Math.max(1, Math.ceil(n / 30))
    for (var i = 0; i < n; i += step) o.push(dot(pts[i], xs, ys, label))
    if (n > 1 && (n - 1) % step !== 0) o.push(dot(pts[n - 1], xs, ys, label))
    return o.join('')
  }
  function dot(p, xs, ys, label) {
    return '<circle cx="' + r2(xs(p.x)) + '" cy="' + r2(ys(p.y)) + '" r="7" fill="none" pointer-events="all">' +
      '<title>' + esc(label(p)) + '</title></circle>'
  }
  /** 依 y=0 將折線分段（在零穿越處插值切點） */
  function signSegs(pts) {
    var out = [], cur = null
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i], s = p.y >= 0 ? 1 : -1
      if (!cur) { cur = { sign: s, pts: [p] }; continue }
      if (s === cur.sign) { cur.pts.push(p); continue }
      var q = pts[i - 1]
      var t = cl(q.y / (q.y - p.y), 0, 1)
      var cross = { x: q.x + (p.x - q.x) * t, y: 0 }
      cur.pts.push(cross); out.push(cur)
      cur = { sign: s, pts: [cross, p] }
    }
    if (cur && cur.pts.length) out.push(cur)
    return out
  }
  /** 右上角/任意位置的結論徽章 */
  function badge(x, y, text, color, align) {
    var w = tw(text) + 18, h = 20
    var bx = align === 'right' ? x - w : x
    return '<g><rect x="' + r2(bx) + '" y="' + r2(y) + '" width="' + r2(w) + '" height="' + h + '" rx="10"' +
      ' style="fill:' + C.surface + ';stroke:' + color + '" stroke-width="1" stroke-opacity=".55"/>' +
      '<text x="' + r2(bx + w / 2) + '" y="' + r2(y + h / 2 + 0.5) + '" text-anchor="middle" dominant-baseline="middle"' +
      ' font-size="10.5" style="fill:' + color + '">' + esc(text) + '</text></g>'
  }
  /** 圖例：items = [{name, color, dashed}] */
  function legend(x, y, items, align) {
    var w = 0
    items.forEach(function (it) { w = Math.max(w, tw(it.name) + 34) })
    var h = items.length * 16 + 9
    var bx = align === 'right' ? x - w : x
    var s = ['<g><rect x="' + r2(bx) + '" y="' + r2(y) + '" width="' + r2(w) + '" height="' + h + '" rx="6"' +
      ' style="fill:' + C.surface + ';stroke:' + C.grid + '"/>']
    items.forEach(function (it, i) {
      var yy = y + 10.5 + i * 16
      s.push('<line x1="' + r2(bx + 8) + '" y1="' + r2(yy) + '" x2="' + r2(bx + 22) + '" y2="' + r2(yy) +
        '" style="stroke:' + it.color + '" stroke-width="2"' + (it.dashed ? ' stroke-dasharray="5 3"' : '') + '/>')
      s.push('<text x="' + r2(bx + 27) + '" y="' + r2(yy) + '" dominant-baseline="middle" font-size="10.5"' +
        ' style="fill:' + C.text + '">' + esc(it.name) + '</text>')
    })
    s.push('</g>')
    return s.join('')
  }
  /** 垂直參考線（現價 / 行權價 / BE） */
  function vline(p, x, top, color, label, dashed, opacity) {
    if (!isFinite(x) || x < p.x - 1 || x > p.x + p.w + 1) return ''
    var s = '<line x1="' + r2(x) + '" y1="' + r2(p.y) + '" x2="' + r2(x) + '" y2="' + r2(p.y + p.h) +
      '" style="stroke:' + color + '" stroke-width="1.2" stroke-opacity="' + (opacity || 0.85) + '"' +
      (dashed === false ? '' : ' stroke-dasharray="4 4"') + '/>'
    if (label) {
      var anchor = x > p.x + p.w - 60 ? 'end' : 'start'
      var dx = anchor === 'end' ? -5 : 5
      s += '<text x="' + r2(x + dx) + '" y="' + r2(p.y + (top ? 11 : p.h - 5)) + '" text-anchor="' + anchor +
        '" font-size="10" style="fill:' + color + '">' + esc(label) + '</text>'
    }
    return s
  }
  function hline(p, y, color, label, dashed) {
    if (!isFinite(y) || y < p.y - 1 || y > p.y + p.h + 1) return ''
    var s = '<line x1="' + r2(p.x) + '" y1="' + r2(y) + '" x2="' + r2(p.x + p.w) + '" y2="' + r2(y) +
      '" style="stroke:' + color + '" stroke-width="1.2" stroke-opacity=".8"' +
      (dashed === false ? '' : ' stroke-dasharray="6 4"') + '/>'
    if (label) {
      s += '<text x="' + r2(p.x + p.w - 4) + '" y="' + r2(cl(y - 4, p.y + 9, p.y + p.h - 3)) +
        '" text-anchor="end" font-size="10" style="fill:' + color + '">' + esc(label) + '</text>'
    }
    return s
  }

  /* ============================================================
   * 3. 通用座標軸（網格 + 刻度 + 軸標題）
   * ========================================================== */
  function axes(p, o) {
    var s = [], i, tk, v, t, y, x
    if (o.yt) {
      for (i = 0; i < o.yt.length; i++) {
        y = o.ys(o.yt[i])
        if (y < p.y - 1 || y > p.y + p.h + 1) continue
        s.push('<line x1="' + p.x + '" y1="' + r2(y) + '" x2="' + r2(p.x + p.w) + '" y2="' + r2(y) +
          '" style="stroke:' + C.grid + '" stroke-width="1"/>')
      }
    }
    if (o.xt) {
      for (i = 0; i < o.xt.length; i++) {
        tk = o.xt[i]
        v = (tk && typeof tk === 'object') ? tk.v : tk
        x = o.xs(v)
        if (x < p.x - 1 || x > p.x + p.w + 1) continue
        s.push('<line x1="' + r2(x) + '" y1="' + p.y + '" x2="' + r2(x) + '" y2="' + r2(p.y + p.h) +
          '" style="stroke:' + C.grid + '" stroke-width="1"/>')
      }
    }
    /* 軸線 */
    s.push('<line x1="' + p.x + '" y1="' + r2(p.y + p.h) + '" x2="' + r2(p.x + p.w) + '" y2="' + r2(p.y + p.h) +
      '" style="stroke:' + C.axis + '" stroke-width="1"/>')
    s.push('<line x1="' + p.x + '" y1="' + p.y + '" x2="' + p.x + '" y2="' + r2(p.y + p.h) +
      '" style="stroke:' + C.axis + '" stroke-width="1"/>')
    /* 刻度標籤 */
    if (o.yt) {
      for (i = 0; i < o.yt.length; i++) {
        y = o.ys(o.yt[i])
        if (y < p.y - 1 || y > p.y + p.h + 1) continue
        s.push('<text x="' + r2(p.x - 8) + '" y="' + r2(y) + '" text-anchor="end" dominant-baseline="middle"' +
          ' font-size="10" style="fill:' + C.muted + '">' +
          esc(o.yfmt ? o.yfmt(o.yt[i]) : fmt(o.yt[i])) + '</text>')
      }
    }
    if (o.xt) {
      var step = o.xSkip || 1
      for (i = 0; i < o.xt.length; i += step) {
        tk = o.xt[i]
        v = (tk && typeof tk === 'object') ? tk.v : tk
        t = (tk && typeof tk === 'object') ? tk.t : null
        x = o.xs(v)
        if (x < p.x - 1 || x > p.x + p.w + 1) continue
        var lbl = t != null ? t : (o.xfmt ? o.xfmt(v) : fmt(v))
        if (o.xRotate) {
          s.push('<text transform="translate(' + r2(x) + ',' + r2(p.y + p.h + 14) + ') rotate(-35)"' +
            ' text-anchor="end" font-size="10" style="fill:' + C.muted + '">' + esc(lbl) + '</text>')
        } else {
          s.push('<text x="' + r2(x) + '" y="' + r2(p.y + p.h + 17) + '" text-anchor="middle"' +
            ' font-size="10" style="fill:' + C.muted + '">' + esc(lbl) + '</text>')
        }
      }
    }
    if (o.xTitle) {
      s.push('<text x="' + r2(p.x + p.w / 2) + '" y="' + r2(p.y + p.h + 40) + '" text-anchor="middle"' +
        ' font-size="11" style="fill:' + C.muted + '">' + esc(o.xTitle) + '</text>')
    }
    if (o.yTitle) {
      s.push('<text transform="translate(' + r2(p.x - 42) + ',' + r2(p.y + p.h / 2) + ') rotate(-90)"' +
        ' text-anchor="middle" font-size="11" style="fill:' + C.muted + '">' + esc(o.yTitle) + '</text>')
    }
    return s.join('')
  }
  function frame(W, H, m) {
    return { x: m[0], y: m[1], w: Math.max(10, W - m[0] - m[2]), h: Math.max(10, H - m[1] - m[3]) }
  }

  /* ============================================================
   * 4.1 到期損益曲線
   * ========================================================== */
  function renderPayoff(el, data, opts) {
    opts = opts || {}; data = data || {}
    var W = opts.width || 720, H = opts.height || 340
    var pts = cleanPts(data.points, 'stock', 'pnl')
    if (!pts.length) return mount(el, emptyState(W, H, opts.emptyText || '暂无数据'))
    var spot = num(data.spot), haveSpot = isNum(spot)
    var be = (data.breakevens || []).map(num).filter(isNum)
    var xr = extent(mapv(pts, function (p) { return p.x }))
    if (haveSpot) { xr[0] = Math.min(xr[0], spot); xr[1] = Math.max(xr[1], spot) }
    be.forEach(function (b) { xr[0] = Math.min(xr[0], b); xr[1] = Math.max(xr[1], b) })
    xr = pad(xr[0], xr[1], 0.04)
    var yr = extent(mapv(pts, function (p) { return p.y }))
    yr[0] = Math.min(yr[0], 0); yr[1] = Math.max(yr[1], 0)
    yr = pad(yr[0], yr[1], 0.12)

    var p = frame(W, H, [64, 40, 22, 48])
    var xs = sc(xr[0], xr[1], p.x, p.x + p.w)
    var ys = sc(yr[0], yr[1], p.y + p.h, p.y)
    var y0 = ys(0)
    var yf = opts.fmtY || money
    var o = [open(W, H), titleSvg(data.title, W)]

    /* 盈虧背景帶 */
    ;(data.bands || []).forEach(function (b) {
      var a = num(b.from), c = num(b.to)
      if (!isNum(a) || !isNum(c)) return
      var xa = cl(xs(Math.max(a, Math.min(c, xr[0]))), p.x, p.x + p.w)
      var xb = cl(xs(Math.min(c, Math.max(a, xr[1]))), p.x, p.x + p.w)
      if (xb <= xa) return
      o.push('<rect x="' + r2(xa) + '" y="' + p.y + '" width="' + r2(xb - xa) + '" height="' + p.h +
        '" style="fill:' + (b.kind === 'profit' ? C.profit : C.loss) + '" fill-opacity="0.07"/>')
    })

    o.push(axes(p, {
      xt: niceTicks(xr[0], xr[1], 6), yt: niceTicks(yr[0], yr[1], 5),
      xs: xs, ys: ys,
      xfmt: function (v) { return '$' + fmt(v) }, yfmt: yf,
      xTitle: '股价 (Stock Price)', yTitle: '到期盈亏 (P&L)'
    }))

    /* 零軸 */
    o.push('<line x1="' + p.x + '" y1="' + r2(y0) + '" x2="' + r2(p.x + p.w) + '" y2="' + r2(y0) +
      '" style="stroke:' + C.axis + '" stroke-width="1.8"/>')

    /* 曲線：正段綠 / 負段紅 + 面積 */
    signSegs(pts).forEach(function (sg) {
      var col = sg.sign > 0 ? C.profit : C.loss
      o.push('<path d="' + areaPath(sg.pts, xs, ys, y0) + '" style="fill:' + col + '" fill-opacity="0.15"/>')
      o.push('<path d="' + poly(sg.pts, xs, ys) + '" style="fill:none;stroke:' + col +
        '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>')
    })

    /* 現價 */
    if (haveSpot) o.push(vline(p, xs(spot), true, C.accent, '现价 ' + price(spot)))
    /* 盈虧平衡點：菱形 */
    be.forEach(function (b) {
      var x = xs(b)
      if (x < p.x || x > p.x + p.w) return
      o.push('<path d="M' + r2(x) + ' ' + r2(y0 - 5) + 'L' + r2(x + 5) + ' ' + r2(y0) + 'L' + r2(x) + ' ' +
        r2(y0 + 5) + 'L' + r2(x - 5) + ' ' + r2(y0) + 'Z" style="fill:' + C.profit + ';stroke:' + C.surface +
        '" stroke-width="1"><title>盈亏平衡点 ' + esc(price(b)) + '</title></path>')
      o.push('<text x="' + r2(cl(x, p.x + 20, p.x + p.w - 20)) + '" y="' + r2(cl(y0 - 11, p.y + 10, p.y + p.h - 4)) +
        '" text-anchor="middle" font-size="10" style="fill:' + C.profit + '">BE ' + esc(price(b)) + '</text>')
    })

    /* hover tooltip */
    o.push(hoverDots(pts, xs, ys, function (q) {
      return '股价 $' + fmt(q.x) + '  →  ' + (q.y >= 0 ? '+' : '') + money(q.y)
    }))

    /* 最大盈利/虧損摘要 */
    var bits = []
    var mp = num(data.maxProfit), ml = num(data.maxLoss)
    if (data.maxProfit === null) bits.push('最大盈利 Unlimited')
    else if (isNum(mp)) bits.push('最大盈利 ' + money(mp))
    if (data.maxLoss === null) bits.push('最大亏损 Unlimited')
    else if (isNum(ml)) bits.push('最大亏损 ' + money(ml))
    if (bits.length) {
      o.push('<text x="' + r2(W - 22) + '" y="19" text-anchor="end" font-size="10.5" style="fill:' + C.muted +
        '">' + esc(bits.join('   ·   ')) + '</text>')
    }
    /* 無限標註 */
    if (data.maxLoss === null) {
      o.push('<text x="' + r2(p.x + 8) + '" y="' + r2(p.y + p.h - 8) + '" font-size="10" style="fill:' +
        C.loss + '" fill-opacity=".95">↓ 亏损无限 (Unlimited)</text>')
    }
    if (data.maxProfit === null) {
      o.push('<text x="' + r2(p.x + 8) + '" y="' + r2(p.y + 13) + '" font-size="10" style="fill:' +
        C.profit + '" fill-opacity=".95">↑ 盈利无限 (Unlimited)</text>')
    }
    o.push('</svg>')
    return mount(el, o.join(''))
  }

  /* ============================================================
   * 4.2 多時點損益曲線
   * ========================================================== */
  function renderMultiCurve(el, data, opts) {
    opts = opts || {}; data = data || {}
    var W = opts.width || 720, H = opts.height || 340
    var series = []
    ;(data.series || []).forEach(function (s) {
      if (!s) return
      var q = cleanPts(s.points, 'stock', 'pnl')
      if (q.length) series.push({ name: s.name || '', color: s.color || C.accent, dashed: !!s.dashed, pts: q })
    })
    if (!series.length) return mount(el, emptyState(W, H, opts.emptyText || '暂无数据'))
    var spot = num(data.spot), haveSpot = isNum(spot)
    var be = (data.breakevens || []).map(num).filter(isNum)
    var xr = [Infinity, -Infinity], yr = [Infinity, -Infinity]
    series.forEach(function (s) {
      s.pts.forEach(function (q) {
        xr[0] = Math.min(xr[0], q.x); xr[1] = Math.max(xr[1], q.x)
        yr[0] = Math.min(yr[0], q.y); yr[1] = Math.max(yr[1], q.y)
      })
    })
    if (haveSpot) { xr[0] = Math.min(xr[0], spot); xr[1] = Math.max(xr[1], spot) }
    yr[0] = Math.min(yr[0], 0); yr[1] = Math.max(yr[1], 0)
    xr = pad(xr[0], xr[1], 0.04); yr = pad(yr[0], yr[1], 0.1)

    var p = frame(W, H, [64, 40, 22, 48])
    var xs = sc(xr[0], xr[1], p.x, p.x + p.w)
    var ys = sc(yr[0], yr[1], p.y + p.h, p.y)
    var y0 = ys(0)
    var yf = opts.fmtY || money
    var o = [open(W, H), titleSvg(data.title, W)]

    o.push(axes(p, {
      xt: niceTicks(xr[0], xr[1], 6), yt: niceTicks(yr[0], yr[1], 5),
      xs: xs, ys: ys,
      xfmt: function (v) { return '$' + fmt(v) }, yfmt: yf,
      xTitle: '股价 (Stock Price)', yTitle: '盈亏 (P&L)'
    }))
    o.push('<line x1="' + p.x + '" y1="' + r2(y0) + '" x2="' + r2(p.x + p.w) + '" y2="' + r2(y0) +
      '" style="stroke:' + C.axis + '" stroke-width="1.8"/>')
    if (haveSpot) o.push(vline(p, xs(spot), true, C.accent, '现价 ' + price(spot)))

    be.forEach(function (b) {
      var x = xs(b)
      if (x < p.x || x > p.x + p.w) return
      o.push('<path d="M' + r2(x) + ' ' + r2(y0 - 5) + 'L' + r2(x + 5) + ' ' + r2(y0) + 'L' + r2(x) + ' ' +
        r2(y0 + 5) + 'L' + r2(x - 5) + ' ' + r2(y0) + 'Z" style="fill:' + C.profit + ';stroke:' + C.surface +
        '" stroke-width="1"><title>盈亏平衡点 ' + esc(price(b)) + '</title></path>')
    })

    series.forEach(function (s) {
      o.push('<path d="' + poly(s.pts, xs, ys) + '" style="fill:none;stroke:' + s.color +
        '" stroke-width="2" stroke-linejoin="round"' + (s.dashed ? ' stroke-dasharray="7 4"' : '') + '>' +
        '<title>' + esc(s.name) + '</title></path>')
      o.push(hoverDots(s.pts, xs, ys, function (q) {
        return s.name + '  |  股价 $' + fmt(q.x) + '  →  ' + (q.y >= 0 ? '+' : '') + money(q.y)
      }))
    })

    o.push(legend(p.x + p.w, p.y + 2, mapv(series, function (s) {
      return { name: s.name, color: s.color, dashed: s.dashed }
    }), 'right'))
    o.push('</svg>')
    return mount(el, o.join(''))
  }

  /* ============================================================
   * 4.3 二維熱力矩陣
   * ========================================================== */
  function renderHeatmap(el, data, opts) {
    opts = opts || {}; data = data || {}
    var rows = (data.rows || []).filter(function (r) { return r && r.cells && r.cells.length })
    var cols = data.cols || []
    if (!rows.length) return mount(el, emptyState(opts.width || 720, opts.height || 300, opts.emptyText || '暂无数据'))
    var nc = rows[0].cells.length
    var W = opts.width || 720
    var H = opts.height || cl(rows.length * 26 + 132, 260, 660)

    /* 全域色階域：全正 → [0,max]；全負 → [min,0]；混合 → [min,max] */
    var vals = []
    rows.forEach(function (r) {
      r.cells.forEach(function (c) { var v = num(c && c.value); if (isNum(v)) vals.push(v) })
    })
    var vr = extent(vals)
    var lo = vr[0] < 0 ? vr[0] : 0
    var hi = vr[1] > 0 ? vr[1] : 0
    if (lo === hi) { hi = lo + 1 }

    var labW = 24
    rows.forEach(function (r) { labW = Math.max(labW, tw(r.label || '')) })
    labW = cl(labW + 12, 40, 150)
    var p = frame(W, H, [labW + 8, 40, 16, Math.max(58, nc > 10 ? 76 : 58)])
    var cw = p.w / nc, chh = p.h / rows.length
    var showText = cw >= 30 && chh >= 15
    var fs = cl(Math.min(11, chh * 0.42), 7, 11)
    var o = [open(W, H), titleSvg(data.title, W)]

    /* 色階：用底色 + 半透明疊色，避免 JS 端插值 CSS 變數 */
    function cellFill(v) {
      if (!isNum(v)) return 'fill="none"'
      var t = cl((v - lo) / (hi - lo), 0, 1)
      var d = Math.abs(t - 0.5) * 2
      var op = (0.08 + d * 0.82).toFixed(3)
      return 'style="fill:' + (v >= 0 ? C.profit : C.loss) + '" fill-opacity="' + op + '"'
    }
    rows.forEach(function (r, ri) {
      var y = p.y + ri * chh
      o.push('<text x="' + r2(p.x - 8) + '" y="' + r2(y + chh / 2) + '" text-anchor="end" dominant-baseline="middle"' +
        ' font-size="10.5" style="fill:' + C.muted + '">' + esc(r.label || '') + '</text>')
      for (var ci = 0; ci < nc; ci++) {
        var c = r.cells[ci] || {}
        var v = num(c.value)
        var x = p.x + ci * cw
        o.push('<rect x="' + r2(x) + '" y="' + r2(y) + '" width="' + r2(cw) + '" height="' + r2(chh) +
          '" style="fill:' + C.surface + '"/>')
        o.push('<rect x="' + r2(x + 0.5) + '" y="' + r2(y + 0.5) + '" width="' + r2(Math.max(0, cw - 1)) +
          '" height="' + r2(Math.max(0, chh - 1)) + '" rx="2" ' + cellFill(v) + '>' +
          '<title>' + esc((r.label || '') + ' × ' + ((cols[ci] && cols[ci].label) || '')) +
          '  →  ' + esc(isNum(v) ? (v >= 0 ? '+' : '') + fmt(v) : '—') + '</title></rect>')
        if (showText) {
          /* value 為 NaN 時不回顯原始文字，改顯示佔位 */
          var txt = isNum(v) ? (c.text != null ? String(c.text) : fmt(v)) : '—'
          o.push('<text x="' + r2(x + cw / 2) + '" y="' + r2(y + chh / 2) + '" text-anchor="middle"' +
            ' dominant-baseline="middle" font-size="' + fs + '" style="fill:' + C.text +
            '" fill-opacity=".9">' + esc(txt) + '</text>')
        }
      }
    })
    /* 邊框 */
    o.push('<rect x="' + p.x + '" y="' + p.y + '" width="' + r2(p.w) + '" height="' + r2(p.h) +
      '" style="fill:none;stroke:' + C.axis + '" stroke-width="1"/>')

    /* 列標籤（過多時抽稀，窄時旋轉） */
    var step = Math.max(1, Math.ceil(nc / 12))
    var rot = cw < 46
    for (var ci2 = 0; ci2 < nc; ci2 += step) {
      var lb = (cols[ci2] && cols[ci2].label) != null ? cols[ci2].label : ''
      var cx = p.x + ci2 * cw + cw / 2
      if (rot) {
        o.push('<text transform="translate(' + r2(cx) + ',' + r2(p.y + p.h + 12) + ') rotate(-35)"' +
          ' text-anchor="end" font-size="10" style="fill:' + C.muted + '">' + esc(lb) + '</text>')
      } else {
        o.push('<text x="' + r2(cx) + '" y="' + r2(p.y + p.h + 16) + '" text-anchor="middle"' +
          ' font-size="10" style="fill:' + C.muted + '">' + esc(lb) + '</text>')
      }
    }

    /* 色階圖例條 */
    var gid = nid('hm')
    var bw = cl(p.w * 0.5, 140, 260), bh = 10
    var bx = p.x + (p.w - bw) / 2, by = p.y + p.h + (rot ? 40 : 32)
    o.push('<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="1" y2="0">' +
      '<stop offset="0%" style="stop-color:' + C.loss + '"/>' +
      '<stop offset="50%" style="stop-color:' + C.muted + '" stop-opacity=".3"/>' +
      '<stop offset="100%" style="stop-color:' + C.profit + '"/></linearGradient></defs>')
    o.push('<rect x="' + r2(bx) + '" y="' + r2(by) + '" width="' + r2(bw) + '" height="' + bh +
      '" rx="3" style="fill:url(#' + gid + ');stroke:' + C.grid + '"/>')
    o.push('<text x="' + r2(bx - 6) + '" y="' + r2(by + bh / 2) + '" text-anchor="end" dominant-baseline="middle"' +
      ' font-size="10" style="fill:' + C.muted + '">' + esc(fmt(lo)) + '</text>')
    o.push('<text x="' + r2(bx + bw + 6) + '" y="' + r2(by + bh / 2) + '" text-anchor="start" dominant-baseline="middle"' +
      ' font-size="10" style="fill:' + C.muted + '">' + esc('+' + fmt(hi)) + '</text>')
    if (data.metricLabel) {
      o.push('<text x="' + r2(bx + bw / 2) + '" y="' + r2(by + bh + 13) + '" text-anchor="middle"' +
        ' font-size="10" style="fill:' + C.muted + '">' + esc(data.metricLabel) + '</text>')
    }
    o.push('</svg>')
    return mount(el, o.join(''))
  }

  /* ============================================================
   * 4.4 IV 期限結構
   * ========================================================== */
  function renderTermStructure(el, data, opts) {
    opts = opts || {}; data = data || {}
    var W = opts.width || 720, H = opts.height || 320
    var pts = cleanPts(data.points, 'dte', 'iv')
    if (!pts.length) return mount(el, emptyState(W, H, opts.emptyText || '暂无数据'))
    var dx = domX(pts), dy = domY(pts)
    var xr = pad(dx[0], dx[1], 0.06)
    var yr0 = [dy[0], dy[1]]
    var hv20 = num(data.hv20), hv252 = num(data.hv252)
    if (isNum(hv20)) { yr0[0] = Math.min(yr0[0], hv20); yr0[1] = Math.max(yr0[1], hv20) }
    if (isNum(hv252)) { yr0[0] = Math.min(yr0[0], hv252); yr0[1] = Math.max(yr0[1], hv252) }
    var yr = pad(yr0[0], yr0[1], 0.14)

    var p = frame(W, H, [56, 40, 22, 48])
    var xs = sc(xr[0], xr[1], p.x, p.x + p.w)
    var ys = sc(yr[0], yr[1], p.y + p.h, p.y)
    var o = [open(W, H), titleSvg(data.title, W)]

    o.push(axes(p, {
      xt: niceTicks(xr[0], xr[1], 6), yt: niceTicks(yr[0], yr[1], 5),
      xs: xs, ys: ys,
      xfmt: function (v) { return fmt(v) + 'D' }, yfmt: function (v) { return pct(v) },
      xTitle: '到期天数 (DTE)', yTitle: '隐含波动率 IV'
    }))
    if (isNum(hv20)) o.push(hline(p, ys(hv20), C.buy, 'HV20 ' + pct(hv20)))
    if (isNum(hv252)) o.push(hline(p, ys(hv252), C.sell, 'HV252 ' + pct(hv252)))

    o.push('<path d="' + poly(pts, xs, ys) + '" style="fill:none;stroke:' + C.accent +
      '" stroke-width="2.2" stroke-linejoin="round"/>')
    pts.forEach(function (q) {
      o.push('<circle cx="' + r2(xs(q.x)) + '" cy="' + r2(ys(q.y)) + '" r="3.2" style="fill:' + C.accent +
        ';stroke:' + C.surface + '" stroke-width="1"><title>' + esc(fmt(q.x) + 'D  IV ' + pct(q.y)) +
        '</title></circle>')
    })

    var first = pts[0], last = pts[pts.length - 1]
    var contango = last.y > first.y
    o.push(badge(p.x + p.w, p.y + 2, contango ? 'Contango（远期 IV 更高）' : 'Backwardation（近月 IV 更高）',
      contango ? C.buy : C.sell, 'right'))
    o.push('</svg>')
    return mount(el, o.join(''))
  }

  /* ============================================================
   * 4.5 IV Skew
   * ========================================================== */
  function renderSkew(el, data, opts) {
    opts = opts || {}; data = data || {}
    var W = opts.width || 720, H = opts.height || 320
    var pts = cleanPts(data.points, 'strike', 'iv')
    if (!pts.length) return mount(el, emptyState(W, H, opts.emptyText || '暂无数据'))
    var dx = domX(pts), dy = domY(pts)
    var xr = pad(dx[0], dx[1], 0.05)
    var yr = pad(dy[0], dy[1], 0.14)
    var p = frame(W, H, [56, 40, 22, 48])
    var xs = sc(xr[0], xr[1], p.x, p.x + p.w)
    var ys = sc(yr[0], yr[1], p.y + p.h, p.y)
    var spot = num(data.spot)
    var o = [open(W, H), titleSvg(data.title, W)]

    o.push(axes(p, {
      xt: niceTicks(xr[0], xr[1], 6), yt: niceTicks(yr[0], yr[1], 5),
      xs: xs, ys: ys,
      xfmt: function (v) { return '$' + fmt(v) }, yfmt: function (v) { return pct(v) },
      xTitle: '行权价 (Strike)', yTitle: '隐含波动率 IV'
    }))
    if (isNum(spot)) o.push(vline(p, xs(spot), true, C.accent, '现价 ' + price(spot)))
    o.push('<path d="' + poly(pts, xs, ys) + '" style="fill:none;stroke:' + C.accent +
      '" stroke-width="2.2" stroke-linejoin="round"/>')
    pts.forEach(function (q) {
      var mn = num(q.raw && q.raw.moneyness)
      o.push('<circle cx="' + r2(xs(q.x)) + '" cy="' + r2(ys(q.y)) + '" r="3.2" style="fill:' + C.accent +
        ';stroke:' + C.surface + '" stroke-width="1"><title>K ' + esc(fmt(q.x)) + '  IV ' + esc(pct(q.y)) +
        (isNum(mn) ? '  (' + (mn >= 0 ? '+' : '') + mn.toFixed(1) + '% moneyness)' : '') + '</title></circle>')
    })
    o.push('</svg>')
    return mount(el, o.join(''))
  }

  /* ============================================================
   * 4.6 風險中性機率密度
   * ========================================================== */
  function renderDistribution(el, data, opts) {
    opts = opts || {}; data = data || {}
    var W = opts.width || 720, H = opts.height || 340
    var pts = cleanPts(data.points, 'price', 'density')
    if (!pts.length) return mount(el, emptyState(W, H, opts.emptyText || '暂无数据'))
    var dx = domX(pts), dy = domY(pts)
    var xr = pad(dx[0], dx[1], 0.03)
    var yr = [0, dy[1] * 1.12 || 1]
    var p = frame(W, H, [58, 40, 22, 52])
    var xs = sc(xr[0], xr[1], p.x, p.x + p.w)
    var ys = sc(yr[0], yr[1], p.y + p.h, p.y)
    var base = p.y + p.h
    var spot = num(data.spot)
    var gid = nid('dist')
    var o = [open(W, H), titleSvg(data.title, W)]

    o.push('<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" style="stop-color:' + C.accent + '" stop-opacity="0.42"/>' +
      '<stop offset="100%" style="stop-color:' + C.accent + '" stop-opacity="0.02"/></linearGradient></defs>')

    o.push(axes(p, {
      xt: niceTicks(xr[0], xr[1], 6), yt: niceTicks(yr[0], yr[1], 4),
      xs: xs, ys: ys,
      xfmt: function (v) { return '$' + fmt(v) }, yfmt: function (v) { return fmt(v) },
      xTitle: '到期股价 (Price)', yTitle: '概率密度'
    }))

    /* σ 區間陰影 */
    ;(data.intervals || []).forEach(function (iv) {
      var a = num(iv.from), b = num(iv.to)
      if (!isNum(a) || !isNum(b)) return
      var xa = cl(xs(a), p.x, p.x + p.w), xb = cl(xs(b), p.x, p.x + p.w)
      if (xb <= xa) return
      var op = iv.level === 1 ? 0.2 : (iv.level === 2 ? 0.1 : 0.14)
      o.push('<rect x="' + r2(xa) + '" y="' + p.y + '" width="' + r2(xb - xa) + '" height="' + p.h +
        '" style="fill:' + C.accent + '" fill-opacity="' + op + '"/>')
      if (iv.label) {
        o.push('<text x="' + r2((xa + xb) / 2) + '" y="' + r2(base - 6) + '" text-anchor="middle"' +
          ' font-size="10" style="fill:' + C.accent + '">' + esc(iv.label) + '</text>')
      }
    })

    /* 密度曲線 + 漸變填充 */
    o.push('<path d="' + areaPath(pts, xs, ys, base) + '" style="fill:url(#' + gid + ')"/>')
    o.push('<path d="' + poly(pts, xs, ys) + '" style="fill:none;stroke:' + C.accent +
      '" stroke-width="2" stroke-linejoin="round"/>')

    if (isNum(spot)) o.push(vline(p, xs(spot), true, C.text, '现价 ' + price(spot), true, 0.8))
    ;(data.breakevens || []).map(num).filter(isNum).forEach(function (b) {
      // BE 标签放顶部，避免与底部的 ±σ 区间标签重叠
      o.push(vline(p, xs(b), true, C.profit, 'BE ' + price(b), true, 0.9))
    })
    o.push(hoverDots(pts, xs, ys, function (q) {
      return '价格 $' + fmt(q.x) + '  密度 ' + fmt(q.y)
    }))
    o.push('</svg>')
    return mount(el, o.join(''))
  }

  /* ============================================================
   * 4.7 Greeks 雙向條形
   * ========================================================== */
  function renderGreeksBars(el, data, opts) {
    opts = opts || {}; data = data || {}
    var W = opts.width || 720
    var items = (data.items || []).filter(function (d) { return d && isNum(num(d.value)) })
    var H = opts.height || cl(items.length * 38 + 76, 200, 520)
    if (!items.length) return mount(el, emptyState(W, H, opts.emptyText || '暂无数据'))
    var mx = 0
    items.forEach(function (d) { mx = Math.max(mx, Math.abs(num(d.value))) })
    if (!(mx > 0)) mx = 1
    var p = frame(W, H, [10, 40, 10, 34])
    var labW = cl(tw('Vega') + (W >= 560 ? 96 : 24), 60, 190)
    var cx = p.x + labW + (p.w - labW) / 2
    var half = Math.max(20, (p.w - labW) / 2 - 72)
    var rowH = p.h / items.length
    var bh = cl(rowH * 0.5, 8, 22)
    var o = [open(W, H), titleSvg(data.title, W)]

    /* 中心零軸 */
    o.push('<line x1="' + r2(cx) + '" y1="' + r2(p.y - 6) + '" x2="' + r2(cx) + '" y2="' + r2(p.y + p.h + 6) +
      '" style="stroke:' + C.axis + '" stroke-width="1.4"/>')
    o.push('<text x="' + r2(cx) + '" y="' + r2(p.y + p.h + 20) + '" text-anchor="middle" font-size="10"' +
      ' style="fill:' + C.muted + '">0</text>')

    items.forEach(function (d, i) {
      var v = num(d.value)
      var cy = p.y + i * rowH + rowH / 2
      var col = v >= 0 ? C.profit : C.loss
      var len = Math.abs(v) / mx * half
      var x0 = v >= 0 ? cx : cx - len
      o.push('<text x="' + r2(p.x + 2) + '" y="' + r2(cy) + '" dominant-baseline="middle" font-size="11.5"' +
        ' style="fill:' + C.text + '">' + esc(d.name || '') + '</text>')
      if (d.desc && W >= 560) {
        o.push('<text x="' + r2(p.x + 52) + '" y="' + r2(cy) + '" dominant-baseline="middle" font-size="10"' +
          ' style="fill:' + C.muted + '">' + esc(d.desc) + '</text>')
      }
      o.push('<rect x="' + r2(x0) + '" y="' + r2(cy - bh / 2) + '" width="' + r2(Math.max(1, len)) +
        '" height="' + r2(bh) + '" rx="2" style="fill:' + col + '" fill-opacity="0.85">' +
        '<title>' + esc((d.name || '') + '  ' + fmt(v) + (d.unit ? ' ' + d.unit : '') +
        (d.desc ? '  · ' + d.desc : '')) + '</title></rect>')
      var tx = v >= 0 ? cx + len + 6 : cx - len - 6
      o.push('<text x="' + r2(tx) + '" y="' + r2(cy) + '" text-anchor="' + (v >= 0 ? 'start' : 'end') +
        '" dominant-baseline="middle" font-size="11" style="fill:' + col + '">' +
        esc((v >= 0 ? '+' : '') + fmt(v) + (d.unit ? ' ' + d.unit : '')) + '</text>')
    })
    o.push('</svg>')
    return mount(el, o.join(''))
  }

  /* ============================================================
   * 4.8 IV vs HV 歷史
   * ========================================================== */
  function renderIVHistory(el, data, opts) {
    opts = opts || {}; data = data || {}
    var W = opts.width || 720, H = opts.height || 320
    var raw = []
    ;(data.points || []).forEach(function (d, i) {
      if (!d) return
      var iv = num(d.iv), hv = num(d.hv)
      if (isNum(iv) || isNum(hv)) raw.push({ x: i, iv: isNum(iv) ? iv : null, hv: isNum(hv) ? hv : null, date: d.date })
    })
    if (!raw.length) return mount(el, emptyState(W, H, opts.emptyText || '暂无数据'))
    var yr0 = [Infinity, -Infinity]
    raw.forEach(function (q) {
      if (q.iv != null) { yr0[0] = Math.min(yr0[0], q.iv); yr0[1] = Math.max(yr0[1], q.iv) }
      if (q.hv != null) { yr0[0] = Math.min(yr0[0], q.hv); yr0[1] = Math.max(yr0[1], q.hv) }
    })
    var civ = num(data.currentIV)
    if (isNum(civ)) { yr0[0] = Math.min(yr0[0], civ); yr0[1] = Math.max(yr0[1], civ) }
    var yr = pad(yr0[0], yr0[1], 0.12)
    var p = frame(W, H, [56, 40, 22, 48])
    var n = raw.length
    var xs = sc(0, Math.max(1, n - 1), p.x, p.x + p.w)
    var ys = sc(yr[0], yr[1], p.y + p.h, p.y)

    /* x 軸標籤：最多 6 個 */
    var xt = [], k = Math.min(6, n)
    for (var i = 0; i < k; i++) {
      var j = k === 1 ? 0 : Math.round(i * (n - 1) / (k - 1))
      xt.push({ v: j, t: raw[j].date != null ? String(raw[j].date) : '' })
    }
    var o = [open(W, H), titleSvg(data.title, W)]
    o.push(axes(p, {
      xt: xt, yt: niceTicks(yr[0], yr[1], 5),
      xs: xs, ys: ys, xSkip: 1,
      yfmt: function (v) { return pct(v) },
      xTitle: '日期', yTitle: '波动率 %'
    }))

    if (isNum(civ)) o.push(hline(p, ys(civ), C.muted, '当前 IV ' + pct(civ)))

    /* 分段畫線，hv 為 null 時斷開 */
    function strokeLine(key, color) {
      var seg = [], s = []
      raw.forEach(function (q) {
        if (q[key] == null) { if (seg.length) s.push(seg); seg = [] }
        else seg.push({ x: q.x, y: q[key] })
      })
      if (seg.length) s.push(seg)
      var out = ''
      s.forEach(function (g) {
        if (g.length < 2) {
          out += '<circle cx="' + r2(xs(g[0].x)) + '" cy="' + r2(ys(g[0].y)) + '" r="2" style="fill:' + color + '"/>'
          return
        }
        out += '<path d="' + poly(g, xs, ys) + '" style="fill:none;stroke:' + color +
          '" stroke-width="2" stroke-linejoin="round"/>'
      })
      return out
    }
    o.push(strokeLine('hv', C.buy))
    o.push(strokeLine('iv', C.accent))
    o.push(hoverDots(mapv(raw.filter(function (q) { return q.iv != null }), function (q) { return { x: q.x, y: q.iv, raw: q } }),
      xs, ys, function (q) {
        return (q.raw.date || '') + '  IV ' + pct(q.y) + (q.raw.hv != null ? '  HV ' + pct(q.raw.hv) : '')
      }))
    o.push(legend(p.x + p.w, p.y + 2, [
      { name: 'IV（隐含波动率）', color: C.accent },
      { name: 'HV（实现波动率）', color: C.buy }
    ], 'right'))

    /* 徽章：IV Rank / IV Percentile */
    var b1 = num(data.ivRank), b2 = num(data.ivPercentile)
    var by = p.y + 2
    if (isNum(b2)) o.push(badge(p.x + p.w, by + 24, 'IV Percentile ' + fmt(b2), C.accent, 'right'))
    if (isNum(b1)) o.push(badge(p.x + p.w, by, 'IV Rank ' + fmt(b1), C.accent, 'right'))
    o.push('</svg>')
    return mount(el, o.join(''))
  }

  /* ============================================================
   * 5. 導出
   * ========================================================== */
  return {
    renderPayoff: renderPayoff,
    renderMultiCurve: renderMultiCurve,
    renderHeatmap: renderHeatmap,
    renderTermStructure: renderTermStructure,
    renderSkew: renderSkew,
    renderDistribution: renderDistribution,
    renderGreeksBars: renderGreeksBars,
    renderIVHistory: renderIVHistory,
    /* 工具（可選複用） */
    fmt: fmt,
    money: money,
    pct: pct,
    version: '1.0.0'
  }
});
