/* =============================================================================
 * OptionDesk Strategy Engine v2.0 — 多腿组合与策略模板
 * 原站仅支持单腿 Long Call；这里支持任意多腿组合（含股票腿、不同到期日）。
 * ============================================================================= */
(function (root, factory) {
  var E = (typeof module === 'object' && module.exports) ? require('./engine.js') : root.OptionEngine;
  var api = factory(E);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OptionStrategies = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E) {
  'use strict';

  var MULT = 100;          // 美股期权合约乘数
  var DAYS = E.DAYS_YEAR;

  /* ===========================================================================
   * 腿（Leg）结构
   *   kind : 'call' | 'put' | 'stock'
   *   side :  1 = 买入(long) / -1 = 卖出(short)
   *   qty  : 期权=合约张数，股票=股数
   *   price: 每股/每股的成交价（成本基准）
   *   strike, dte, iv
   * ======================================================================== */
  function makeLeg(o) {
    return {
      id: o.id || ('leg' + Math.random().toString(36).slice(2, 8)),
      kind: o.kind || 'call',
      side: o.side === -1 ? -1 : 1,
      qty: E.finite(o.qty) ? Math.abs(o.qty) : 1,
      strike: o.kind === 'stock' ? null : (E.finite(o.strike) ? o.strike : null),
      dte: E.finite(o.dte) ? Math.max(0, Math.round(o.dte)) : 30,
      price: E.finite(o.price) ? o.price : 0,
      iv: E.finite(o.iv) ? o.iv : null,
      expiry: o.expiry || null,
      // 来自期权链的补充信息（可选）
      bid: E.num(o.bid), ask: E.num(o.ask), oi: E.num(o.oi), volume: E.num(o.volume)
    };
  }
  function legMult(leg) { return leg.kind === 'stock' ? 1 : MULT; }
  function legSign(leg) { return leg.side; }
  /** 单腿在一股标的上的名义敞口（不含乘数） */
  function legDelta(leg, S, r, q) {
    if (leg.kind === 'stock') return leg.side * leg.qty;
    var T = leg.dte / DAYS;
    if (!E.finite(leg.iv) || leg.dte <= 0) {
      var itm = leg.kind === 'call' ? S > leg.strike : S < leg.strike;
      return leg.side * leg.qty * MULT * (itm ? 1 : 0) * (leg.kind === 'put' ? -1 : 1);
    }
    var g = E.greeks(leg.kind, S, leg.strike, T, leg.iv, r, q);
    return leg.side * leg.qty * MULT * g.delta;
  }

  /* ===========================================================================
   * 组合估值
   * ======================================================================== */

  /**
   * 某条腿在给定股价、已过天数、IV 偏移下的单股价值。
   *
   * 单位约定（全文统一，勿混用）：
   *   leg.iv / ivOverride → 小数形式（0.348 = 34.8%）
   *   ivShift             → IV 百分点（10 表示 34.8% → 44.8%）
   */
  function legValue(leg, S, daysElapsed, r, q, ivShift, ivOverride, american) {
    var remaining = Math.max(0, leg.dte - daysElapsed);
    if (leg.kind === 'stock') return S;
    if (leg.strike === null || !E.finite(leg.strike)) return 0;
    if (remaining <= 0) return E.intrinsic(leg.kind, S, leg.strike);
    var iv;
    if (E.finite(ivOverride)) iv = ivOverride;
    else if (E.finite(leg.iv)) iv = leg.iv + (E.finite(ivShift) ? ivShift : 0) / 100;
    else iv = null;
    if (iv === null) return E.intrinsic(leg.kind, S, leg.strike);
    iv = Math.max(0, iv);                      // IV 不可能为负
    if (iv <= 0) return E.intrinsic(leg.kind, S, leg.strike);
    var T = remaining / DAYS;
    return american
      ? E.binomialPrice(leg.kind, S, leg.strike, T, iv, r, q, 100, true)
      : E.bsPrice(leg.kind, S, leg.strike, T, iv, r, q);
  }

  /**
   * 组合盈亏（美元总额）。
   * daysElapsed: 距今天数（0 = 建仓时）
   * 返回 {pnl, value, cost, byLeg:[{leg, value, pnl}]}
   */
  function positionValue(legs, S, daysElapsed, opts) {
    opts = opts || {};
    var r = E.finite(opts.rate) ? opts.rate : 0.043;
    var q = E.finite(opts.dividend) ? opts.dividend : 0;
    var ivShift = E.finite(opts.ivShift) ? opts.ivShift : 0;
    var ivOverride = E.finite(opts.ivOverride) ? opts.ivOverride : null;
    var american = opts.american !== false;
    var totalValue = 0, totalCost = 0, byLeg = [];
    for (var i = 0; i < legs.length; i++) {
      var leg = legs[i], m = legMult(leg);
      var v = legValue(leg, S, daysElapsed, r, q, ivShift, ivOverride, american);
      var val = leg.side * leg.qty * m * v;
      var cost = leg.side * leg.qty * m * leg.price;
      totalValue += val; totalCost += cost;
      byLeg.push({ leg: leg, unitValue: v, value: val, cost: cost, pnl: val - cost });
    }
    return { pnl: totalValue - totalCost, value: totalValue, cost: totalCost, byLeg: byLeg };
  }

  /** 净权利金（美元）。正 = 净收入(credit)，负 = 净支出(debit)。仅统计期权腿。 */
  function netPremium(legs) {
    var net = 0;
    legs.forEach(function (l) {
      if (l.kind === 'stock') return;
      net += -l.side * l.qty * MULT * l.price;   // 卖出收钱为正
    });
    return net;
  }

  /** 组合 Greeks（美元敞口，已乘乘数与张数） */
  function positionGreeks(legs, S, r, q) {
    r = E.finite(r) ? r : 0.043; q = E.finite(q) ? q : 0;
    var acc = { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0, vanna: 0, charm: 0, vomma: 0, veta: 0 };
    var perLeg = [];
    legs.forEach(function (leg) {
      var m = legMult(leg), f = leg.side * leg.qty * m;
      if (leg.kind === 'stock') {
        perLeg.push({ leg: leg, delta: f, gamma: 0, theta: 0, vega: 0, rho: 0, vanna: 0, charm: 0, vomma: 0, veta: 0 });
        acc.delta += f;
        return;
      }
      var T = leg.dte / DAYS;
      var g;
      if (!E.finite(leg.iv) || T <= 0) {
        g = { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0, vanna: 0, charm: 0, vomma: 0, veta: 0 };
        var itm = leg.kind === 'call' ? S > leg.strike : S < leg.strike;
        g.delta = (itm ? 1 : 0) * (leg.kind === 'put' ? -1 : 1);
      } else {
        g = E.greeks(leg.kind, S, leg.strike, T, leg.iv, r, q);
      }
      var row = {
        leg: leg, delta: g.delta * f, gamma: g.gamma * f, theta: g.theta * f,
        vega: g.vega * f, rho: g.rho * f, vanna: g.vanna * f,
        charm: g.charm * f, vomma: g.vomma * f, veta: g.veta * f
      };
      perLeg.push(row);
      Object.keys(acc).forEach(function (k) { acc[k] += (E.finite(row[k]) ? row[k] : 0); });
    });
    acc.perLeg = perLeg;
    return acc;
  }

  /* ===========================================================================
   * 到期损益分析：最大盈亏、盈亏平衡点、曲线
   * ======================================================================== */

  /** S→∞ 时的损益斜率，用于判断是否存在无限盈亏 */
  function upSlope(legs) {
    var s = 0;
    legs.forEach(function (l) {
      var f = l.side * l.qty * legMult(l);
      if (l.kind === 'call' || l.kind === 'stock') s += f;   // 上涨时斜率 1
      // put 在 S→∞ 时内在价值为 0，斜率 0
    });
    return s;
  }
  /** S→0 时的损益（有限值），用于判断下行最大风险 */
  function valueAtZero(legs) {
    var pnl = 0;
    legs.forEach(function (l) {
      var f = l.side * l.qty * legMult(l);
      var v = l.kind === 'put' ? (l.strike || 0) : 0;   // S=0: put 内在=K, call/stock=0
      pnl += f * (v - l.price);
    });
    return pnl;
  }

  /** 到期损益曲线（在 [lo, hi] 上采样） */
  function payoffCurve(legs, lo, hi, points, opts) {
    points = points || 241;
    var out = [];
    for (var i = 0; i < points; i++) {
      var S = lo + (hi - lo) * i / (points - 1);
      var v = positionValue(legs, S, 1e9, opts); // daysElapsed 极大 → 全部到期
      out.push({ stock: S, pnl: v.pnl, value: v.value });
    }
    return out;
  }

  /**
   * 求解盈亏平衡点：在到期曲线上寻找 pnl 变号点，二分细化。
   * 返回排序后的数组。
   */
  function breakevens(legs, lo, hi, opts) {
    var scanN = 1201, xs = [], prev = null, res = [];
    for (var i = 0; i < scanN; i++) {
      var S = lo + (hi - lo) * i / (scanN - 1);
      var pnl = positionValue(legs, S, 1e9, opts).pnl;
      if (prev !== null && ((prev.pnl <= 0 && pnl > 0) || (prev.pnl >= 0 && pnl < 0))) {
        // 二分
        var a = prev.stock, b = S, fa = prev.pnl;
        for (var k = 0; k < 60; k++) {
          var m = (a + b) / 2, fm = positionValue(legs, m, 1e9, opts).pnl;
          if ((fa <= 0 && fm > 0) || (fa >= 0 && fm < 0)) { b = m; } else { a = m; fa = fm; }
          if (b - a < 1e-9) break;
        }
        res.push((a + b) / 2);
      }
      prev = { stock: S, pnl: pnl };
    }
    return res.filter(E.finite).sort(function (x, y) { return x - y; });
  }

  /** 综合风险指标 */
  function riskProfile(legs, spot, opts) {
    opts = opts || {};
    var r = E.finite(opts.rate) ? opts.rate : 0.043;
    var q = E.finite(opts.dividend) ? opts.dividend : 0;
    if (!legs.length) return null;

    // 采样区间：以行权价与现价共同决定，覆盖全部有意义区域
    var strikes = legs.map(function (l) { return l.strike; }).filter(E.finite);
    var anchor = E.finite(spot) ? spot : (strikes.length ? strikes[0] : 100);
    var lo = 0, hi = anchor * 2;
    if (strikes.length) {
      lo = Math.max(0, Math.min(anchor, Math.min.apply(null, strikes)) * 0.5);
      hi = Math.max(anchor, Math.max.apply(null, strikes)) * 1.5;
    }
    if (!(hi > lo)) { hi = lo + 1; }

    var curve = payoffCurve(legs, lo, hi, 601, opts);
    var bes = breakevens(legs, lo, hi, opts);
    var slope = upSlope(legs);
    var atZero = valueAtZero(legs);
    var atInf = slope * 1;  // 方向

    var maxP = -Infinity, maxL = Infinity, maxPAt = null, maxLAt = null;
    curve.forEach(function (pt) {
      if (pt.pnl > maxP) { maxP = pt.pnl; maxPAt = pt.stock; }
      if (pt.pnl < maxL) { maxL = pt.pnl; maxLAt = pt.stock; }
    });
    // 边界行为
    if (slope > 0) maxP = null;          // 上涨无限盈利
    else if (slope < 0) maxL = null;     // 上涨无限亏损
    if (atZero > (E.finite(maxP) ? maxP : Infinity)) { maxP = atZero; maxPAt = 0; }
    if (atZero < (E.finite(maxL) ? maxL : -Infinity)) { maxL = atZero; maxLAt = 0; }
    if (maxP !== null && maxP < 0) maxP = 0;  // 全部亏损的情形不可能存在（可全部放弃）
    if (maxL !== null && maxL > 0) maxL = 0;

    var net = netPremium(legs);
    var capital = capitalRequirement(legs, anchor, maxL);
    var maxProfitPct = (maxP !== null && capital > 0) ? maxP / capital * 100 : null;
    var maxLossPct = (maxL !== null && capital > 0) ? Math.abs(maxL) / capital * 100 : null;
    var rr = (maxP !== null && maxL !== null && maxL < 0) ? Math.abs(maxP / maxL) : null;

    return {
      curve: curve, breakevens: bes,
      maxProfit: maxP, maxProfitAt: maxPAt,
      maxLoss: maxL, maxLossAt: maxLAt,
      unlimitedProfit: slope > 0, unlimitedLoss: slope < 0,
      netPremium: net, capital: capital,
      maxProfitPct: maxProfitPct, maxLossPct: maxLossPct, riskReward: rr,
      lo: lo, hi: hi,
      // 盈亏区间（用于图表着色）
      bands: buildBands(curve, bes, lo, hi)
    };
  }

  /** 由曲线与平衡点构造盈亏着色区间 */
  function buildBands(curve, bes, lo, hi) {
    if (!bes.length) {
      // 无平衡点：整体盈利或亏损（理论上不可能全亏，保守给盈利色）
      return [{ from: lo, to: hi, kind: curve[0].pnl >= 0 ? 'profit' : 'loss' }];
    }
    var bands = [], edges = [lo].concat(bes, [hi]);
    for (var i = 0; i < edges.length - 1; i++) {
      var mid = (edges[i] + edges[i + 1]) / 2;
      var pnl = null;
      for (var j = 0; j < curve.length; j++) {
        if (Math.abs(curve[j].stock - mid) < (hi - lo) / 1000) { pnl = curve[j].pnl; break; }
      }
      if (pnl === null) { // 回退：取区间内任一点
        var best = null, bestD = Infinity;
        curve.forEach(function (pt) {
          var d = Math.abs(pt.stock - mid);
          if (d < bestD) { bestD = d; best = pt; }
        });
        pnl = best ? best.pnl : 0;
      }
      bands.push({ from: edges[i], to: edges[i + 1], kind: pnl >= 0 ? 'profit' : 'loss' });
    }
    return bands;
  }

  /* ===========================================================================
   * 资金占用 / 保证金（Reg T 简化估算）
   * 含价差抵扣：若组合的最大亏损小于裸卖保证金之和，
   * 说明存在价差结构（如 Iron Condor / Vertical），按最大亏损计。
   * ======================================================================== */
  function capitalRequirement(legs, spot, maxLoss) {
    var cap = 0;
    var stock = legs.filter(function (l) { return l.kind === 'stock'; });

    // 股票腿：多头按市值计，空头按 50% 保证金计（简化）
    stock.forEach(function (l) {
      cap += Math.abs(l.qty) * spot * (l.side === 1 ? 1 : 0.5);
    });

    // 期权裸卖保证金（未做价差抵扣的保守值）
    var naked = 0;
    ['call', 'put'].forEach(function (kind) {
      var shorts = legs.filter(function (l) { return l.kind === kind && l.side === -1 && l.strike !== null; });
      var longs = legs.filter(function (l) { return l.kind === kind && l.side === 1 && l.strike !== null; });
      shorts.forEach(function (sh) {
        var K = sh.strike, n = sh.qty;
        var perSpread = kind === 'call'
          ? Math.max(0.20 * spot - Math.max(0, K - spot), 0.10 * K)
          : Math.max(0.20 * spot - Math.max(0, spot - K), 0.10 * K);
        naked += n * MULT * perSpread;
      });
    });
    // 多头期权按已付权利金计
    var longPrem = 0;
    legs.forEach(function (l) {
      if (l.kind !== 'stock' && l.side === 1) longPrem += l.qty * MULT * l.price;
    });
    var optCap = Math.max(naked, longPrem);

    // 价差抵扣：有界风险结构的保证金不会超过其最大亏损
    // （Reg T 对 vertical/condor 按「翼宽 − 权利金」收取，恰为最大亏损）
    if (E.finite(maxLoss) && maxLoss < 0 && Math.abs(maxLoss) < optCap) {
      optCap = Math.abs(maxLoss);
    }
    cap += optCap;
    // 净权利金（credit）可抵扣
    var net = netPremium(legs.filter(function (l) { return l.kind !== 'stock'; }));
    if (net > 0) cap = Math.max(0, cap - net);
    return cap;
  }

  /* ===========================================================================
   * 概率分析：POP / 期望值
   * ======================================================================== */
  /**
   * 用风险中性终端分布对到期损益做数值积分，得到：
   *   pop   : 盈利概率
   *   ev    : 期望盈亏（美元）
   *   evPerDay, evAnnualized
   */
  function probabilityAnalysis(legs, spot, opts) {
    opts = opts || {};
    var r = E.finite(opts.rate) ? opts.rate : 0.043;
    var q = E.finite(opts.dividend) ? opts.dividend : 0;
    // 组合的代表性波动率：按 Vega 加权
    var g = positionGreeks(legs, spot, r, q);
    var vol = E.finite(opts.vol) ? opts.vol : weightedIV(legs, spot);
    if (!E.finite(vol) || vol <= 0) return null;
    var maxDte = legs.reduce(function (m, l) { return Math.max(m, l.dte); }, 0);
    if (maxDte <= 0) return null;
    var T = maxDte / DAYS;

    // 在 ±5σ 的价格区间上，用梯形法则对「损益 × 风险中性密度」积分
    var sd = vol * Math.sqrt(T);
    var lo = Math.max(1e-9, spot * Math.exp(-5 * sd));
    var hi = spot * Math.exp(5 * sd);
    var N = 1000, lin = [];
    for (var i = 0; i < N; i++) {
      var S = lo + (hi - lo) * i / (N - 1);
      lin.push({ S: S, pnl: positionValue(legs, S, 1e9, opts).pnl, dens: E.densityAt(spot, T, vol, r, q, S) });
    }
    var ev = 0, pop = 0, totalProb = 0;
    for (var k = 0; k < lin.length - 1; k++) {
      var a = lin[k], b = lin[k + 1], h = b.S - a.S;
      var areaDens = (a.dens + b.dens) / 2 * h;
      ev += (a.pnl * a.dens + b.pnl * b.dens) / 2 * h;
      if ((a.pnl + b.pnl) / 2 > 0) pop += areaDens;
      totalProb += areaDens;
    }
    if (totalProb <= 0) return null;
    pop = E.clamp(pop / totalProb, 0, 1);
    ev = ev / totalProb;   // 用总概率归一化，消除离散化残差

    // 各盈亏平衡点被触及的概率（尾部风险指标）
    var prof = riskProfile(legs, spot, opts);
    var touchBE = (prof && prof.breakevens) ? prof.breakevens.map(function (b) {
      return {
        price: b,
        probTouch: b > spot ? E.probTouch(spot, T, vol, r, q, b, 'up') : E.probTouch(spot, T, vol, r, q, b, 'down'),
        probBeyond: b > spot ? E.probAbove(spot, T, vol, r, q, b) : E.probBelow(spot, T, vol, r, q, b)
      };
    }) : null;

    return {
      pop: pop, ev: ev, vol: vol, T: T,
      expectedMove: E.expectedMove(spot, T, vol, 1),
      breakevenRisk: touchBE
    };
  }

  /** 组合加权 IV：按 |Vega| 加权，Vega 全为 0 时退化为简单平均 */
  function weightedIV(legs, spot) {
    var r = 0.043, q = 0, num = 0, den = 0, simple = 0, cnt = 0;
    legs.forEach(function (l) {
      if (l.kind === 'stock' || !E.finite(l.iv)) return;
      var T = l.dte / DAYS;
      var vg = T > 0 ? Math.abs(E.bsVegaRaw(l.kind, spot, l.strike, T, l.iv, r, q) * l.qty) : 0;
      num += l.iv * vg; den += vg;
      simple += l.iv; cnt++;
    });
    if (den > 0) return num / den;
    return cnt ? simple / cnt : null;
  }

  /* ===========================================================================
   * 时点曲线：T+0 / T+n / 到期（展示 Theta 路径）
   * ======================================================================== */
  function timeSlices(legs, spot, opts) {
    opts = opts || {};
    var maxDte = legs.reduce(function (m, l) { return Math.max(m, l.dte || 0); }, 0);
    var marks = opts.marks;
    if (!marks) {
      marks = [0];
      [7, 14, 30, 60, 90].forEach(function (d) { if (d < maxDte) marks.push(d); });
      marks.push(maxDte);
    }
    var prof = riskProfile(legs, spot, opts);
    var lo = prof ? prof.lo : spot * 0.5, hi = prof ? prof.hi : spot * 1.5;
    return marks.map(function (d) {
      var pts = [];
      for (var i = 0; i < 121; i++) {
        var S = lo + (hi - lo) * i / 120;
        var v = positionValue(legs, S, d, opts);
        pts.push({ stock: S, pnl: v.pnl });
      }
      return { days: d, label: d === 0 ? '今天' : (d === maxDte ? '到期' : 'T+' + d), points: pts };
    });
  }

  /* ===========================================================================
   * 双因子热力矩阵：股价 × 时间 / 股价 × IV
   * ======================================================================== */
  function matrix(legs, spot, opts) {
    opts = opts || {};
    var mode = opts.mode || 'time';       // 'time' | 'iv'
    var metric = opts.metric || 'roi';    // 'roi' | 'pnl' | 'value'
    var rowsN = opts.rows || 21, colsN = opts.cols || 13;
    var prof = riskProfile(legs, spot, opts);
    var lo = opts.priceMin != null ? opts.priceMin : (prof ? prof.lo : spot * 0.6);
    var hi = opts.priceMax != null ? opts.priceMax : (prof ? prof.hi : spot * 1.4);
    if (!(hi > lo)) { hi = lo + 1; }
    var maxDte = legs.reduce(function (m, l) { return Math.max(m, l.dte || 0); }, 0);

    var cols = [];
    if (mode === 'time') {
      for (var c = 0; c < colsN; c++) {
        var d = Math.round(maxDte * c / (colsN - 1));
        cols.push({ key: d, label: d === 0 ? '今天' : (d === maxDte ? '到期' : 'T+' + d) });
      }
    } else {
      var baseIV = E.finite(opts.baseIV) ? opts.baseIV : (weightedIV(legs, spot) || 0.30);
      var span = E.finite(opts.ivSpan) ? opts.ivSpan : 20;
      for (var c2 = 0; c2 < colsN; c2++) {
        var shift = -span + 2 * span * c2 / (colsN - 1);
        cols.push({ key: shift, label: (shift >= 0 ? '+' : '') + shift.toFixed(0) + 'pt' });
      }
    }

    var rows = [];
    for (var rI = 0; rI < rowsN; rI++) {
      var S = hi - (hi - lo) * rI / (rowsN - 1);   // 第一行最高价
      var cells = cols.map(function (col) {
        var o = Object.assign({}, opts);
        if (mode === 'time') o.ivShift = 0; else { o.ivShift = col.key; }
        var res = mode === 'time'
          ? positionValue(legs, S, col.key, o)
          : positionValue(legs, S, E.finite(opts.elapsed) ? opts.elapsed : Math.round(maxDte * 0.4), o);
        var invested = Math.abs(netPremium(legs)) || 1;
        var v;
        if (metric === 'roi') v = res.cost !== 0 ? (res.pnl / Math.abs(res.cost)) * 100 : (res.pnl / invested * 100);
        else if (metric === 'pnl') v = res.pnl;
        else v = res.value;
        return { value: v, pnl: res.pnl, text: formatMetric(v, metric) };
      });
      rows.push({ stock: S, change: (S / spot - 1) * 100, label: '$' + S.toFixed(0) + ' (' + (S / spot - 1 >= 0 ? '+' : '') + ((S / spot - 1) * 100).toFixed(0) + '%)', cells: cells });
    }
    return { mode: mode, metric: metric, rows: rows, cols: cols, lo: lo, hi: hi };
  }

  function formatMetric(v, metric) {
    if (!E.finite(v)) return '—';
    if (metric === 'roi') return (v >= 0 ? '+' : '') + v.toFixed(0) + '%';
    if (metric === 'pnl') return (v >= 0 ? '+' : '') + (Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0));
    return v.toFixed(1);
  }

  /* ===========================================================================
   * 策略模板库
   * 每个模板：build(ctx) → legs[]
   * ctx: {spot, dte, widthPct, iv, chainPicker, qty, targetDelta}
   * ======================================================================== */
  function strikeByOffset(spot, offsetPct) {
    return Math.max(0.01, spot * (1 + offsetPct / 100));
  }
  /** 四舍五入到常见行权价间隔 */
  function roundStrike(strike, spot) {
    var step = spot >= 500 ? 10 : spot >= 200 ? 5 : spot >= 50 ? 2.5 : spot >= 20 ? 1 : 0.5;
    return Math.round(strike / step) * step;
  }

  var TEMPLATES = [
    {
      id: 'long_call', name: '买入看涨 Long Call', group: '方向性 · 看多',
      desc: '最基础的看多杠杆工具。风险有限（权利金），盈利理论上无限。',
      dir: 'bull', legs: 1,
      build: function (c) {
        return [{ kind: 'call', side: 1, strike: roundStrike(strikeByOffset(c.spot, c.widthPct || 0), c.spot), dte: c.dte, qty: c.qty || 1 }];
      }
    },
    {
      id: 'long_put', name: '买入看跌 Long Put', group: '方向性 · 看空',
      desc: '看空杠杆工具。风险有限，盈利上限为行权价（标的归零）。',
      dir: 'bear', legs: 1,
      build: function (c) {
        return [{ kind: 'put', side: 1, strike: roundStrike(strikeByOffset(c.spot, c.widthPct || 0), c.spot), dte: c.dte, qty: c.qty || 1 }];
      }
    },
    {
      id: 'leaps_call', name: 'LEAPS 长期看涨', group: '方向性 · 看多',
      desc: '股票替代品（Stock Replacement）。高 Delta、低时间价值损耗，资金效率优于持股。',
      dir: 'bull', legs: 1,
      build: function (c) {
        return [{ kind: 'call', side: 1, strike: roundStrike(strikeByOffset(c.spot, -20), c.spot), dte: c.dte || 550, qty: c.qty || 1 }];
      }
    },
    {
      id: 'covered_call', name: '备兑看涨 Covered Call', group: '增收 · 中性偏多',
      desc: '持股同时卖出 Call 收取权利金，降低持仓成本，但放弃上方超额收益。',
      dir: 'neutral', legs: 2,
      build: function (c) {
        var n = c.qty || 1;
        return [
          { kind: 'stock', side: 1, qty: n * 100, price: c.spot, dte: c.dte },
          { kind: 'call', side: -1, strike: roundStrike(strikeByOffset(c.spot, c.widthPct || 5), c.spot), dte: c.dte, qty: n }
        ];
      }
    },
    {
      id: 'csp', name: '现金担保看跌 Cash Secured Put', group: '增收 · 中性偏多',
      desc: '卖出 Put 收权利金；若被指派则以净成本（行权价−权利金）接货。',
      dir: 'neutral', legs: 1,
      build: function (c) {
        return [{ kind: 'put', side: -1, strike: roundStrike(strikeByOffset(c.spot, -(c.widthPct || 5)), c.spot), dte: c.dte, qty: c.qty || 1 }];
      }
    },
    {
      id: 'pmcc', name: '穷人版备兑 PMCC', group: '增收 · 中性偏多',
      desc: '用长期 LEAPS Call 替代持股，再卖短期 Call 收租。资金占用远低于备兑。',
      dir: 'bull', legs: 2,
      build: function (c) {
        var n = c.qty || 1;
        return [
          { kind: 'call', side: 1, strike: roundStrike(strikeByOffset(c.spot, -25), c.spot), dte: (c.dte2 || 550), qty: n },
          { kind: 'call', side: -1, strike: roundStrike(strikeByOffset(c.spot, c.widthPct || 7), c.spot), dte: c.dte, qty: n }
        ];
      }
    },
    {
      id: 'protective_put', name: '保护性看跌 Protective Put', group: '对冲',
      desc: '持股 + 买入 Put，为持仓设定亏损下限（保险）。',
      dir: 'bull', legs: 2,
      build: function (c) {
        var n = c.qty || 1;
        return [
          { kind: 'stock', side: 1, qty: n * 100, price: c.spot, dte: c.dte },
          { kind: 'put', side: 1, strike: roundStrike(strikeByOffset(c.spot, -(c.widthPct || 5)), c.spot), dte: c.dte, qty: n }
        ];
      }
    },
    {
      id: 'collar', name: '领口策略 Collar', group: '对冲',
      desc: '持股 + 买 Put 保护 + 卖 Call 抵消成本。零成本或低成本锁定区间。',
      dir: 'neutral', legs: 3,
      build: function (c) {
        var n = c.qty || 1, w = c.widthPct || 5;
        return [
          { kind: 'stock', side: 1, qty: n * 100, price: c.spot, dte: c.dte },
          { kind: 'put', side: 1, strike: roundStrike(strikeByOffset(c.spot, -w), c.spot), dte: c.dte, qty: n },
          { kind: 'call', side: -1, strike: roundStrike(strikeByOffset(c.spot, w), c.spot), dte: c.dte, qty: n }
        ];
      }
    },
    {
      id: 'bull_call_spread', name: '牛市看涨价差 Bull Call Spread', group: '价差 · 看多',
      desc: '买低行权价 Call + 卖高行权价 Call。降低成本，同时封顶盈利。',
      dir: 'bull', legs: 2,
      build: function (c) {
        var n = c.qty || 1, w = c.widthPct || 5;
        return [
          { kind: 'call', side: 1, strike: roundStrike(strikeByOffset(c.spot, 0), c.spot), dte: c.dte, qty: n },
          { kind: 'call', side: -1, strike: roundStrike(strikeByOffset(c.spot, w), c.spot), dte: c.dte, qty: n }
        ];
      }
    },
    {
      id: 'bear_put_spread', name: '熊市看跌价差 Bear Put Spread', group: '价差 · 看空',
      desc: '买高行权价 Put + 卖低行权价 Put。风险与收益均有限。',
      dir: 'bear', legs: 2,
      build: function (c) {
        var n = c.qty || 1, w = c.widthPct || 5;
        return [
          { kind: 'put', side: 1, strike: roundStrike(strikeByOffset(c.spot, 0), c.spot), dte: c.dte, qty: n },
          { kind: 'put', side: -1, strike: roundStrike(strikeByOffset(c.spot, -w), c.spot), dte: c.dte, qty: n }
        ];
      }
    },
    {
      id: 'bull_put_spread', name: '牛市看跌价差 Bull Put Spread', group: '增收 · 看多',
      desc: '卖出较高行权价 Put + 买入更低行权价 Put 保护。净收权利金，风险有限。',
      dir: 'bull', legs: 2,
      build: function (c) {
        var n = c.qty || 1, w = c.widthPct || 5;
        return [
          { kind: 'put', side: -1, strike: roundStrike(strikeByOffset(c.spot, -2), c.spot), dte: c.dte, qty: n },
          { kind: 'put', side: 1, strike: roundStrike(strikeByOffset(c.spot, -2 - w), c.spot), dte: c.dte, qty: n }
        ];
      }
    },
    {
      id: 'bear_call_spread', name: '熊市看涨价差 Bear Call Spread', group: '增收 · 看空',
      desc: '卖出较低行权价 Call + 买入更高行权价 Call 保护。净收权利金，风险有限。',
      dir: 'bear', legs: 2,
      build: function (c) {
        var n = c.qty || 1, w = c.widthPct || 5;
        return [
          { kind: 'call', side: -1, strike: roundStrike(strikeByOffset(c.spot, 2), c.spot), dte: c.dte, qty: n },
          { kind: 'call', side: 1, strike: roundStrike(strikeByOffset(c.spot, 2 + w), c.spot), dte: c.dte, qty: n }
        ];
      }
    },
    {
      id: 'long_straddle', name: '买入跨式 Long Straddle', group: '波动率 · 买',
      desc: '同时买入同行权价 Call 与 Put。押注大幅波动，方向不限。',
      dir: 'neutral', legs: 2,
      build: function (c) {
        var n = c.qty || 1, K = roundStrike(c.spot, c.spot);
        return [
          { kind: 'call', side: 1, strike: K, dte: c.dte, qty: n },
          { kind: 'put', side: 1, strike: K, dte: c.dte, qty: n }
        ];
      }
    },
    {
      id: 'short_straddle', name: '卖出跨式 Short Straddle', group: '波动率 · 卖',
      desc: '同时卖出同行权价 Call 与 Put。押注价格不动，风险无限（裸腿）。',
      dir: 'neutral', legs: 2,
      build: function (c) {
        var n = c.qty || 1, K = roundStrike(c.spot, c.spot);
        return [
          { kind: 'call', side: -1, strike: K, dte: c.dte, qty: n },
          { kind: 'put', side: -1, strike: K, dte: c.dte, qty: n }
        ];
      }
    },
    {
      id: 'long_strangle', name: '买入宽跨式 Long Strangle', group: '波动率 · 买',
      desc: '买入 OTM 的 Call 与 Put。成本低于跨式，但需要更大波动才盈利。',
      dir: 'neutral', legs: 2,
      build: function (c) {
        var n = c.qty || 1, w = c.widthPct || 5;
        return [
          { kind: 'call', side: 1, strike: roundStrike(strikeByOffset(c.spot, w), c.spot), dte: c.dte, qty: n },
          { kind: 'put', side: 1, strike: roundStrike(strikeByOffset(c.spot, -w), c.spot), dte: c.dte, qty: n }
        ];
      }
    },
    {
      id: 'short_strangle', name: '卖出宽跨式 Short Strangle', group: '波动率 · 卖',
      desc: '卖出 OTM 的 Call 与 Put。盈利区间更宽，但两端风险无限。',
      dir: 'neutral', legs: 2,
      build: function (c) {
        var n = c.qty || 1, w = c.widthPct || 5;
        return [
          { kind: 'call', side: -1, strike: roundStrike(strikeByOffset(c.spot, w), c.spot), dte: c.dte, qty: n },
          { kind: 'put', side: -1, strike: roundStrike(strikeByOffset(c.spot, -w), c.spot), dte: c.dte, qty: n }
        ];
      }
    },
    {
      id: 'iron_condor', name: '铁鹰式 Iron Condor', group: '波动率 · 卖',
      desc: '卖宽跨 + 买更远双腿保护。四腿结构，风险收益均有限，典型的低波动收割策略。',
      dir: 'neutral', legs: 4,
      build: function (c) {
        var n = c.qty || 1, w = c.widthPct || 5, wing = c.wingPct || 5;
        return [
          { kind: 'put', side: 1, strike: roundStrike(strikeByOffset(c.spot, -w - wing), c.spot), dte: c.dte, qty: n },
          { kind: 'put', side: -1, strike: roundStrike(strikeByOffset(c.spot, -w), c.spot), dte: c.dte, qty: n },
          { kind: 'call', side: -1, strike: roundStrike(strikeByOffset(c.spot, w), c.spot), dte: c.dte, qty: n },
          { kind: 'call', side: 1, strike: roundStrike(strikeByOffset(c.spot, w + wing), c.spot), dte: c.dte, qty: n }
        ];
      }
    },
    {
      id: 'iron_butterfly', name: '铁蝶式 Iron Butterfly', group: '波动率 · 卖',
      desc: 'ATM 卖跨 + 双侧买保护。盈利区间窄但权利金高，要求标的几乎不动。',
      dir: 'neutral', legs: 4,
      build: function (c) {
        var n = c.qty || 1, w = c.widthPct || 5, K = roundStrike(c.spot, c.spot);
        return [
          { kind: 'put', side: 1, strike: roundStrike(strikeByOffset(c.spot, -w), c.spot), dte: c.dte, qty: n },
          { kind: 'put', side: -1, strike: K, dte: c.dte, qty: n },
          { kind: 'call', side: -1, strike: K, dte: c.dte, qty: n },
          { kind: 'call', side: 1, strike: roundStrike(strikeByOffset(c.spot, w), c.spot), dte: c.dte, qty: n }
        ];
      }
    },
    {
      id: 'long_butterfly', name: '买入蝶式 Long Butterfly', group: '波动率 · 买',
      desc: '1:2:1 的价差组合。成本极低，押注标的停在中间行权价附近。',
      dir: 'neutral', legs: 3,
      build: function (c) {
        var n = c.qty || 1, w = c.widthPct || 5;
        return [
          { kind: 'call', side: 1, strike: roundStrike(strikeByOffset(c.spot, -w), c.spot), dte: c.dte, qty: n },
          { kind: 'call', side: -1, strike: roundStrike(c.spot, c.spot), dte: c.dte, qty: 2 * n },
          { kind: 'call', side: 1, strike: roundStrike(strikeByOffset(c.spot, w), c.spot), dte: c.dte, qty: n }
        ];
      }
    },
    {
      id: 'calendar_call', name: '日历价差 Calendar Call', group: '日历 / 对角',
      desc: '卖近期 Call + 买远期同行权价 Call。赚取近月更快的 Theta 衰减，押注 IV 上升。',
      dir: 'neutral', legs: 2,
      build: function (c) {
        var n = c.qty || 1, K = roundStrike(strikeByOffset(c.spot, c.widthPct || 0), c.spot);
        return [
          { kind: 'call', side: -1, strike: K, dte: c.dte, qty: n },
          { kind: 'call', side: 1, strike: K, dte: (c.dte2 || c.dte * 2), qty: n }
        ];
      }
    },
    {
      id: 'calendar_put', name: '日历价差 Calendar Put', group: '日历 / 对角',
      desc: '卖近期 Put + 买远期同行权价 Put。',
      dir: 'neutral', legs: 2,
      build: function (c) {
        var n = c.qty || 1, K = roundStrike(strikeByOffset(c.spot, c.widthPct || 0), c.spot);
        return [
          { kind: 'put', side: -1, strike: K, dte: c.dte, qty: n },
          { kind: 'put', side: 1, strike: K, dte: (c.dte2 || c.dte * 2), qty: n }
        ];
      }
    },
    {
      id: 'diagonal_call', name: '对角价差 Diagonal Call', group: '日历 / 对角',
      desc: '买远期低行权价 Call + 卖近期高行权价 Call。兼具方向性与收租。',
      dir: 'bull', legs: 2,
      build: function (c) {
        var n = c.qty || 1;
        return [
          { kind: 'call', side: 1, strike: roundStrike(strikeByOffset(c.spot, -10), c.spot), dte: (c.dte2 || 400), qty: n },
          { kind: 'call', side: -1, strike: roundStrike(strikeByOffset(c.spot, c.widthPct || 5), c.spot), dte: c.dte, qty: n }
        ];
      }
    },
    {
      id: 'ratio_backspread_call', name: '看涨比例反向价差 Ratio Backspread', group: '波动率 · 买',
      desc: '卖 1 张近 ATM Call + 买 2 张更远 OTM Call。下跌小赚，大涨大赚。',
      dir: 'bull', legs: 2,
      build: function (c) {
        var n = c.qty || 1, w = c.widthPct || 5;
        return [
          { kind: 'call', side: -1, strike: roundStrike(strikeByOffset(c.spot, 0), c.spot), dte: c.dte, qty: n },
          { kind: 'call', side: 1, strike: roundStrike(strikeByOffset(c.spot, w), c.spot), dte: c.dte, qty: 2 * n }
        ];
      }
    },
    {
      id: 'ratio_backspread_put', name: '看跌比例反向价差 Ratio Backspread', group: '波动率 · 买',
      desc: '卖 1 张近 ATM Put + 买 2 张更远 OTM Put。上涨小赚，大跌大赚。',
      dir: 'bear', legs: 2,
      build: function (c) {
        var n = c.qty || 1, w = c.widthPct || 5;
        return [
          { kind: 'put', side: -1, strike: roundStrike(strikeByOffset(c.spot, 0), c.spot), dte: c.dte, qty: n },
          { kind: 'put', side: 1, strike: roundStrike(strikeByOffset(c.spot, -w), c.spot), dte: c.dte, qty: 2 * n }
        ];
      }
    },
    {
      id: 'jade_lizard', name: '翡翠蜥蜴 Jade Lizard', group: '增收 · 进阶',
      desc: '卖 OTM Put + 卖 OTM Call + 买更远 Call 保护。上方风险有限，且无下方指派风险保护缺口由 Put 端权利金补足。',
      dir: 'neutral', legs: 3,
      build: function (c) {
        var n = c.qty || 1, w = c.widthPct || 5, wing = c.wingPct || 5;
        return [
          { kind: 'put', side: -1, strike: roundStrike(strikeByOffset(c.spot, -w), c.spot), dte: c.dte, qty: n },
          { kind: 'call', side: -1, strike: roundStrike(strikeByOffset(c.spot, w), c.spot), dte: c.dte, qty: n },
          { kind: 'call', side: 1, strike: roundStrike(strikeByOffset(c.spot, w + wing), c.spot), dte: c.dte, qty: n }
        ];
      }
    }
  ];

  var TEMPLATE_MAP = {};
  TEMPLATES.forEach(function (t) { TEMPLATE_MAP[t.id] = t; });

  /** 生成模板腿，并自动用定价引擎补上理论价与 IV */
  function buildTemplate(id, ctx) {
    var t = TEMPLATE_MAP[id];
    if (!t) return null;
    var raw = t.build(ctx);
    var r = E.finite(ctx.rate) ? ctx.rate : 0.043;
    var q = E.finite(ctx.dividend) ? ctx.dividend : 0;
    var iv = E.finite(ctx.iv) ? ctx.iv : 0.30;
    return raw.map(function (l) {
      var leg = makeLeg(Object.assign({ iv: iv }, l));
      if (leg.kind === 'stock') { leg.price = ctx.spot; leg.iv = null; return leg; }
      // 用统一 IV 计算理论价作为默认入场价（保留到美分）
      leg.price = Math.round(E.bsPrice(leg.kind, ctx.spot, leg.strike, leg.dte / DAYS, iv, r, q) * 100) / 100;
      // 若有期权链，优先用真实报价（中间价）
      if (ctx.chain && typeof ctx.chain === 'function') {
        var real = ctx.chain(leg.kind, leg.strike, leg.dte);
        if (real && E.finite(real.price) && real.price > 0) {
          leg.price = real.price;
          if (E.finite(real.iv)) leg.iv = real.iv;
          leg.bid = real.bid; leg.ask = real.ask; leg.oi = real.oi; leg.volume = real.volume;
        }
      }
      return leg;
    });
  }

  /* ===========================================================================
   * 结构评分（源自原站的评分理念，但扩展到任意多腿组合）
   * ======================================================================== */
  function scoreStructure(legs, spot, opts) {
    opts = opts || {};
    var prof = riskProfile(legs, spot, opts);
    var greeks = positionGreeks(legs, spot, opts.rate, opts.dividend);
    var prob = probabilityAnalysis(legs, spot, opts);
    if (!prof) return null;
    var comps = [];

    // 1) 风险回报比
    var rr = prof.riskReward;
    comps.push({
      key: 'rr', name: '风险回报比', weight: 22,
      value: rr, display: rr === null ? (prof.unlimitedProfit ? '∞' : '—') : rr.toFixed(2),
      tier: rr === null ? (prof.unlimitedProfit ? 'green' : 'yellow') : rr >= 2 ? 'green' : rr >= 1 ? 'yellow' : 'red',
      note: rr === null ? '无限盈利，无法计算固定比值' : '每承担 1 元风险可换取 ' + rr.toFixed(2) + ' 元回报'
    });

    // 2) 盈利概率
    var pop = prob ? prob.pop : null;
    comps.push({
      key: 'pop', name: '盈利概率 POP', weight: 20,
      value: pop, display: pop === null ? '—' : (pop * 100).toFixed(1) + '%',
      tier: pop === null ? null : pop >= 0.65 ? 'green' : pop >= 0.5 ? 'yellow' : 'red',
      note: '风险中性测度下到期盈利的概率'
    });

    // 3) Theta 效率：每日时间价值收益占最大风险的比重
    var thetaPerRisk = (E.finite(greeks.theta) && prof.maxLoss !== null && prof.maxLoss < 0)
      ? greeks.theta / Math.abs(prof.maxLoss) * 100 : null;
    comps.push({
      key: 'theta', name: 'Theta 效率', weight: 14,
      value: thetaPerRisk, display: thetaPerRisk === null ? '—' : thetaPerRisk.toFixed(3) + '%/天',
      tier: thetaPerRisk === null ? null : thetaPerRisk >= 0.5 ? 'green' : thetaPerRisk >= 0 ? 'yellow' : 'red',
      note: E.finite(greeks.theta) ? '每日时间价值收益 $' + greeks.theta.toFixed(2) + (greeks.theta >= 0 ? '（收取）' : '（支付）') : '—'
    });

    // 4) Vega 敞口：IV 变动 1pt 带来的盈亏占最大风险比
    var vegaPerRisk = (E.finite(greeks.vega) && prof.maxLoss !== null && prof.maxLoss < 0)
      ? Math.abs(greeks.vega) / Math.abs(prof.maxLoss) * 100 : null;
    comps.push({
      key: 'vega', name: 'Vega 敞口', weight: 12,
      value: vegaPerRisk, display: vegaPerRisk === null ? '—' : vegaPerRisk.toFixed(2) + '%/1pt',
      tier: vegaPerRisk === null ? null : vegaPerRisk <= 3 ? 'green' : vegaPerRisk <= 8 ? 'yellow' : 'red',
      note: E.finite(greeks.vega) ? 'IV 每变动 1 个点，盈亏变动 $' + greeks.vega.toFixed(2) : '—'
    });

    // 5) 资金效率：最大盈利 / 占用资金 / 年化
    var eff = null;
    if (prof.maxProfit !== null && prof.capital > 0) {
      var dte = legs.reduce(function (m, l) { return Math.max(m, l.dte); }, 0);
      eff = E.annualizedROI(prof.maxProfit, prof.capital, dte);
    }
    comps.push({
      key: 'eff', name: '资金效率(年化)', weight: 16,
      value: eff, display: eff === null ? '—' : eff.toFixed(1) + '%',
      tier: eff === null ? null : eff >= 30 ? 'green' : eff >= 12 ? 'yellow' : 'red',
      note: prof.capital > 0 ? '占用资金约 $' + prof.capital.toFixed(0) : '—'
    });

    // 6) Gamma 风险（卖方策略的主要尾部风险）
    var gammaRisk = Math.abs(greeks.gamma) * spot * 0.01; // 1% 波动带来的 Delta 变化（股当量）
    comps.push({
      key: 'gamma', name: 'Gamma 敞口', weight: 10,
      value: gammaRisk, display: gammaRisk.toFixed(2) + ' Δ/1%',
      tier: gammaRisk <= 5 ? 'green' : gammaRisk <= 20 ? 'yellow' : 'red',
      note: '标的每波动 1%，组合 Delta 变化 ' + gammaRisk.toFixed(2) + ' 股当量'
    });

    // 7) 盈利区间宽度（占现价百分比）
    var widthPct = null;
    if (prof.breakevens.length >= 2) {
      widthPct = (prof.breakevens[prof.breakevens.length - 1] - prof.breakevens[0]) / spot * 100;
    } else if (prof.breakevens.length === 1) {
      widthPct = (prof.unlimitedProfit ? 999 : Math.abs(prof.breakevens[0] - spot) / spot * 100);
    }
    comps.push({
      key: 'width', name: '盈利区间宽度', weight: 6,
      value: widthPct, display: widthPct === null ? '—' : (widthPct > 900 ? '半开放' : widthPct.toFixed(1) + '%'),
      tier: widthPct === null ? null : widthPct >= 15 ? 'green' : widthPct >= 8 ? 'yellow' : 'red',
      note: '标的需要维持在多大范围内才能盈利'
    });

    var tierScore = { green: 100, yellow: 60, red: 20 };
    var active = comps.filter(function (c) { return c.tier !== null; });
    var den = active.reduce(function (s, c) { return s + c.weight; }, 0);
    var score = den ? active.reduce(function (s, c) { return s + tierScore[c.tier] * c.weight; }, 0) / den : 0;
    var tier = score >= 80 ? 'green' : score >= 60 ? 'yellow' : 'red';
    var label = score >= 80 ? '结构较扎实' : score >= 60 ? '可用，但有明显取舍' : '结构偏脆弱';

    return {
      score: score, tier: tier, label: label, components: comps,
      profile: prof, greeks: greeks, probability: prob
    };
  }

  /* ===========================================================================
   * 导出
   * ======================================================================== */
  return {
    MULT: MULT,
    makeLeg: makeLeg, legMult: legMult,
    legValue: legValue, positionValue: positionValue, netPremium: netPremium,
    positionGreeks: positionGreeks, legDelta: legDelta,
    payoffCurve: payoffCurve, breakevens: breakevens, riskProfile: riskProfile,
    upSlope: upSlope, valueAtZero: valueAtZero,
    capitalRequirement: capitalRequirement,
    probabilityAnalysis: probabilityAnalysis, weightedIV: weightedIV,
    timeSlices: timeSlices, matrix: matrix,
    TEMPLATES: TEMPLATES, TEMPLATE_MAP: TEMPLATE_MAP, buildTemplate: buildTemplate,
    roundStrike: roundStrike, scoreStructure: scoreStructure,
    formatMetric: formatMetric
  };
});
