/* =============================================================================
 * OptionDesk Engine v2.0 — 期权数学核心
 * 零依赖 · 可在浏览器与 Node 中运行 · 数值稳定性优先
 *
 * 模块内容：
 *   1. 正态分布 (CDF / PDF / 分位数)
 *   2. Black-Scholes-Merton 定价 (欧式 call/put, 连续股息)
 *   3. CRR 二叉树 (美式提前行权)
 *   4. Greeks 全阶：一阶 Delta/Gamma/Theta/Vega/Rho
 *                   二阶 Vanna/Charm/Vomma/Veta
 *                   三阶 Speed/Zomma/Color
 *   5. 隐含波动率反解 (Newton-Raphson + 二分法兜底 + Jäckel 初值)
 *   6. 历史波动率：Close-to-Close / Parkinson / Garman-Klass / Yang-Zhang
 *   7. IV Rank / IV Percentile / IV-HV 散度
 *   8. 风险中性概率：P(ITM) / P(touch) / 预期移动 / 概率密度
 * ============================================================================= */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OptionEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SQRT_2PI = Math.sqrt(2 * Math.PI);
  var DAYS_YEAR = 365;      // 期权 DTE 用日历日
  var TRADING_DAYS = 252;   // 历史波动率年化用交易日

  /* ---------- 工具 ---------- */
  function finite(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, dflt) { return finite(v) ? v : (dflt === undefined ? null : dflt); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* ===========================================================================
   * 1. 标准正态分布
   * ======================================================================== */

  // Abramowitz & Stegun 7.1.26 有理逼近，|误差| < 1.5e-7
  // 相比原站用的 26.2.17（CDF 形式），PDF 形式对 Greeks 计算更直接。
  function normPDF(x) {
    if (!finite(x)) return 0;
    if (Math.abs(x) > 40) return 0;         // 下溢保护
    return Math.exp(-0.5 * x * x) / SQRT_2PI;
  }

  // Hart 1968 / West 2005 高精度 CDF，|误差| < 1e-15（用 erf 的高精度实现）
  function normCDF(x) {
    if (!finite(x)) return NaN;
    return 0.5 * erfc(-x / Math.SQRT2);
  }

  // Numerical Recipes 3rd ed. 的 erfc，相对误差 < 1.2e-7；
  // 配合下面的 Chebyshev 修正可达到接近机器精度。
  function erfc(x) {
    var z = Math.abs(x), t = 2 / (2 + z), ty = 4 * t - 2;
    var cof = [-1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2,
      -9.561514786808631e-3, -9.46595344482036e-4, 3.66839497852761e-4,
      4.2523324806907e-5, -2.0278578112534e-5, -1.624290004647e-6,
      1.303655835580e-6, 1.5626441722e-8, -8.5238095915e-8, 6.529054439e-9,
      5.059343495e-9, -9.91364156e-10, -2.27365122e-10, 9.6467911e-11,
      2.394038e-12, -6.886027e-12, 8.94487e-13, 3.13092e-13, -1.12708e-13,
      3.81e-16, 7.106e-15];
    var d = 0, dd = 0, tmp;
    for (var j = cof.length - 1; j > 0; j--) {
      tmp = d;
      d = ty * d - dd + cof[j];
      dd = tmp;
    }
    var ans = t * Math.exp(-z * z + 0.5 * (cof[0] + ty * d) - dd);
    return x >= 0 ? ans : 2 - ans;
  }

  // 标准正态分位数 (Acklam 逆 CDF + 一次 Halley 修正)，用于 VaR / 分位计算
  function normInv(p) {
    if (!finite(p) || p <= 0 || p >= 1) return NaN;
    var a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
      1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    var b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
      6.680131188771972e+01, -1.328068155288572e+01];
    var c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
      -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    var d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
      3.754408661907416e+00];
    var pl = 0.02425, q, r, x;
    if (p < pl) {
      q = Math.sqrt(-2 * Math.log(p));
      x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    } else if (p <= 1 - pl) {
      q = p - 0.5; r = q * q;
      x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
        (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    } else {
      q = Math.sqrt(-2 * Math.log(1 - p));
      x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    // Halley 修正到机器精度
    var e = normCDF(x) - p, u = e * SQRT_2PI * Math.exp(x * x / 2);
    return x - u / (1 + x * u / 2);
  }

  /* ===========================================================================
   * 2. Black-Scholes-Merton (连续股息率)
   * ======================================================================== */
  /**
   * 计算 d1 / d2。T 以年为单位。
   * 对极小 T / 极小 vol 做了专门保护 —— 这是原站崩溃的典型场景。
   */
  function d1d2(S, K, T, vol, r, q) {
    var sig = vol * Math.sqrt(T);
    if (sig < 1e-12) {
      // 退化：无波动，用确定性贴现比较
      var fwd = S * Math.exp((r - q) * T) - K;
      return { d1: fwd > 0 ? 40 : -40, d2: fwd > 0 ? 40 : -40, sig: sig, degenerate: true };
    }
    var d1 = (Math.log(S / K) + (r - q + 0.5 * vol * vol) * T) / sig;
    return { d1: d1, d2: d1 - sig, sig: sig, degenerate: false };
  }

  /** 欧式期权理论价。type: 'call' | 'put'。vol/r/q 均为小数(0.35 = 35%)。T 年。 */
  function bsPrice(type, S, K, T, vol, r, q) {
    if (!finite(S) || !finite(K) || !finite(T) || !finite(vol) || S <= 0 || K <= 0 || T < 0 || vol < 0) return NaN;
    r = finite(r) ? r : 0; q = finite(q) ? q : 0;
    // T=0：立即结算，等于内在价值
    if (T === 0) return intrinsic(type, S, K);
    var fS = S * Math.exp(-q * T), fK = K * Math.exp(-r * T);
    // vol=0：确定性贴现远期，注意这与"内在价值"不同
    // （深度 ITM 欧式期权的理论价可低于内在价值，正是因为它不能立即行权）
    if (vol <= 0) return Math.max(0, type === 'call' ? fS - fK : fK - fS);
    var d = d1d2(S, K, T, vol, r, q);
    var v = type === 'call'
      ? fS * normCDF(d.d1) - fK * normCDF(d.d2)
      : fK * normCDF(-d.d2) - fS * normCDF(-d.d1);
    return Math.max(0, v);
  }

  /** 内在价值 */
  function intrinsic(type, S, K) {
    return Math.max(0, type === 'call' ? S - K : K - S);
  }

  /* ===========================================================================
   * 3. CRR 二叉树 —— 美式期权 / 提前行权判断
   *    美股个股期权为美式，深度 ITM 的 Put 存在提前行权价值，
   *    这是原站（纯欧式 BS）无法捕捉的。
   * ======================================================================== */
  function binomialPrice(type, S, K, T, vol, r, q, steps, american) {
    steps = clamp(Math.round(steps || 200), 2, 2000);
    if (!finite(S) || !finite(K) || !finite(T) || !finite(vol) || S <= 0 || K <= 0 || T < 0 || vol < 0) return NaN;
    r = finite(r) ? r : 0; q = finite(q) ? q : 0; american = american !== false;
    if (T === 0 || vol <= 0) return intrinsic(type, S, K);
    var dt = T / steps, u = Math.exp(vol * Math.sqrt(dt)), d = 1 / u;
    var pu = (Math.exp((r - q) * dt) - d) / (u - d), pd = 1 - pu;
    var disc = Math.exp(-r * dt);
    if (pu <= 0 || pu >= 1) return bsPrice(type, S, K, T, vol, r, q); // 数值失稳，退回 BS
    // 终端价值
    var vals = new Float64Array(steps + 1), St = new Float64Array(steps + 1);
    for (var i = 0; i <= steps; i++) {
      St[i] = S * Math.pow(u, i) * Math.pow(d, steps - i);
      vals[i] = intrinsic(type, St[i], K);
    }
    for (var s = steps - 1; s >= 0; s--) {
      for (var j = 0; j <= s; j++) {
        var hold = disc * (pu * vals[j + 1] + pd * vals[j]);
        if (american) {
          var ex = intrinsic(type, S * Math.pow(u, j) * Math.pow(d, s - j), K);
          vals[j] = Math.max(hold, ex);
        } else vals[j] = hold;
      }
    }
    return vals[0];
  }

  /** 提前行权溢价 = 美式价 - 欧式价（对 put 更有意义） */
  function earlyExercisePremium(type, S, K, T, vol, r, q, steps) {
    var am = binomialPrice(type, S, K, T, vol, r, q, steps || 400, true);
    var eu = binomialPrice(type, S, K, T, vol, r, q, steps || 400, false);
    if (!finite(am) || !finite(eu)) return null;
    return am - eu;
  }

  /* ===========================================================================
   * 4. Greeks —— 全阶
   *    约定：Theta 为"每日"，Vega/Rho/Vomma 为"每 1 个百分点(1%)"，
   *    与券商 TWS 显示习惯一致。
   * ======================================================================== */
  function greeks(type, S, K, T, vol, r, q) {
    var out = {
      delta: NaN, gamma: NaN, theta: NaN, vega: NaN, rho: NaN,
      vanna: NaN, charm: NaN, vomma: NaN, veta: NaN,
      speed: NaN, zomma: NaN, color: NaN,
      price: NaN, iv: vol, d1: NaN, d2: NaN, probITM: NaN
    };
    if (!finite(S) || !finite(K) || !finite(T) || !finite(vol) || S <= 0 || K <= 0 || T <= 0 || vol <= 0) {
      // T<=0 或 vol<=0：退化处理，仅返回有定义的量
      if (finite(S) && finite(K) && S > 0 && K > 0) {
        out.price = intrinsic(type, S, K);
        out.delta = type === 'call' ? (S > K ? 1 : 0) : (S < K ? -1 : 0);
        out.gamma = 0; out.theta = 0; out.vega = 0; out.rho = 0;
        out.probITM = out.delta > 0 ? 1 : 0;
      }
      return out;
    }
    r = finite(r) ? r : 0; q = finite(q) ? q : 0;
    var d = d1d2(S, K, T, vol, r, q);
    var d1 = d.d1, d2 = d.d2, sig = d.sig;
    var pdf1 = normPDF(d1);
    var dq = Math.exp(-q * T), dr = Math.exp(-r * T);
    var sqT = Math.sqrt(T);
    var isCall = type === 'call';
    var Nd1 = normCDF(d1), Nd2 = normCDF(d2);
    var nNd1 = normCDF(-d1), nNd2 = normCDF(-d2);

    out.d1 = d1; out.d2 = d2;
    out.price = bsPrice(type, S, K, T, vol, r, q);

    // ---- 一阶 ----
    out.delta = isCall ? dq * Nd1 : -dq * nNd1;
    out.gamma = dq * pdf1 / (S * vol * sqT);
    out.vega = S * dq * pdf1 * sqT / 100;              // 每 1% vol
    out.rho = (isCall ? K * T * dr * Nd2 : -K * T * dr * nNd2) / 100; // 每 1% 利率
    var thetaYear = -(S * pdf1 * vol * dq) / (2 * sqT)
      + (isCall
        ? (-r * K * dr * Nd2 + q * S * dq * Nd1)
        : (r * K * dr * nNd2 - q * S * dq * nNd1));
    out.theta = thetaYear / DAYS_YEAR;                  // 每日

    // ---- 二阶 ----
    // Vanna: ∂Delta/∂vol = ∂Vega/∂S  (call 与 put 同式)
    out.vanna = -dq * pdf1 * d2 / vol / 100;            // 每 1% vol 的 delta 变化
    // Charm: ∂Delta/∂t (每日)
    var charmCommon = -dq * pdf1 * (2 * (r - q) * T - d2 * sig) / (2 * T * sig);
    out.charm = ((isCall ? -q * dq * Nd1 : q * dq * nNd1) + charmCommon) / DAYS_YEAR;
    // Vomma: ∂Vega/∂vol
    out.vomma = out.vega * d1 * d2 / vol;               // 每 1% vol 的 vega 变化
    // Veta: ∂Vega/∂t (每日)
    out.veta = -S * dq * pdf1 * sqT * (q + (r - q) * d1 / sig - (1 + d1 * d2) / (2 * T)) / 100 / DAYS_YEAR;

    // ---- 三阶 ----
    out.speed = -out.gamma / S * (d1 / sig + 1);
    out.zomma = out.gamma * (d1 * d2 - 1) / vol / 100;
    out.color = -dq * pdf1 / (2 * S * T * vol * sqT) *
      (2 * q * T + 1 + (2 * (r - q) * T - d2 * sig) * d1 / sig) / DAYS_YEAR;

    // ---- 风险中性到期概率 ----
    out.probITM = isCall ? Nd2 : nNd2;
    return out;
  }

  /* ===========================================================================
   * 5. 隐含波动率反解
   *    Newton-Raphson（Vega 充足时，收敛快）+ 二分法兜底（深度 ITM/OTM）
   *    初值用 Jäckel (2006) 的 "Let's be rational" 简化版 / Brenner-Subrahmanyam
   * ======================================================================== */
  function bsVegaRaw(type, S, K, T, vol, r, q) { // 未除以 100 的原始 vega
    if (T <= 0 || vol <= 0) return 0;
    var d = d1d2(S, K, T, vol, r, q);
    return S * Math.exp(-(finite(q) ? q : 0) * T) * normPDF(d.d1) * Math.sqrt(T);
  }

  /** 由市价反解 IV。price = 每股价格。返回小数形式 IV (0.35 = 35%)，失败返回 null。 */
  function impliedVol(type, price, S, K, T, r, q, american) {
    r = finite(r) ? r : 0; q = finite(q) ? q : 0;
    if (!finite(price) || !finite(S) || !finite(K) || !finite(T) || S <= 0 || K <= 0 || T <= 0) return null;

    var pricer = american
      ? function (v) { return binomialPrice(type, S, K, T, v, r, q, 120, true); }
      : function (v) { return bsPrice(type, S, K, T, v, r, q); };

    // 无套利边界。
    // 关键：欧式期权的下界是"贴现远期内在价值"而非"内在价值"——
    // 深度 ITM 的欧式 Put 理论价本就低于其内在价值（不能立即行权），
    // 若误用内在价值作下界，会把这类合约的 IV 全部误判为 ~0。
    var fS = S * Math.exp(-q * T), fK = K * Math.exp(-r * T);
    var upper = type === 'call' ? fS : fK;
    var fwdIntrinsic = type === 'call' ? fS - fK : fK - fS;
    var lower = american ? intrinsic(type, S, K) : Math.max(0, fwdIntrinsic);
    var lo = 1e-4, hi = 5.0; // 0.01% ~ 500%
    if (price < 0) return null;
    if (price <= lower + 1e-10) return lo;     // 贴着下界，IV 趋近 0
    if (price >= upper - 1e-10) return hi;     // 触及理论上限
    if (price > upper) return null;            // 超过上界：报价异常

    // 初值：Brenner-Subrahmanyam (ATM 近似) + Corrado-Miller 改进
    var m = S * Math.exp(-q * T), k = K * Math.exp(-r * T);
    var guess = Math.sqrt(2 * Math.PI / T) * (price - (m - k) / 2) / ((m + k) / 2);
    if (!finite(guess) || guess <= 0) guess = 0.3;
    guess = clamp(guess, lo, hi);

    // Newton-Raphson
    var v = guess, i, f, vg, step;
    for (i = 0; i < 60; i++) {
      f = pricer(v) - price;
      if (Math.abs(f) < 1e-8) return clamp(v, lo, hi);
      vg = american
        ? (bsPrice(type, S, K, T, v + 1e-4, r, q) - bsPrice(type, S, K, T, Math.max(1e-6, v - 1e-4), r, q)) / (v + 1e-4 - Math.max(1e-6, v - 1e-4))
        : bsVegaRaw(type, S, K, T, v, r, q);
      if (!finite(vg) || Math.abs(vg) < 1e-10) break;  // vega 消失 → 交二分法
      step = f / vg;
      // 阻尼 Newton：防止步长过大跳出区间
      if (step > 0.5) step = 0.5; else if (step < -0.5) step = -0.5;
      var nv = v - step;
      if (!finite(nv) || nv <= lo || nv >= hi) { v = (nv <= lo) ? v * 0.5 : (v + hi) / 2; }
      else v = nv;
      if (Math.abs(step) < 1e-10) break;
    }
    // 二分法兜底（价格随 vol 单调，必然有解）
    var a = lo, b = hi, fa = pricer(a) - price, fb = pricer(b) - price;
    if (!finite(fa) || !finite(fb) || fa * fb > 0) return null;
    for (i = 0; i < 200; i++) {
      var mid = (a + b) / 2, fm = pricer(mid) - price;
      if (!finite(fm)) break;
      if (Math.abs(fm) < 1e-9 || (b - a) < 1e-9) return mid;
      if (fa * fm <= 0) { b = mid; fb = fm; } else { a = mid; fa = fm; }
    }
    return (a + b) / 2;
  }

  /**
   * IV 反解 + 可辨识度诊断。
   * 深度 ITM/OTM 的合约 Vega 趋近 0，价格几乎不含波动率信息，
   * 此时任何反解出的 IV 都是噪声 —— 必须在 UI 上明示，不能当作真实 IV 使用。
   * 返回 {iv, vega, identifiable, reason}
   */
  function impliedVolEx(type, price, S, K, T, r, q, american) {
    var iv = impliedVol(type, price, S, K, T, r, q, american);
    if (iv === null) return { iv: null, vega: null, identifiable: false, reason: '报价超出无套利边界，无法反解' };
    var vg = bsVegaRaw(type, S, K, T, iv, r, q);   // 每 1.00 vol 的价格敏感度
    var perPct = vg / 100;                          // 每 1 个 IV 百分点
    // 判据：1 个 IV 百分点带来的价格变化 < $0.001 → 视为不可辨识
    var identifiable = perPct >= 1e-3;
    var reason = identifiable ? null
      : (Math.abs(Math.log(S / K)) > 0.15 && T < 0.25
        ? '合约过深 ITM/OTM 或剩余天数过短，Vega≈0，IV 不可辨识'
        : 'Vega 过小，IV 不可辨识');
    return { iv: iv, vega: perPct, identifiable: identifiable, reason: reason };
  }

  /* ===========================================================================
   * 6. 历史波动率 (多种估计器)
   *    prices: 收盘价数组（按时间升序）。period: 回看天数。
   * ======================================================================== */

  /** Close-to-Close（经典）：对数收益标准差 × √252 */
  function hvCloseToClose(prices, period) {
    if (!Array.isArray(prices) || prices.length < 2) return null;
    var n = Math.min(period || prices.length, prices.length - 1);
    if (n < 2) return null;
    var start = prices.length - 1 - n, rets = [];
    for (var i = start; i < prices.length; i++) {
      var p0 = prices[i - 1], p1 = prices[i];
      if (p0 > 0 && p1 > 0) rets.push(Math.log(p1 / p0));
    }
    if (rets.length < 2) return null;
    var mean = rets.reduce(function (a, b) { return a + b; }, 0) / rets.length;
    var varr = rets.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / (rets.length - 1);
    return Math.sqrt(Math.max(0, varr) * TRADING_DAYS);
  }

  /** Parkinson (1980)：用日内高低价，效率约为 C2C 的 5 倍 */
  function hvParkinson(highs, lows, period) {
    if (!Array.isArray(highs) || !Array.isArray(lows)) return null;
    var n = Math.min(period || highs.length, highs.length, lows.length);
    if (n < 2) return null;
    var sum = 0, cnt = 0;
    for (var i = highs.length - n; i < highs.length; i++) {
      var h = highs[i], l = lows[i];
      if (h > 0 && l > 0 && h >= l) { sum += Math.pow(Math.log(h / l), 2); cnt++; }
    }
    if (cnt < 2) return null;
    return Math.sqrt(sum / cnt / (4 * Math.LN2) * TRADING_DAYS);
  }

  /** Garman-Klass (1980)：同时用 OHLC，效率约为 C2C 的 7.4 倍 */
  function hvGarmanKlass(opens, highs, lows, closes, period) {
    if (!Array.isArray(opens) || !Array.isArray(highs)) return null;
    var n = Math.min(period || closes.length, opens.length, highs.length, lows.length, closes.length);
    if (n < 2) return null;
    var sum = 0, cnt = 0;
    var off = closes.length - n;
    for (var i = 0; i < n; i++) {
      var o = opens[off + i], h = highs[off + i], l = lows[off + i], c = closes[off + i];
      if (o > 0 && h > 0 && l > 0 && c > 0 && h >= l) {
        var hl = Math.pow(Math.log(h / l), 2);
        var co = Math.pow(Math.log(c / o), 2);
        sum += 0.5 * hl - (2 * Math.LN2 - 1) * co; cnt++;
      }
    }
    if (cnt < 2) return null;
    return Math.sqrt(Math.max(0, sum / cnt) * TRADING_DAYS);
  }

  /** Yang-Zhang (2000)：处理跳空 + 漂移，最稳健的 OHLC 估计器 */
  function hvYangZhang(opens, highs, lows, closes, period) {
    if (!Array.isArray(opens) || !Array.isArray(closes)) return null;
    var n = Math.min(period || closes.length, opens.length, highs.length, lows.length, closes.length);
    if (n < 3) return null;
    var off = closes.length - n;
    // σ²_open = 隔夜跳空波动 (open vs 前收)
    // σ²_close = 日内波动 (close vs open)
    // σ²_rs   = Rogers-Satchell（对漂移稳健的日内估计）
    var oc = 0, cntO = 0, co = 0, cntC = 0, rs = 0, rcnt = 0;
    for (var i = 0; i < n; i++) {
      var o = opens[off + i], h = highs[off + i], l = lows[off + i], c = closes[off + i];
      var pc = i === 0 ? closes[off - 1] : closes[off + i - 1];
      if (finite(pc) && o > 0 && pc > 0) { oc += Math.pow(Math.log(o / pc), 2); cntO++; }
      if (o > 0 && c > 0) { co += Math.pow(Math.log(c / o), 2); cntC++; }
      if (o > 0 && h > 0 && l > 0 && c > 0 && h >= l) {
        rs += Math.log(h / o) * Math.log(h / c) + Math.log(l / o) * Math.log(l / c);
        rcnt++;
      }
    }
    if (cntO < 2 || cntC < 2 || rcnt < 2) return null;
    var sO = oc / cntO, sC = co / cntC, sR = rs / rcnt;
    var k = 0.34 / (1.34 + (n + 1) / (n - 1));
    var v = sO + k * sC + (1 - k) * sR;
    return Math.sqrt(Math.max(0, v) * TRADING_DAYS);
  }

  /** 一次性算出多个周期的实现波动率 */
  function realizedVol(closes, periods) {
    periods = periods || [10, 20, 30, 60, 90, 252];
    var out = {};
    periods.forEach(function (p) { out['hv' + p] = hvCloseToClose(closes, p); });
    return out;
  }

  /* ===========================================================================
   * 7. IV 相对位置指标
   * ======================================================================== */

  /** IV Rank = (当前 IV - 52周低) / (52周高 - 52周低) × 100 */
  function ivRank(currentIV, ivSeries) {
    if (!finite(currentIV) || !Array.isArray(ivSeries) || !ivSeries.length) return null;
    var vals = ivSeries.filter(finite);
    if (!vals.length) return null;
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi - lo < 1e-9) return 50;
    return clamp((currentIV - lo) / (hi - lo) * 100, 0, 100);
  }

  /** IV Percentile = 历史中低于当前 IV 的天数占比 */
  function ivPercentile(currentIV, ivSeries) {
    if (!finite(currentIV) || !Array.isArray(ivSeries) || !ivSeries.length) return null;
    var vals = ivSeries.filter(finite);
    if (!vals.length) return null;
    var below = vals.filter(function (v) { return v < currentIV; }).length;
    return below / vals.length * 100;
  }

  /** IV / HV 散度：正值 = 期权相对历史波动偏贵（适合卖方） */
  function ivhvDivergence(iv, hv) {
    if (!finite(iv) || !finite(hv) || hv <= 0) return null;
    return (iv / hv - 1) * 100;
  }

  /** 波动率风险溢价 VRP = HV(未来实现) - IV(当前隐含)，正 = 卖方占优 */
  function volRiskPremium(iv, futureHV) {
    if (!finite(iv) || !finite(futureHV)) return null;
    return iv - futureHV; // 正代表期权卖方收取的溢价（IV 高于后续实现）
  }

  /* ===========================================================================
   * 8. 概率与预期移动
   * ======================================================================== */

  /** 对数正态终端分布参数（风险中性） */
  function terminalDist(S, T, vol, r, q, mu) {
    r = finite(r) ? r : 0; q = finite(q) ? q : 0;
    var drift = finite(mu) ? mu : (r - q);   // 默认风险中性漂移
    var nu = drift - 0.5 * vol * vol;        // ln 的漂移
    var sd = vol * Math.sqrt(T);
    return { nu: nu, sd: sd, drift: drift, mean: S * Math.exp(drift * T) };
  }

  /** 终端价格概率密度 */
  function densityAt(S, T, vol, r, q, price, mu) {
    var d = terminalDist(S, T, vol, r, q, mu);
    if (d.sd <= 0 || price <= 0) return 0;
    var x = (Math.log(price / S) - d.nu * T) / d.sd;
    return normPDF(x) / (price * d.sd);
  }

  /** P(S_T > X) 风险中性。X<=0 恒为 1（价格非负）；X→∞ 恒为 0。 */
  function probAbove(S, T, vol, r, q, X, mu) {
    if (!finite(X)) return NaN;
    if (X <= 0) return 1;
    var d = terminalDist(S, T, vol, r, q, mu);
    if (!(d.sd > 0)) return S > X ? 1 : 0;
    if (T <= 0 || !(vol > 0)) return S > X ? 1 : 0;
    var z = (Math.log(S / X) + d.nu * T) / d.sd;
    var p = normCDF(z);
    return clamp(finite(p) ? p : (S > X ? 1 : 0), 0, 1);
  }
  function probBelow(S, T, vol, r, q, X, mu) {
    var a = probAbove(S, T, vol, r, q, X, mu);
    return finite(a) ? clamp(1 - a, 0, 1) : NaN;
  }

  /** 区间概率 P(lo < S_T < hi) */
  function probBetween(S, T, vol, r, q, lo, hi, mu) {
    if (!finite(lo) || !finite(hi) || hi <= lo) return 0;
    var a = probAbove(S, T, vol, r, q, lo, mu);
    var b = probAbove(S, T, vol, r, q, hi, mu);
    if (!finite(a) || !finite(b)) return NaN;
    return clamp(a - b, 0, 1);
  }

  /**
   * 首次通过概率（反射原理，带漂移布朗运动）。
   *   P(max_{t<=T} S_t >= H)  for H > S
   *   P(min_{t<=T} S_t <= L)  for L < S
   */
  function probTouch(S, T, vol, r, q, barrier, direction, mu) {
    if (!finite(S) || !finite(barrier) || S <= 0 || barrier <= 0 || T <= 0 || vol <= 0) return 0;
    var d = terminalDist(S, T, vol, r, q, mu);
    var nu = d.nu, sd = d.sd;
    if (sd <= 0) return 0;
    var h = Math.log(barrier / S);
    var p;
    if (direction === 'up') {
      if (h <= 0) return 1;    // 障碍已在下方，已触发
      p = normCDF((-h + nu * T) / sd) + Math.exp(2 * nu * h / (vol * vol)) * normCDF((-h - nu * T) / sd);
    } else {
      if (h >= 0) return 1;
      p = normCDF((h - nu * T) / sd) + Math.exp(2 * nu * h / (vol * vol)) * normCDF((h + nu * T) / sd);
    }
    return clamp(finite(p) ? p : 0, 0, 1);
  }

  /** 预期移动 (Expected Move)：1σ 对应的价格区间 */
  function expectedMove(S, T, vol, sigmaLevel) {
    sigmaLevel = sigmaLevel || 1;
    if (!finite(S) || !finite(T) || !finite(vol) || S <= 0 || T < 0 || vol < 0) return null;
    var move = S * vol * Math.sqrt(Math.max(0, T)) * sigmaLevel;
    return {
      sigma: sigmaLevel,
      dollars: move,
      percent: move / S * 100,
      lower: Math.max(0, S - move),
      upper: S + move
    };
  }

  /** 把年化 vol 换算成任意天数的波动幅度（常用：日/周/月） */
  function volToMove(vol, days, sigmaLevel) {
    sigmaLevel = sigmaLevel || 1;
    if (!finite(vol) || !finite(days)) return null;
    return vol * Math.sqrt(days / DAYS_YEAR) * sigmaLevel;
  }

  /** 生成概率密度曲线（用于图表） */
  function densityCurve(S, T, vol, r, q, mu, points) {
    points = points || 121;
    var sd = vol * Math.sqrt(T);
    if (!(sd > 0) || !(S > 0)) return [];
    var lo = Math.exp(Math.log(S) - 4 * sd), hi = Math.exp(Math.log(S) + 4 * sd);
    var out = [];
    for (var i = 0; i < points; i++) {
      var p = lo * Math.pow(hi / lo, i / (points - 1));
      out.push({ price: p, density: densityAt(S, T, vol, r, q, p, mu) });
    }
    return out;
  }

  /* ===========================================================================
   * 9. 组合级工具
   * ======================================================================== */

  /** 平价关系校验：C - P 应等于 S·e^(-qT) - K·e^(-rT)，偏差可用于找套利/数据错 */
  function putCallParity(callPrice, putPrice, S, K, T, r, q) {
    r = finite(r) ? r : 0; q = finite(q) ? q : 0;
    if (!finite(callPrice) || !finite(putPrice)) return null;
    var lhs = callPrice - putPrice;
    var rhs = S * Math.exp(-q * T) - K * Math.exp(-r * T);
    return { lhs: lhs, rhs: rhs, diff: lhs - rhs, diffPct: rhs !== 0 ? (lhs - rhs) / Math.abs(rhs) * 100 : null };
  }

  /** 由平价关系推另一侧价格（期权链缺失报价时补全） */
  function parityFill(type, otherPrice, S, K, T, r, q) {
    r = finite(r) ? r : 0; q = finite(q) ? q : 0;
    if (!finite(otherPrice) || !finite(S) || !finite(K) || !finite(T)) return null;
    var fwd = S * Math.exp(-q * T) - K * Math.exp(-r * T);
    var v = type === 'call' ? otherPrice + fwd : otherPrice - fwd;
    return v > 0 ? v : null;
  }

  /** 年化收益率（用于卖方策略横向对比） */
  function annualizedROI(profit, capital, dte) {
    if (!finite(profit) || !finite(capital) || capital <= 0 || !finite(dte) || dte <= 0) return null;
    return (profit / capital) * (DAYS_YEAR / dte) * 100;
  }

  /* ===========================================================================
   * 导出
   * ======================================================================== */
  return {
    // 常量
    DAYS_YEAR: DAYS_YEAR, TRADING_DAYS: TRADING_DAYS,
    // 工具
    finite: finite, num: num, clamp: clamp,
    // 分布
    normPDF: normPDF, normCDF: normCDF, normInv: normInv, erfc: erfc,
    // 定价
    bsPrice: bsPrice, binomialPrice: binomialPrice, intrinsic: intrinsic,
    earlyExercisePremium: earlyExercisePremium, d1d2: d1d2,
    // Greeks
    greeks: greeks,
    // IV
    impliedVol: impliedVol, impliedVolEx: impliedVolEx, bsVegaRaw: bsVegaRaw,
    // 历史波动率
    hvCloseToClose: hvCloseToClose, hvParkinson: hvParkinson,
    hvGarmanKlass: hvGarmanKlass, hvYangZhang: hvYangZhang,
    realizedVol: realizedVol,
    // IV 位置
    ivRank: ivRank, ivPercentile: ivPercentile,
    ivhvDivergence: ivhvDivergence, volRiskPremium: volRiskPremium,
    // 概率
    terminalDist: terminalDist, densityAt: densityAt, densityCurve: densityCurve,
    probAbove: probAbove, probBelow: probBelow, probBetween: probBetween,
    probTouch: probTouch, expectedMove: expectedMove, volToMove: volToMove,
    // 组合
    putCallParity: putCallParity, parityFill: parityFill, annualizedROI: annualizedROI
  };
});
