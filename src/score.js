/*!
 * score.js —— 每日掃描嘅量化評分引擎
 *
 * 設計原則：數學一律復用 engine.js（已通過 54 項單元測試，含蒙地卡洛交叉驗証），
 * 呢度只做「指標 → 分類 → 加權評分 → 結構建議」，唔重寫任何定價／IV／HV 公式。
 *
 * 可以用兩種方式跑：
 *   node src/score.js <raw.json> <out.json>      （scan.py 用）
 *   root.OptionScore                              （瀏覽器用，UMD）
 */
(function (root, factory) {
  var E = (typeof module === 'object' && module.exports) ? require('./engine.js') : root.OptionEngine;
  var api = factory(E);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OptionScore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E) {

  var RATE_DEFAULT = 0.04;
  // 只分析現價 ±35% 內嘅行權價：再遠嘅 IV 唔可靠又嘥時間
  var STRIKE_WINDOW = 0.35;
  // 最多分析幾個到期日（由近排到遠），夠砌期限結構就得
  var MAX_EXPIRIES = 7;

  /* ==========================================================================
   * 標籤定義
   * ======================================================================== */
  var TAGS = {
    SELL_PREMIUM: { key: 'SELL_PREMIUM', label: '卖方收租', short: '卖', color: '#ef6c4d',
      desc: 'IV 显著高于已实现波动率且 IV Rank 偏高 → 卖 premium 收 theta' },
    BUY_VOL:      { key: 'BUY_VOL',      label: '买方爆发', short: '买', color: '#059669',
      desc: 'IV 被低估、动能在积聚 → 买 straddle / debit spread 赌波动放大' },
    EARNINGS:     { key: 'EARNINGS',     label: '财报事件', short: '财', color: '#7c3aed',
      desc: '到期日跨越财报 → IV crush 与跳空机会并存，需特别处理' },
    RANGE:        { key: 'RANGE',        label: '中性震荡', short: '震', color: '#0891b2',
      desc: 'IV≈HV、短期波动收敛、无催化剂 → 区间震荡，适合铁鹰/蝶式' },
    NEUTRAL:      { key: 'NEUTRAL',      label: '暂无信号', short: '—', color: '#94a3b8',
      desc: '各项指标均未触发明确方向 → 今日不勉强，等信号出现再出手' },
    SQUEEZE_FLOW: { key: 'SQUEEZE_FLOW', label: '轧空异动', short: '轧', color: '#d97706',
      desc: '空头拥挤 + call 未平仓量异常集中 → 方向性做多，禁止裸卖' },
    AVOID:        { key: 'AVOID',        label: '回避',     short: '避', color: '#9ca3af',
      desc: '流动性/可辨识性不达标 → 不要碰' }
  };

  // 優先序：越前越優先（AVOID 最優先）。
  // EARNINGS 排最後係刻意嘅：財報季前後幾乎所有 30–45 天到期都會跨財報，
  // 若排最前會令七成池冚唪唥變「财报事件」冇辨別度。跨財報係「警告」而唔係「策略」，
  // 所以主標籤由收租/買方/震盪話事，跨財報留喺 tags 做 ⚠ 徽章。
  // 真正臨近財報（≤10 天）嘅標的唔會過到 SELL_PREMIUM/RANGE（earnSafe=false），自然落到 EARNINGS。
  var PRIORITY = ['AVOID', 'SQUEEZE_FLOW', 'BUY_VOL', 'SELL_PREMIUM', 'RANGE', 'EARNINGS'];

  /* ==========================================================================
   * 小工具
   * ======================================================================== */
  function fin(v) { return E.finite(v); }
  function cl(v, lo, hi) { return E.clamp(v, lo, hi); }
  function map(v, lo, hi) { return fin(v) ? cl((v - lo) / (hi - lo), 0, 1) : 0; }

  /** P5/P95 winsorize 後線性映射 */
  function norm(x, lo, hi) { return map(x, lo, hi); }

  /** 一組數字嘅百分位（0-1）。value 喺 pool 入面排幾高。 */
  function pctRank(pool, value) {
    if (!pool.length || !fin(value)) return 0.5;
    var below = 0;
    for (var i = 0; i < pool.length; i++) if (pool[i] < value) below++;
    return below / pool.length;
  }

  function winsorize(arr) {
    var a = arr.filter(fin).slice().sort(function (x, y) { return x - y; });
    if (a.length < 5) return a;
    var lo = a[Math.floor(a.length * 0.05)], hi = a[Math.floor(a.length * 0.95)];
    return arr.map(function (v) { return fin(v) ? Math.min(Math.max(v, lo), hi) : v; });
  }

  function daysBetween(dateStr, fromDate) {
    if (!dateStr) return null;
    var a = Date.parse(dateStr + 'T00:00:00Z');
    var b = fromDate ? fromDate.getTime() : Date.now();
    if (!isFinite(a)) return null;
    return Math.round((a - b) / 86400000);
  }

  /* ==========================================================================
   * 1. 由期權鏈抽出可辨識嘅 IV 曲面
   * ======================================================================== */
  /**
   * 對單一到期日計：ATM IV、25Δ put/call IV、流動性、OI 集中度。
   * 硬性規則：只用 0.15 ≤ |Δ| ≤ 0.85 嘅合約；vega/S < 0.001 或時間值 < 5% mid 丟棄。
   */
  function analyseExpiry(chain, S, T, r, q) {
    var out = { dte: Math.round(T * 365), T: T, expiry: chain.expiry,
      atm: null, iv25call: null, iv25put: null,
      contracts: 0, dropped: 0, oiTotal: 0, volTotal: 0,
      atmOi: 0, atmSpreadPct: null, topStrikeShare: 0, pinStrike: null,
      callOi: 0, putOi: 0, rows: [] };

    // 價外太遠嘅行權價 IV 唔可靠又嘥時間，先按 moneyness 篩一輪
    var loK = S * (1 - STRIKE_WINDOW), hiK = S * (1 + STRIKE_WINDOW);

    var rows = [], surfRows = [];
    ['calls', 'puts'].forEach(function (side) {
      var kind = side === 'calls' ? 'call' : 'put';
      (chain[side] || []).forEach(function (o) {
        var K = o.strike;
        if (!fin(K) || K <= 0) return;
        if (K < loK || K > hiK) return;
        var bid = fin(o.bid) ? o.bid : null, ask = fin(o.ask) ? o.ask : null;
        var last = fin(o.last) ? o.last : null;
        // 盤中 last 可能係陳舊價，一律用 mid
        var mid = (bid != null && ask != null && ask >= bid) ? (bid + ask) / 2
          : (last != null ? last : null);
        if (!(mid > 0)) { out.dropped++; return; }
        if (bid === 0 && ask === 0) { out.dropped++; return; }

        // IV 曲面用歐式反解：OTM 合約提前行權溢價≈0，歐美差異可忽略，
        // 但二元樹會令每次 Newton 迭代慢一個數量級（實測 12 檔評分 152s → 目標 <20s）
        var ex = E.impliedVolEx(kind, mid, S, K, T, r, q, false);
        if (!(ex && fin(ex.iv) && ex.identifiable)) { out.dropped++; return; }
        var iv = ex.iv;
        var g = E.greeks(kind, S, K, T, iv, r, q);
        var theo = E.bsPrice(kind, S, K, T, iv, r, q);
        var timeVal = mid - E.intrinsic(kind, S, K);

        // 可辨識性二次把關。
        // 關鍵唔係「Vega 有幾大」，而係「Vega 相對買賣差有幾大」：
        // 若 (ask−bid)/vega > 3，代表 IV 嘅不確定區間超過 3 個波動點，反解出嚟嘅 IV 冇意義。
        var vegaPP = Math.abs(g.vega);              // engine 嘅 vega 係「每 1 個百分點」
        if (vegaPP < 0.01) { out.dropped++; return; }        // 少過 1 仙 / vol point
        if (bid != null && ask != null && ask > bid && vegaPP > 0 &&
            (ask - bid) / vegaPP > 3) { out.dropped++; return; }
        if (timeVal < 0.05 * mid) { out.dropped++; return; }

        var ad = Math.abs(g.delta);
        // IV 曲面只信 0.15–0.85；再外面嘅留畀「揀行權價」（例如鐵鷹嘅 5Δ 翅膀），
        // 嗰度只係要 strike 同權利金，唔係要精確 IV
        var surf = ad >= 0.15 && ad <= 0.85;
        if (ad < 0.05 || ad > 0.95) { out.dropped++; return; }

        var row = { kind: kind, K: K, mid: mid, bid: bid, ask: ask, iv: iv,
          delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega,
          theo: theo, oi: o.openInterest || 0, vol: o.volume || 0,
          // 統一用「百分比」（6 代表 6%），唔好喺一個位用分數另一個位用百分比
          spreadPct: (bid != null && ask != null && mid > 0) ? (ask - bid) / mid * 100 : null,
          absDelta: ad, surface: surf };
        rows.push(row);
        if (surf) surfRows.push(row);
      });
    });

    out.contracts = surfRows.length;
    out.rows = rows;
    out.surfRows = surfRows;
    if (!surfRows.length) return out;

    out.oiTotal = rows.reduce(function (a, b) { return a + b.oi; }, 0);
    out.volTotal = rows.reduce(function (a, b) { return a + b.vol; }, 0);

    // ATM：|K-S| 最小（用 surfRows，要可靠 IV）
    var atm = null, bd = Infinity;
    surfRows.forEach(function (x) {
      var d = Math.abs(x.K - S);
      if (d < bd) { bd = d; atm = x; }
    });
    out.atm = atm;
    if (atm) {
      out.atmSpreadPct = atm.spreadPct;
      // ATM±5 檔 OI（用全部 rows，OI 係實際數據唔使 IV 可靠）。
      // 用 ±5 而唔係 ±3：高價股（如 AMD $623）行權價間隔大，±3 檔覆蓋太窄會低估流動性。
      var near = rows.filter(function (x) { return Math.abs(x.K - S) <= Math.abs(atm.K - S) + 5 * strikeStep(rows); });
      out.atmOi = near.reduce(function (a, b) { return a + b.oi; }, 0);
    }

    // 25Δ：call 搵 delta≈0.25，put 搵 delta≈-0.25
    var c25 = closest(surfRows.filter(function (x) { return x.kind === 'call'; }), 0.25);
    var p25 = closest(surfRows.filter(function (x) { return x.kind === 'put'; }), 0.25);
    out.iv25call = c25 ? c25.iv : null;
    out.iv25put = p25 ? p25.iv : null;

    // OI 集中度（唔分 call/put，計同一 strike 嘅總 OI 佔比）
    var byK = {};
    rows.forEach(function (x) { byK[x.K] = (byK[x.K] || 0) + x.oi; });
    var topK = null, topV = -1;
    Object.keys(byK).forEach(function (k) { if (byK[k] > topV) { topV = byK[k]; topK = +k; } });
    if (out.oiTotal > 0 && topK != null) {
      out.topStrikeShare = topV / out.oiTotal;
      out.pinStrike = topK;
    }
    out.callOi = rows.filter(function (x) { return x.kind === 'call'; })
      .reduce(function (a, b) { return a + b.oi; }, 0);
    out.putOi = rows.filter(function (x) { return x.kind === 'put'; })
      .reduce(function (a, b) { return a + b.oi; }, 0);

    return out;
  }

  function closest(rows, target) {
    if (!rows.length) return null;
    var best = null, bd = Infinity;
    rows.forEach(function (x) {
      var d = Math.abs(x.absDelta - target);
      if (d < bd) { bd = d; best = x; }
    });
    return best;
  }

  function strikeStep(rows) {
    var ks = rows.map(function (x) { return x.K; }).sort(function (a, b) { return a - b; });
    if (ks.length < 2) return 1;
    var step = ks[1] - ks[0];
    return step > 0 ? step : 1;
  }

  /** 由各到期日 ATM IV 線性插值出 IV30；並計 IV_180（最長到期日）做期限結構 */
  function buildIVCurve(exps, S) {
    var pts = exps.filter(function (e) { return e.atm && fin(e.atm.iv); })
      .map(function (e) { return { dte: Math.max(e.T * 365, 0.5), iv: e.atm.iv }; })
      .sort(function (a, b) { return a.dte - b.dte; });
    if (!pts.length) return { iv30: null, ivFar: null, ts: null, span: null, points: [] };

    function interp(target) {
      if (pts.length === 1) return pts[0].iv;
      if (target <= pts[0].dte) return pts[0].iv;
      if (target >= pts[pts.length - 1].dte) return pts[pts.length - 1].iv;
      for (var i = 0; i < pts.length - 1; i++) {
        if (pts[i].dte <= target && target <= pts[i + 1].dte) {
          var w = (target - pts[i].dte) / (pts[i + 1].dte - pts[i].dte);
          return pts[i].iv * (1 - w) + pts[i + 1].iv * w;
        }
      }
      return pts[pts.length - 1].iv;
    }

    var iv30 = interp(30);
    var farDte = pts[pts.length - 1].dte;
    var ivFar = pts[pts.length - 1].iv;
    return {
      iv30: iv30,
      ivFar: ivFar,
      ts: (fin(iv30) && fin(ivFar) && ivFar > 0) ? iv30 / ivFar : null,
      farDte: farDte,
      // 插值跨度：>15 天代表 30 天位置係外推出嚟，信心較低
      span: (pts.length > 1) ? Math.min(Math.abs(pts[0].dte - 30), Math.abs(pts[pts.length - 1].dte - 30)) : null,
      points: pts
    };
  }

  /* ==========================================================================
   * 2. 硬性門檻
   * ======================================================================== */
  var LIMITS = {
    priceMin: 8, priceMax: 800,      // 2026 年 AMD 已過 $600，上限緊嘅話會誤剔大票
    // 12%：每日扫描用嘅系收市后数据，买卖差必然拉阔。实测 BAC 8.6% / XOM 11.8% 都系
    // 正常大股，用 6% 会误剔一大堆。阔价差自然会被 liq 评分维度扣分，唔使硬剔。
    // 真正垃圾嘅（WBD 66.7% / V 13.1%）依然过唔到。
    spreadPctMax: 12,       // %
    midMin: 0.35,
    // 500 而唔系 1500：ATM OI 会因为「主到期日啱啱冇成交」而偏低，但唔代表成档唔做得
    // （实测 CSCO/JPM/CRM 被 1500 误剔）。流动性已经由 liq 评分维度处理，硬门槛只剔极端。
    atmOiMin: 500,
    strikesMin: 6,
    expiriesMin: 3,
    dteMin: 7, dteMax: 120,
    barsMin: 200            // 歷史日線最少根數（<252 扣分，<200 淘汰）
  };

  function hardFilter(rec, m) {
    var fail = [];
    if (!fin(m.price) || m.price < LIMITS.priceMin || m.price > LIMITS.priceMax)
      fail.push('股价不在 $%d–$%d'.replace('%d', LIMITS.priceMin).replace('%d', LIMITS.priceMax));
    if (!fin(m.iv30)) fail.push('IV 无法求解');
    if (!m.exps || m.exps.length < LIMITS.expiriesMin) fail.push('到期日不足 3 个');
    if (fin(m.strikes) && m.strikes < LIMITS.strikesMin)
      fail.push('主到期日可用行权价 ' + m.strikes + ' 个（需 ≥' + LIMITS.strikesMin + '，Δ0.15–0.85）');
    if (fin(m.atmSpreadPct) && m.atmSpreadPct > LIMITS.spreadPctMax)
      // 唔好用 '%.1f%%'.replace() —— replace 只换第一个，%% 会原样留低显示成「6.6%%」
      fail.push('ATM 价差 ' + m.atmSpreadPct.toFixed(1) + '% 过宽');
    if (fin(m.atmMid) && m.atmMid < LIMITS.midMin) fail.push('ATM 权利金低于 $0.35');
    if (fin(m.atmOi) && m.atmOi < LIMITS.atmOiMin)
      fail.push('ATM 附近 OI ' + Math.round(m.atmOi) + ' 不足 ' + LIMITS.atmOiMin);
    if (fin(m.bars) && m.bars < LIMITS.barsMin) fail.push('历史日线不足 200 根');
    return fail;
  }

  /* ==========================================================================
   * 3. 單檔指標計算
   * ======================================================================== */
  function buildMetrics(rec, opts) {
    opts = opts || {};
    var r = fin(opts.rate) ? opts.rate : RATE_DEFAULT;
    var q = rec.quote || {};
    var S = q.price;
    var m = { symbol: rec.symbol, name: q.name || null, price: S,
      change: q.change, changePct: q.changePct, sector: q.sector,
      marketCap: q.marketCap, missing: rec.missing || [] };

    if (!fin(S) || S <= 0) { m.fatal = '无股价'; return m; }
    m.dividend = 0;   // Nasdaq 冇穩定息率，保守用 0

    // ---- 歷史 ----
    var hist = rec.history || [];
    m.bars = hist.length;
    if (hist.length >= 3) {
      var c = [], h = [], l = [], o = [], v = [];
      hist.forEach(function (x) {
        if (!fin(x.close) || x.close <= 0) return;
        c.push(x.close); h.push(fin(x.high) ? x.high : x.close);
        l.push(fin(x.low) ? x.low : x.close); o.push(fin(x.open) ? x.open : x.close);
        v.push(x.volume || 0);
      });
      m.hv10 = E.hvCloseToClose(c, 10);
      m.hv20 = E.hvCloseToClose(c, 20);
      m.hv60 = E.hvCloseToClose(c, 60);
      m.hv252 = E.hvCloseToClose(c, 252);
      m.hvParkinson20 = E.hvParkinson(h, l, 20);
      m.hvGarman20 = E.hvGarmanKlass(o, h, l, c, 20);
      m.hvYZ20 = E.hvYangZhang(o, h, l, c, 20);
      // 混合：YZ 做主（對跳空穩健），Parkinson 補日內，CC 補收收
      var parts = [], ws = [];
      if (fin(m.hvYZ20)) { parts.push(m.hvYZ20); ws.push(0.5); }
      if (fin(m.hvParkinson20)) { parts.push(m.hvParkinson20); ws.push(0.3); }
      if (fin(m.hv20)) { parts.push(m.hv20); ws.push(0.2); }
      if (parts.length) {
        var sw = ws.reduce(function (a, b) { return a + b; }, 0);
        m.hvBlend = parts.reduce(function (a, b, i) { return a + b * ws[i]; }, 0) / sw;
      }
      // 動能 / ATR
      m.ret20 = c.length > 20 ? (c[c.length - 1] / c[c.length - 21] - 1) : null;
      m.ret5 = c.length > 5 ? (c[c.length - 1] / c[c.length - 6] - 1) : null;
      m.ma20 = c.length >= 20 ? c.slice(-20).reduce(function (a, b) { return a + b; }, 0) / 20 : null;
      var atr = 0, n = 0;
      for (var i = Math.max(1, c.length - 14); i < c.length; i++) {
        if (!fin(h[i]) || !fin(l[i]) || !fin(c[i - 1])) continue;
        atr += Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
        n++;
      }
      m.atr14 = n ? atr / n : null;
      m.atr14Pct = (m.atr14 && S) ? m.atr14 / S * 100 : null;
      m.adv20 = v.length >= 20 ? v.slice(-20).reduce(function (a, b) { return a + b; }, 0) / 20 : null;
      // IV Rank 代理：滾動 HV20 序列（誠實標註）
      var series = [];
      for (var j = 20; j <= c.length; j++) {
        var hv = E.hvCloseToClose(c.slice(0, j), 20);
        if (fin(hv)) series.push(hv);
      }
      m.hvSeries = series.slice(-252);
      m.ivRankProxy = true;
    }

    // ---- 期權鏈 ----
    var now = Date.now();
    var exps = [];
    var cands = [];
    (rec.chains || []).forEach(function (ch) {
      var expMs = Date.parse(ch.expiry + 'T20:00:00Z');
      if (!isFinite(expMs)) return;
      var dteF = (expMs - now) / 86400000;
      if (dteF < 0.5) return;
      if (dteF > LIMITS.dteMax) return;
      cands.push({ ch: ch, T: Math.max(dteF, 0.5) / 365, dteF: dteF });
    });
    // 只留 7–120 天。唔可以「由近排到遠拎頭 N 個」——NVDA/TSLA 呢啲週選密集嘅名，
    // 頭 7 個到期日全部係 0–3 日，Vega≈0，IV 根本解唔出，成檔會被誤判為「無 IV」。
    cands = cands.filter(function (c) { return c.dteF >= LIMITS.dteMin && c.dteF <= LIMITS.dteMax; });
    cands.sort(function (a, b) { return a.T - b.T; });
    // 均勻取樣，兼顧近期同遠期（期限結構要覆蓋面）
    var chosen = cands;
    if (cands.length > MAX_EXPIRIES) {
      chosen = [];
      for (var k = 0; k < MAX_EXPIRIES; k++) {
        chosen.push(cands[Math.round(k * (cands.length - 1) / (MAX_EXPIRIES - 1))]);
      }
      // 去重（均勻取樣有機會重複同一個）
      var seen = {}, uniq = [];
      chosen.forEach(function (c) { if (!seen[c.ch.expiry]) { seen[c.ch.expiry] = 1; uniq.push(c); } });
      chosen = uniq;
    }
    chosen.forEach(function (c) {
      var a = analyseExpiry(c.ch, S, c.T, r, m.dividend);
      if (a.contracts) exps.push(a);
    });
    m.exps = exps;

    var curve = buildIVCurve(exps, S);
    m.iv30 = curve.iv30;
    m.ivFar = curve.ivFar;
    m.ts = curve.ts;
    m.curveSpan = curve.span;
    m.ivPoints = curve.points;

    // 主到期日：先要保证「有嘢可以做」，再讲偏好 30–45 天。
    // 实测 DELL 最接近 38 天嗰个到期日得 1 个可用合约（嗰日零成交，Nasdaq 返嘅系理论价、
    // 买卖差 2–12%），但隔篱嗰日有 50 个。净按「接近 38 天」拣会成档被误判为流动性不足。
    // 正确做法：先筛掉合约数唔达标嘅到期日，再喺达标嗰批入面拣最接近 38 天。
    var withAtm = exps.filter(function (e) { return e.atm && e.contracts > 0; });
    var qualified = withAtm.filter(function (e) { return e.contracts >= LIMITS.strikesMin; });
    var pool = qualified.length ? qualified : withAtm;
    var pick = null, bestScore = Infinity;
    pool.forEach(function (e) {
      var sc = Math.abs(e.dte - 38);
      if (sc < bestScore) { bestScore = sc; pick = e; }
    });
    m.picked = pick;
    if (pick) {
      m.dte = pick.dte;
      m.expiry = pick.expiry;
      m.atmMid = pick.atm ? pick.atm.mid : null;
      m.atmSpreadPct = pick.atmSpreadPct;
      m.atmOi = pick.atmOi;
      m.atmDelta = pick.atm ? pick.atm.delta : null;
      m.strikes = pick.contracts;
      m.callOi = pick.callOi; m.putOi = pick.putOi;
      m.oiTotal = pick.oiTotal; m.volTotal = pick.volTotal;
      m.topStrikeShare = pick.topStrikeShare; m.pinStrike = pick.pinStrike;
      m.skew25 = (fin(pick.iv25put) && fin(pick.iv25call) && fin(m.iv30) && m.iv30 > 0)
        ? (pick.iv25put - pick.iv25call) / m.iv30 : null;
      var T30 = 30 / 365;
      m.em1 = E.expectedMove(S, T30, m.iv30, 1);
      m.probUp = E.probAbove(S, T30, m.iv30, r, m.dividend, S * 1.05);
      m.probTouchUp = E.probTouch(S, T30, m.iv30, r, m.dividend, S * 1.10, 'up');
      // 跨財報 straddle：搵覆蓋財報日嘅到期日
      var ed = rec.earningsDate;
      if (ed) {
        m.earningsDate = ed;
        m.dEarn = daysBetween(ed, new Date(now));
        var cover = null;
        exps.forEach(function (e) { if (m.dEarn != null && e.dte >= m.dEarn && !cover) cover = e; });
        if (cover && cover.atm) {
          var put = null, bd = Infinity;
          // 同 strike 嘅 put 用嚟砌 straddle
          (cover.atm.K ? (rec.chains || []) : []).forEach(function () { });
          m.earnExpiry = cover.expiry;
          m.earnDte = cover.dte;
          m.earnIv = cover.atm.iv;
          m.earnAtmMid = cover.atm.mid;
        }
      }
    }

    // ---- 事件 / 資金 / 聚焦 ----
    var rt = rec.ratings || {};
    m.rating = rt.mean || null;
    m.ratingCount = rt.count || 0;
    var sh = rec.short || {};
    m.shortInterest = sh.interest || null;
    m.daysToCover = sh.daysToCover || null;
    var inst = rec.institutional || {};
    m.instOwn = inst.ownershipPct || null;
    m.instInc = inst.holdersIncreased || 0;
    m.instDec = inst.holdersDecreased || 0;
    m.shortFloatPct = (fin(m.shortInterest) && fin(m.marketCap) && S > 0 && m.marketCap > 0)
      ? m.shortInterest * S / m.marketCap * 100 : null;
    var eh = rec.earningsHistory || [];
    m.earningsCount = eh.length;

    // ---- 衍生比率 ----
    m.vr = (fin(m.iv30) && fin(m.hvBlend) && m.hvBlend > 0) ? m.iv30 / m.hvBlend : null;

    return m;
  }

  /* ==========================================================================
   * 4. 分類
   * ======================================================================== */
  function classify(m, ctx) {
    if (m.fatal) return { primary: 'AVOID', reasons: [m.fatal], tags: ['AVOID'] };

    // 池內相對位置。絕對門檻（如 VR≥1.20）喺真實市場幾乎冇人過到——
    // 實測 12 檔 VR 分佈 0.88~1.23，全部卡喺中間。所以主力用「喺今日存活池入面排幾高」，
    // 絕對門檻只做第二條路（池太細時 rel 退回 0.5，等於淨用絕對門檻）。
    ctx = ctx || {};
    var pools = ctx.pools || {};
    var rel = function (key, v) {
      var p = pools[key];
      if (!p || p.length < 8 || !fin(v)) return 0.5;
      return pctRank(p, v);
    };
    var vrRel = rel('vr', m.vr);
    var ivrRel = rel('ivRank', m.ivRank);
    var atrRel = rel('atr14Pct', m.atr14Pct);

    var reasons = [], cand = [];

    // EARNINGS：10 日內財報（可主動用長到期覆蓋）
    if (m.dEarn != null && m.dEarn >= 0 && m.dEarn <= 10 && fin(m.earnIv)) {
      cand.push({ tag: 'EARNINGS', reason: '距财报 ' + m.dEarn + ' 天，可选用 ' + m.earnDte + ' 天到期覆盖' });
    }
    // EARNINGS：所選到期日會跨過財報 —— 呢個係被動踩雷，必須提示。
    // 實測 12 檔入面有 4 檔中招（INTC/AAPL/PLTR/MSTR），唔標出嚟會當普通收租去做。
    if (m.dEarn != null && m.dEarn > 10 && fin(m.dte) && m.dEarn <= m.dte + 7) {
      cand.push({ tag: 'EARNINGS', reason: '所选 ' + m.dte + ' 天到期会跨过 ' + m.dEarn +
        ' 天后的财报 → 持仓期内有跳空 + IV crush，不适合裸卖' });
    }

    // SQUEEZE_FLOW
    if (fin(m.daysToCover) && m.daysToCover >= 5 &&
        fin(m.shortFloatPct) && m.shortFloatPct >= 10 &&
        fin(m.callOi) && fin(m.putOi) && m.putOi > 0 && m.callOi / m.putOi >= 2 &&
        fin(m.price) && fin(m.ma20) && m.price > m.ma20) {
      cand.push({ tag: 'SQUEEZE_FLOW', reason: '回补 ' + m.daysToCover.toFixed(1) + ' 天、call/put OI ' +
        (m.callOi / m.putOi).toFixed(1) + '×、价站上 MA20' });
    }

    // BUY_VOL：IV 被低估 + 動能。
    // 注意：IV Rank 係用 HV 分佈代理出嚟，同 VR 唔獨立，兩個一齊做硬性閘門會互相抵消。
    // 所以主力用 VR，IVR 只做「或」嘅第二條路。
    var volSurging = (fin(m.hv20) && fin(m.hv60) && m.hv60 > 0 && m.hv20 / m.hv60 >= 1.8);
    var bigMove = (fin(m.ret5) && fin(m.hv20) && Math.abs(m.ret5) >= 2 * m.hv20 * Math.sqrt(5 / 252));
    // IV Rank 用長期 HV 分佈、VR 用 HV20 —— 實測兩者唔一致（TSLA VR 池內第 2 高但 IVR 得 31），
    // 係兩個 horizon，所以 IVR 唔做硬性閘門，只喺 reason 度交代。
    var ivLow = vrRel <= 0.30 || (fin(m.vr) && m.vr <= 0.92);
    var ivVeryLow = fin(m.vr) && m.vr <= 0.80;         // 極低估，唔使等動能確認
    if (ivLow && (volSurging || bigMove || ivVeryLow || ivrRel <= 0.30)) {
      cand.push({ tag: 'BUY_VOL', reason: 'IV 仅 HV 的 ' + (m.vr * 100).toFixed(0) + '%' +
        (fin(m.ivRank) ? '、IV Rank ' + m.ivRank.toFixed(0) : '') + '，' +
        (volSurging ? '20日波动已达60日 ' + (m.hv20 / m.hv60).toFixed(1) + '×'
          : (bigMove ? '5日异动 ≥2σ' : 'IV 显著折价')) });
    }

    // SELL_PREMIUM
    // 財報喺到期日之後就算安全（+2 日防財報日期改期）。之前用 +7 太嚴，
    // 搞到 12 檔入面 8 檔被判「唔安全」，SELL_PREMIUM 一個都出唔到。
    var earnSafe = (m.dEarn == null) || (fin(m.dte) && m.dEarn > m.dte + 2);
    // ts（期限結構斜率）唔做硬閘門——實測大部份標的 ts<0.95（遠月有財報溢價），
    // 但向下斜對賣方唔係壞事。ts 嘅作用交畀評分維度（WEIGHT.ts）處理。
    var ivHigh = vrRel >= 0.65 || (fin(m.vr) && m.vr >= 1.15);
    if (ivHigh && earnSafe) {
      cand.push({ tag: 'SELL_PREMIUM', reason: 'IV 为 HV 的 ' + m.vr.toFixed(2) + '×（池内前 ' +
        ((1 - vrRel) * 100).toFixed(0) + '%）' +
        (fin(m.ivRank) ? '、IV Rank ' + m.ivRank.toFixed(0) : '') + '、期限结构 ' + m.ts.toFixed(2) });
    }

    // RANGE：真震盪 —— IV≈HV、波動收斂、無催化。呢個係可以落鐵鷹嘅，唔係垃圾桶。
    if (fin(m.vr) && m.vr >= 0.90 && m.vr <= 1.15 && earnSafe &&
        ((fin(m.hv10) && fin(m.hv60) && m.hv10 <= m.hv60) || atrRel <= 0.50)) {
      cand.push({ tag: 'RANGE', reason: 'IV≈HV（' + m.vr.toFixed(2) + '）' +
        (fin(m.atr14Pct) ? '、ATR14 ' + m.atr14Pct.toFixed(1) + '%' : '') + '、波动收敛、无近期催化' });
    }

    // 按優先序排：reasons[0] 必須係主標籤嘅理由，否則 UI 會顯示「卖方收租」配一句跨財報警告
    cand.sort(function (a, b) { return PRIORITY.indexOf(a.tag) - PRIORITY.indexOf(b.tag); });
    var tags = cand.map(function (c) { return c.tag; });
    reasons = cand.map(function (c) { return c.reason; });
    var primary = null;
    for (var i = 0; i < PRIORITY.length; i++) {
      if (tags.indexOf(PRIORITY[i]) >= 0) { primary = PRIORITY[i]; break; }
    }
    if (!primary) {
      // 一個都冇觸發：誠實講「今日冇信號」。唔好扮係震盪機會呃自己。
      primary = 'NEUTRAL';
      tags = ['NEUTRAL'];
      reasons = ['暂无明确信号（IV/HV ' + (fin(m.vr) ? m.vr.toFixed(2) : '—') +
        '、IV Rank ' + (fin(m.ivRank) ? m.ivRank.toFixed(0) : '—') +
        '、ATR14 ' + (fin(m.atr14Pct) ? m.atr14Pct.toFixed(1) + '%' : '—') + '），今日不勉强'];
    }
    return { primary: primary, tags: tags, reasons: reasons };
  }

  /* ==========================================================================
   * 5. 建議結構
   * ======================================================================== */
  function suggestStructure(m, tag) {
    if (!m.picked || !m.picked.atm) return null;
    // NEUTRAL（无明确信号）唔俾结构建议。俾咗会变成「明明话冇信号，又叫你落场」嘅矛盾，
    // 而且空 legs 会让 UI 渲染出一个空的建议框。
    if (tag === 'NEUTRAL') return null;
    var S = m.price, T = m.picked.T, r = RATE_DEFAULT;
    var iv = m.iv30 || m.picked.atm.iv;
    var out = { tag: tag, name: null, legs: [], note: null, credit: null, debit: null,
      maxProfit: null, maxLoss: null, pop: null, wings: null, dte: m.dte, expiry: m.expiry };

    // 由 analyseExpiry 已反解好嘅合約度揀
    var rows = m.pickedRows || [];
    function pickByDelta(kind, target) {
      var best = null, bd = Infinity;
      rows.forEach(function (x) {
        if (x.kind !== kind) return;
        var d = Math.abs(Math.abs(x.delta) - target);
        if (d < bd) { bd = d; best = x; }
      });
      return best;
    }
    /** 攞同一个行权价嘅 call / put。Straddle 必须同 K，
     *  分开用 pickByDelta 会拣到两个唔同 K，砌出嚟唔系 straddle，损平点都计唔到。 */
    function pickPairAt(K) {
      var c = null, p = null;
      rows.forEach(function (x) {
        if (x.K !== K) return;
        if (x.kind === 'call') c = x; else p = x;
      });
      return { call: c, put: p };
    }
    var atmK = m.picked.atm.K;

    if (!rows.length) {
      out.note = '合约明细不足，无法给出具体行权价';
      out.name = tagLabel(tag);
      return out;
    }

    var T30 = Math.max(T, 1 / 365);
    if (tag === 'SELL_PREMIUM' || tag === 'RANGE') {
      var shortPut = pickByDelta('put', 0.16), shortCall = pickByDelta('call', 0.16);
      // 翅膀：向下／向上搵「至少一行權價」之外嘅最平合約。
      // 唔可以用 pickByDelta('put', 0.05) —— 細價股（如 MARA $13）行權價疏，
      // 16Δ 同 5Δ 會撞同一個 K，砌出嚟嘅「鐵鷹」翼寬 0，credit 計到 0。
      var putKs = rows.filter(function (x) { return x.kind === 'put' && shortPut && x.K < shortPut.K; })
        .sort(function (a, b) { return b.K - a.K; });
      var callKs = rows.filter(function (x) { return x.kind === 'call' && shortCall && x.K > shortCall.K; })
        .sort(function (a, b) { return a.K - b.K; });
      var longPut = putKs[0] || null, longCall = callKs[0] || null;
      if (tag === 'RANGE' && shortPut && shortCall) {
        out.name = 'Iron Condor（铁鹰）';
        out.legs = [
          { act: 'sell', kind: 'put', K: shortPut.K, mid: shortPut.mid },
          { act: 'sell', kind: 'call', K: shortCall.K, mid: shortCall.mid }
        ];
        if (longPut && longCall) {
          out.legs.push({ act: 'buy', kind: 'put', K: longPut.K, mid: longPut.mid });
          out.legs.push({ act: 'buy', kind: 'call', K: longCall.K, mid: longCall.mid });
          out.wings = { down: shortPut.K - longPut.K, up: longCall.K - shortCall.K };
        }
        out.credit = (shortPut.mid + shortCall.mid) - ((longPut ? longPut.mid : 0) + (longCall ? longCall.mid : 0));
        out.pop = E.probBetween(S, T30, iv, r, m.dividend, shortPut.K, shortCall.K);
        out.note = '收租型：short 16Δ 两边，賺 theta 同 IV 回落';
      } else if (shortPut) {
        out.name = 'Cash-Secured Put / 卖 Put';
        out.legs = [{ act: 'sell', kind: 'put', K: shortPut.K, mid: shortPut.mid }];
        out.credit = shortPut.mid;
        out.pop = E.probAbove(S, T30, iv, r, m.dividend, shortPut.K);
        out.note = '单腿卖 Put：IV 偏高时效率最好';
      } else if (shortCall) {
        out.name = 'Covered Call / 卖 Call';
        out.legs = [{ act: 'sell', kind: 'call', K: shortCall.K, mid: shortCall.mid }];
        out.credit = shortCall.mid;
        out.pop = E.probBelow(S, T30, iv, r, m.dividend, shortCall.K);
        out.note = '持有正股者可用';
      }
      if (out.credit != null) {
        out.maxProfit = out.credit * 100;
        out.maxLoss = out.wings ? (Math.max(out.wings.down, out.wings.up) * 100 - out.maxProfit) : null;
      }
    } else if (tag === 'BUY_VOL') {
      // Straddle 一定要两条腿（买 Call + 买 Put）先算「赌波动放大、唔赌方向」。
      // 之前净出 call 腿，用户会当系单边做多，同 BUY_VOL 嘅语义完全相反。
      var pair = pickPairAt(atmK);
      var atmC = pair.call || pickByDelta('call', 0.5);
      var atmP = pair.put || pickByDelta('put', 0.5);
      if (atmC && atmP) {
        out.name = 'Long Straddle（买 Call + 买 Put）';
        out.legs = [
          { act: 'buy', kind: 'call', K: atmC.K, mid: atmC.mid },
          { act: 'buy', kind: 'put', K: atmP.K, mid: atmP.mid }
        ];
        out.debit = atmC.mid + atmP.mid;
        out.maxLoss = out.debit * 100;
        out.maxProfit = null;                 // 上行方向理论上限唔封顶
        out.pop = null;
        out.note = 'IV 被低估，赌波动放大而不赌方向；到期前要升或跌超过 ' +
          (out.debit / S * 100).toFixed(1) + '% 先回本，注意 theta 流血';
      } else if (atmC) {
        out.name = 'Long Call';
        out.legs = [{ act: 'buy', kind: 'call', K: atmC.K, mid: atmC.mid }];
        out.debit = atmC.mid;
        out.maxLoss = atmC.mid * 100;
        out.note = 'IV 被低估，用 debit 结构博波动放大；注意 theta 流血';
      }
    } else if (tag === 'EARNINGS') {
      var epair = pickPairAt(atmK);
      var ec = epair.call || pickByDelta('call', 0.5);
      var ep = epair.put || pickByDelta('put', 0.5);
      if (ec && ep) {
        out.name = '跨财报 Long Straddle';
        out.legs = [
          { act: 'buy', kind: 'call', K: ec.K, mid: ec.mid },
          { act: 'buy', kind: 'put', K: ep.K, mid: ep.mid }
        ];
        out.debit = ec.mid + ep.mid;
        out.maxLoss = out.debit * 100;
        out.maxProfit = null;
      } else if (ec) {
        out.name = '跨财报 Long Call';
        out.legs = [{ act: 'buy', kind: 'call', K: ec.K, mid: ec.mid }];
        out.debit = ec.mid;
        out.maxLoss = ec.mid * 100;
      }
      out.note = 'IV crush 风险高；straddle 定价 ÷ 历史财报单日变动 决定买定卖';
      out.dte = m.earnDte || m.dte;
      out.expiry = m.earnExpiry || m.expiry;
    } else if (tag === 'SQUEEZE_FLOW') {
      var dc = pickByDelta('call', 0.6), lc = pickByDelta('call', 0.35);
      out.name = 'Bull Call Debit Spread';
      if (dc && lc && lc.K > dc.K) {
        out.legs = [{ act: 'buy', kind: 'call', K: dc.K, mid: dc.mid },
                    { act: 'sell', kind: 'call', K: lc.K, mid: lc.mid }];
        out.debit = dc.mid - lc.mid;
        out.maxProfit = (lc.K - dc.K) * 100 - out.debit * 100;
        out.maxLoss = out.debit * 100;
        out.pop = E.probAbove(S, T30, iv, r, m.dividend, dc.K);
      }
      out.note = '方向性做多，禁止裸卖；轧空行情反转极快';
    } else {
      out.name = '—';
      out.note = '无明确结构建议';
    }
    return attachBreakEven(out, S);
  }

  /**
   * 帮建议结构补上「损益平衡点」同「相对现价要升／跌几多 % 先赚」。
   * 用户睇一张卡要嘅其实系三件事：做边一日、咩行权价、要升跌几多先赚。
   * 净系写「买 Call 185 @13.48」根本落唔到单。
   */
  function attachBreakEven(out, S) {
    if (!out || !out.legs || !out.legs.length) return out;
    var net = (out.debit != null) ? out.debit
      : (out.credit != null ? out.credit : null);
    if (net == null || !fin(S) || S <= 0) return out;

    var sells = out.legs.filter(function (L) { return L.act === 'sell'; });
    var buys = out.legs.filter(function (L) { return L.act === 'buy'; });
    var be = null;

    if (!sells.length && buys.length === 2) {
      // Long Straddle：上下各一个损平点
      be = { lower: buys[0].K - net, upper: buys[0].K + net };
    } else if (!sells.length && buys.length === 1) {
      // 单腿买方
      be = buys[0].kind === 'call'
        ? { upper: buys[0].K + net }
        : { lower: buys[0].K - net };
    } else if (sells.length === 1 && buys.length === 1) {
      // 价差（debit / credit spread）：同类型，取 long 腿定损平
      var long = buys[0];
      be = long.kind === 'call' ? { upper: long.K + net } : { lower: long.K - net };
    } else if (sells.length >= 2) {
      // Iron Condor：中间系安全区，跌穿下界或升穿上界就开始蚀
      var sp = sells.filter(function (L) { return L.kind === 'put'; })[0];
      var sc = sells.filter(function (L) { return L.kind === 'call'; })[0];
      if (sp && sc) be = { lower: sp.K - net, upper: sc.K + net };
      else if (sp) be = { lower: sp.K - net };
      else if (sc) be = { upper: sc.K + net };
    } else if (sells.length === 1) {
      // 单腿卖方
      if (sells[0].kind === 'put') be = { lower: sells[0].K - net };
      else be = { lower: S - net, upper: sells[0].K + net };   // Covered Call（持正股）
    }

    if (!be) return out;
    out.breakEven = be;
    out.movePct = {};
    if (fin(be.lower)) out.movePct.down = (be.lower / S - 1) * 100;
    if (fin(be.upper)) out.movePct.up = (be.upper / S - 1) * 100;
    return out;
  }

  function tagLabel(tag) { return (TAGS[tag] || TAGS.AVOID).label; }

  /* ==========================================================================
   * 6. 評分
   * ======================================================================== */
  // 方向係數：呢個維度對該標籤係「越高越好(+1)」定「越低越好(-1)」
  var DIR = {
    SELL_PREMIUM: { ivLevel: 1, vrp: 1, liq: 1, ts: 1, skew: 1, catalyst: -1, momentum: -1, oiConc: 1, quality: 1 },
    BUY_VOL:      { ivLevel: -1, vrp: -1, liq: 1, ts: -1, skew: -1, catalyst: 1, momentum: 1, oiConc: -1, quality: 1 },
    EARNINGS:     { ivLevel: 1, vrp: -1, liq: 1, ts: 1, skew: 0, catalyst: 1, momentum: 1, oiConc: 1, quality: 1 },
    RANGE:        { ivLevel: -1, vrp: -1, liq: 1, ts: 1, skew: 0, catalyst: -1, momentum: -1, oiConc: 1, quality: 1 },
    SQUEEZE_FLOW: { ivLevel: 0, vrp: 0, liq: 1, ts: 0, skew: 0, catalyst: 1, momentum: 1, oiConc: 1, quality: 1 },
    AVOID:        { ivLevel: 0, vrp: 0, liq: 0, ts: 0, skew: 0, catalyst: 0, momentum: 0, oiConc: 0, quality: 0 },
    // 冇信號時，淨係流動性同資料質量仲有得分意義（其餘維度無方向，按 0.5 中性計）
    NEUTRAL:      { ivLevel: 0, vrp: 0, liq: 1, ts: 0, skew: 0, catalyst: 0, momentum: 0, oiConc: 0, quality: 1 }
  };
  var WEIGHT = { ivLevel: 12, vrp: 18, liq: 14, ts: 10, skew: 8, catalyst: 12, momentum: 10, oiConc: 10, quality: 6 };

  /**
   * 正規化：池內百分位（池夠大時）優先，否則退回固定區間。
   * 用百分位嘅原因：每日掃描係「今日呢批入面邊隻最值得做」，
   * 絕對區間會令分數擠喺 45–65 冇辨別度。
   */
  function pctOrFixed(pool, value, lo, hi) {
    if (pool && pool.length >= 8 && fin(value)) return pctRank(pool, value);
    return map(value, lo, hi);
  }

  function scoreOne(m, pools, cls) {
    var tag = cls.primary;
    // 新增標籤時必須補 DIR：漏咗會 fallback 全 0 → 每維度按 0.5 中性計 → 全部 50 分冇辨別度
    var d = DIR[tag] || DIR.NEUTRAL;
    pools = pools || {};
    var dims = {};

    // IV 水平：呢個係絕對量（0-100），keep 絕對
    var ivr = fin(m.ivRank) ? m.ivRank : (fin(m.ivPercentile) ? m.ivPercentile : 50);
    dims.ivLevel = cl(ivr / 100, 0, 1);

    // IV/HV 背離
    dims.vrp = pctOrFixed(pools.vr, m.vr, 0.80, 1.60);

    // 流動性（複合，做百分位）
    var liqOi = map(Math.log10(Math.max(m.oiTotal || 1, 1)), 2, 5);          // 100 → 100000
    var liqSpread = fin(m.atmSpreadPct) ? cl(1 - m.atmSpreadPct / 6, 0, 1) : 0.3;
    var liqVol = map(Math.log10(Math.max(m.volTotal || 1, 1)), 1, 4);        // 10 → 10000
    var liqRaw = 0.5 * liqOi + 0.3 * liqSpread + 0.2 * liqVol;
    dims.liq = (pools.liq && pools.liq.length >= 8) ? pctRank(pools.liq, liqRaw) : liqRaw;

    // 期限結構
    dims.ts = pctOrFixed(pools.ts, m.ts, 0.85, 1.25);

    // 偏斜
    dims.skew = pctOrFixed(pools.skew, m.skew25, 0.02, 0.20);

    // 催化劑
    var earnProx = (m.dEarn != null && m.dEarn >= 0) ? cl(1 - (m.dEarn - 7) / 38, 0, 1) : 0;
    var ratingV = ({ StrongBuy: 1, Buy: 0.85, Hold: 0.5, Sell: 0.15, StrongSell: 0 })[m.rating] || 0.5;
    var ratingW = Math.min(1, (m.ratingCount || 0) / 10);
    var squeeze = cl((m.daysToCover || 0) / 10, 0, 1) * cl((m.shortFloatPct || 0) / 20, 0, 1);
    var instNet = ((m.instInc || 0) + (m.instDec || 0)) > 0
      ? (m.instInc - m.instDec) / (m.instInc + m.instDec) : 0;
    dims.catalyst = 0.4 * earnProx + 0.25 * ratingV * ratingW + 0.2 * squeeze + 0.15 * cl((instNet + 1) / 2, 0, 1);

    // 動能
    var sig = fin(m.hv20) ? m.hv20 * Math.sqrt(20 / 252) : null;
    var momRaw = (fin(m.ret20) && fin(sig) && sig > 0)
      ? cl(Math.abs(m.ret20) / (1.5 * sig), 0, 1) : 0.3;
    dims.momentum = (pools.mom && pools.mom.length >= 8) ? pctRank(pools.mom, momRaw) : momRaw;

    // OI 集中度
    dims.oiConc = pctOrFixed(pools.oiConc, m.topStrikeShare, 0.08, 0.30);

    // 資料品質
    var missingPenalty = (m.missing || []).length * 0.08;
    var spanPenalty = (fin(m.curveSpan) && m.curveSpan > 15) ? 0.15 : 0;
    var barsPenalty = (fin(m.bars) && m.bars < 252) ? 0.15 : 0;
    dims.quality = cl(1 - missingPenalty - spanPenalty - barsPenalty, 0, 1);

    // 加權（按方向係數翻轉）
    var total = 0, used = 0;
    Object.keys(WEIGHT).forEach(function (k) {
      var v = dims[k];
      if (!fin(v)) v = 0.5;
      var dir = d[k];
      var val = dir > 0 ? v : (dir < 0 ? 1 - v : 0.5);
      total += WEIGHT[k] * val;
      if (dir !== 0) used += WEIGHT[k];
    });
    // 方向係數為 0 嘅維度唔扣分，改按 0.5 中性算（上面已用 0.5），所以 used 直接係 100
    var score = cl(total, 0, 100);

    // 至少兩個維度獨立觸發，抑制多重比較假陽性
    var triggers = 0;
    if (dims.vrp >= 0.7) triggers++;
    if (dims.ivLevel >= 0.7) triggers++;
    if (dims.catalyst >= 0.7) triggers++;
    if (dims.momentum >= 0.7) triggers++;
    if (dims.liq >= 0.7) triggers++;
    if (dims.oiConc >= 0.7) triggers++;
    var multiTrigger = triggers >= 2;

    return { score: +score.toFixed(1), dims: dims, triggers: triggers, multiTrigger: multiTrigger };
  }

  /* ==========================================================================
   * 7. 主流程
   * ======================================================================== */
  function scoreAll(raw, opts) {
    opts = opts || {};
    var rate = fin(raw.rate) ? raw.rate : RATE_DEFAULT;
    var recs = raw.records || [];
    var results = [];

    recs.forEach(function (rec) {
      var m = buildMetrics(rec, { rate: rate });
      results.push({ m: m, rec: rec });
    });

    // 先算 IV Rank（要 hvSeries）
    results.forEach(function (x) {
      var m = x.m;
      if (fin(m.iv30) && m.hvSeries && m.hvSeries.length >= 30) {
        // 注意：E.ivRank / E.ivPercentile 本身已係 0–100，唔好再乘 100
        m.ivRank = E.ivRank(m.iv30, m.hvSeries);
        m.ivPercentile = E.ivPercentile(m.iv30, m.hvSeries);
      } else {
        m.ivRank = null; m.ivPercentile = null;
      }
    });

    // 存活池（過硬門檻）
    var survived = [];
    results.forEach(function (x) {
      var m = x.m;
      m.fail = hardFilter(m, m);
      m.alive = !m.fatal && m.fail.length === 0;
      if (m.alive) survived.push(x);
    });

    // 存活池指標。分類同評分都要用「池內相對位置」，所以必須喺兩者之前建好。
    var alive = survived.map(function (x) { return x.m; });
    var fv = function (k) { return alive.map(function (m) { return m[k]; }).filter(fin); };
    var liqRaw = function (m) {
      var a = map(Math.log10(Math.max(m.oiTotal || 1, 1)), 2, 5);
      var b = fin(m.atmSpreadPct) ? cl(1 - m.atmSpreadPct / 6, 0, 1) : 0.3;
      var c = map(Math.log10(Math.max(m.volTotal || 1, 1)), 1, 4);
      return 0.5 * a + 0.3 * b + 0.2 * c;
    };
    var momRaw = function (m) {
      var sig = fin(m.hv20) ? m.hv20 * Math.sqrt(20 / 252) : null;
      return (fin(m.ret20) && fin(sig) && sig > 0) ? cl(Math.abs(m.ret20) / (1.5 * sig), 0, 1) : 0.3;
    };
    var pools = {
      vr: fv('vr'), ts: fv('ts'), skew: fv('skew25'), oiConc: fv('topStrikeShare'),
      ivRank: fv('ivRank'), atr14Pct: fv('atr14Pct'),
      liq: alive.map(liqRaw), mom: alive.map(momRaw)
    };

    // 分類 + 建議
    survived.forEach(function (x) {
      var m = x.m;
      m.cls = classify(m, { pools: pools });
      // 直接復用 analyseExpiry 已反解好嘅合約，唔再解析第二次
      m.pickedRows = (m.picked && m.picked.rows) ? m.picked.rows : [];
      m.structure = suggestStructure(m, m.cls.primary);
    });

    // 評分
    survived.forEach(function (x) {
      x.m.sc = scoreOne(x.m, pools, x.m.cls);
    });

    // 排序輸出
    var out = alive.map(function (m) {
      return {
        symbol: m.symbol, name: m.name, price: m.price,
        change: m.change, changePct: m.changePct,
        sector: m.sector, marketCap: m.marketCap,
        tag: m.cls.primary, tags: m.cls.tags, reasons: m.cls.reasons,
        score: m.sc.score, dims: m.sc.dims, triggers: m.sc.triggers,
        multiTrigger: m.sc.multiTrigger,
        iv30: m.iv30, ivFar: m.ivFar, ts: m.ts, skew25: m.skew25,
        hv10: m.hv10, hv20: m.hv20, hv60: m.hv60, hv252: m.hv252,
        hvBlend: m.hvBlend, vr: m.vr, ivRank: m.ivRank, ivRankProxy: m.ivRankProxy !== false,
        dte: m.dte, expiry: m.expiry,
        atmMid: m.atmMid, atmSpreadPct: m.atmSpreadPct, atmOi: m.atmOi, atmDelta: m.atmDelta,
        oiTotal: m.oiTotal, volTotal: m.volTotal, strikes: m.strikes,
        pinStrike: m.pinStrike, topStrikeShare: m.topStrikeShare,
        callOi: m.callOi, putOi: m.putOi,
        em1: m.em1 ? { dollars: m.em1.dollars, percent: m.em1.percent, lower: m.em1.lower, upper: m.em1.upper } : null,
        probUp5: m.probUp,
        earningsDate: m.earningsDate || null, dEarn: m.dEarn != null ? m.dEarn : null,
        earnDte: m.earnDte || null, earnIv: m.earnIv || null,
        rating: m.rating, ratingCount: m.ratingCount,
        daysToCover: m.daysToCover, shortFloatPct: m.shortFloatPct,
        instOwn: m.instOwn, instInc: m.instInc, instDec: m.instDec,
        atr14Pct: m.atr14Pct, ret20: m.ret20,
        structure: m.structure,
        missing: m.missing
      };
    }).sort(function (a, b) { return b.score - a.score; });

    // 冇過門檻嘅（要顯示點解被剔）
    var rejected = results.filter(function (x) { return !x.m.alive; })
      .map(function (x) {
        return { symbol: x.m.symbol, name: x.m.name, price: x.m.price,
          reasons: x.m.fatal ? [x.m.fatal] : x.m.fail };
      });

    // 門檻：池內百分位正規化後分數分佈拉得開，65 係一個有意義嘅「值得睇」線
    var actionable = out.filter(function (x) { return x.score >= 65 && x.multiTrigger; });
    var watch = out.filter(function (x) { return x.score >= 50 && !(x.score >= 65 && x.multiTrigger); });

    return {
      date: raw.date || new Date().toISOString().slice(0, 10),
      generatedAt: new Date().toISOString(),
      rate: rate,
      source: 'Nasdaq public API (api.nasdaq.com) — free, no key',
      tags: TAGS,
      summary: {
        scanned: recs.length,
        survived: out.length,
        actionable: actionable.length,
        watch: watch.length,
        rejected: rejected.length,
        byTag: (function () {
          var t = {};
          out.forEach(function (x) { t[x.tag] = (t[x.tag] || 0) + 1; });
          return t;
        })(),
        fetchSeconds: raw.fetchSeconds || null
      },
      results: out,
      rejected: rejected
    };
  }

  /* ==========================================================================
   * CLI
   * ======================================================================== */
  function runCLI() {
    var fs = require('fs');
    var inp = process.argv[2], outp = process.argv[3];
    if (!inp || !outp) {
      console.error('用法: node score.js <raw.json> <out.json>');
      process.exit(2);
    }
    var raw = JSON.parse(fs.readFileSync(inp, 'utf8'));
    var res = scoreAll(raw);
    fs.writeFileSync(outp, JSON.stringify(res));
    var s = res.summary;
    // Node 嘅 console.log 唔支援 printf 寬度（%-5s / %5.1f），要自己排
    console.log('  評分完成：掃描 ' + s.scanned + ' → 存活 ' + s.survived +
      ' → 值得睇 ' + s.actionable + ' → 觀察 ' + s.watch);
    console.log('  標籤分佈：' + (Object.keys(s.byTag).map(function (k) {
      return TAGS[k].label + ' ' + s.byTag[k];
    }).join(' · ') || '（無）'));

    function pad(v, n) { v = String(v == null ? '—' : v); while (v.length < n) v += ' '; return v; }
    function lpad(v, n) { v = String(v == null ? '—' : v); while (v.length < n) v = ' ' + v; return v; }
    function pc(v) { return fin(v) ? (v * 100).toFixed(1) + '%' : '—'; }

    var top = res.results.slice(0, 12);
    console.log('  ' + pad('#', 3) + pad('代码', 7) + pad('标签', 11) + lpad('分', 6) +
      lpad('IV30', 7) + lpad('VR', 6) + lpad('IVR', 6) + lpad('DTE', 5) + '  触发原因');
    top.forEach(function (x, i) {
      console.log('  ' + pad(i + 1, 3) + pad(x.symbol, 7) + pad(TAGS[x.tag].label, 11) +
        lpad(x.score.toFixed(1), 6) + lpad(pc(x.iv30), 7) +
        lpad(fin(x.vr) ? x.vr.toFixed(2) : '—', 6) +
        lpad(fin(x.ivRank) ? x.ivRank.toFixed(0) : '—', 6) +
        lpad(x.dte == null ? '—' : x.dte, 5) + '  ' +
        ((x.reasons && x.reasons[0]) ? x.reasons[0] : ''));
    });

    if (res.rejected && res.rejected.length) {
      console.log('  被剔 (' + res.rejected.length + ')：' + res.rejected.slice(0, 12).map(function (r) {
        return r.symbol + '(' + (r.reasons[0] || '—') + ')';
      }).join(' '));
    }
  }

  if (typeof module === 'object' && module.exports && require.main === module) runCLI();

  return {
    TAGS: TAGS, PRIORITY: PRIORITY, LIMITS: LIMITS,
    analyseExpiry: analyseExpiry, buildIVCurve: buildIVCurve,
    buildMetrics: buildMetrics, classify: classify,
    suggestStructure: suggestStructure, scoreOne: scoreOne, scoreAll: scoreAll
  };
});
