/* OptionDesk 引擎数值验证 —— 与蒙特卡洛 / 有限差分交叉检验 */
const E = require('../src/engine.js');

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, detail) {
  if (cond) { pass++; results.push(['PASS', name, detail || '']); }
  else { fail++; results.push(['FAIL', name, detail || '']); }
}
function close(a, b, tol) { return Math.abs(a - b) <= tol; }

/* ---------- 1. 正态分布 ---------- */
ok('normCDF(0)=0.5', close(E.normCDF(0), 0.5, 1e-12));
ok('normCDF(1.96)≈0.975', close(E.normCDF(1.959963985), 0.975, 1e-9), E.normCDF(1.959963985));
ok('normCDF(-3)≈0.00135', close(E.normCDF(-3), 0.001349898, 1e-8), E.normCDF(-3));
ok('normInv(normCDF(x))=x', close(E.normInv(E.normCDF(1.234)), 1.234, 1e-8));
ok('normPDF(0)=0.3989', close(E.normPDF(0), 0.3989422804, 1e-9));

/* ---------- 2. Put-Call Parity ---------- */
const S = 357.61, K = 360, T = 45 / 365, r = 0.043, q = 0.007, vol = 0.348;
const c = E.bsPrice('call', S, K, T, vol, r, q);
const p = E.bsPrice('put', S, K, T, vol, r, q);
const par = E.putCallParity(c, p, S, K, T, r, q);
ok('Put-Call 平价成立', Math.abs(par.diff) < 1e-9, 'diff=' + par.diff.toExponential(3));

/* ---------- 3. 二叉树(欧式) 收敛到 BS ---------- */
const binEu = E.binomialPrice('call', S, K, T, vol, r, q, 1500, false);
ok('二叉树(欧式)≈BS', Math.abs(binEu - c) / c < 0.002, `BS=${c.toFixed(4)} Bin=${binEu.toFixed(4)} 误差=${(Math.abs(binEu - c) / c * 100).toFixed(3)}%`);

/* ---------- 4. 美式 >= 欧式 ---------- */
const amPut = E.binomialPrice('put', S, K, 400 / 365, 0.45, 0.05, 0, 300, true);
const euPut = E.binomialPrice('put', S, K, 400 / 365, 0.45, 0.05, 0, 300, false);
ok('美式Put ≥ 欧式Put', amPut >= euPut - 1e-9, `AM=${amPut.toFixed(3)} EU=${euPut.toFixed(3)} 溢价=${(amPut - euPut).toFixed(4)}`);
const amCall = E.binomialPrice('call', S, K, T, vol, r, q, 300, true);
ok('无股息美式Call ≈ 欧式Call', close(E.binomialPrice('call', S, K, T, vol, r, 0, 300, true), E.bsPrice('call', S, K, T, vol, r, 0), 0.05));

/* ---------- 5. 无套利边界 ---------- */
ok('Call ≤ S', c <= S + 1e-9);
ok('Put ≤ K·e^-rT', p <= K * Math.exp(-r * T) + 1e-9);
ok('Call ≥ 内在价值', c >= Math.max(0, S - K) - 1e-9);
// 深度 ITM 欧式 Put 的理论价 ≈ K·e^-rT − S（低于其内在价值 400，因不能立即行权）
const deepPut = E.bsPrice('put', 100, 500, 1, 0.3, 0.05, 0);
ok('深度ITM欧式Put ≈ 贴现远期值', close(deepPut, 500 * Math.exp(-0.05) - 100, 0.5),
  `P=${deepPut.toFixed(2)} 理论=${(500 * Math.exp(-0.05) - 100).toFixed(2)} 内在价值=400`);
ok('深度ITM美式Put = 内在价值', close(E.binomialPrice('put', 100, 500, 1, 0.3, 0.05, 0, 300, true), 400, 0.5),
  '美式可立即行权 → 应等于 400');

/* ---------- 6. IV 反解往返 (round-trip) ---------- */
let rtErr = 0, rtWorst = '', identifiableCount = 0;
const unidentifiable = [];
[[357.61, 300, 634], [357.61, 360, 45], [357.61, 420, 30], [50, 55, 7], [500, 200, 900],
[100, 100, 1], [357.61, 340, 120], [20, 25, 365]].forEach(([s, k, dte]) => {
  ['call', 'put'].forEach(t => {
    [0.05, 0.20, 0.348, 0.65, 1.2].forEach(iv => {
      const T = dte / 365;
      const px = E.bsPrice(t, s, k, T, iv, r, q);
      if (px < 1e-6) return;
      const diag = E.impliedVolEx(t, px, s, k, T, r, q, false);
      // 深度 ITM/OTM 且低 IV 时 Vega≈0，IV 数学上不可辨识 —— 跳过并记录
      if (!diag.identifiable) { unidentifiable.push(`${t} ${s}/${k} ${dte}D iv=${iv} vega=${diag.vega.toExponential(1)}`); return; }
      if (diag.iv === null) { rtErr = 999; rtWorst = `null @${t} ${s}/${k} ${dte}d iv=${iv}`; return; }
      const e = Math.abs(diag.iv - iv);
      identifiableCount++;
      if (e > rtErr) { rtErr = e; rtWorst = `${t} S=${s} K=${k} ${dte}DTE 真=${iv} 反解=${diag.iv.toFixed(6)}`; }
    });
  });
});
ok('IV 反解往返误差 < 1e-6', rtErr < 1e-6, `可辨识样本 ${identifiableCount} 个，最差: ${rtWorst}`);
ok('Vega≈0 的合约被正确标记为不可辨识', unidentifiable.length > 0,
  `标记 ${unidentifiable.length} 个: ${unidentifiable[0] || '—'}`);
// 不可辨识的合约必须被标记，而不是静默返回一个看似正常的假 IV
ok('不可辨识合约不会静默返回正常值',
  !E.impliedVolEx('put', E.bsPrice('put', 357.61, 420, 30 / 365, 0.05, r, q), 357.61, 420, 30 / 365, r, q, false).identifiable);

/* ---------- 7. Greeks vs 有限差分 ---------- */
function fd(type, fn, S0, h) { return (fn(S0 + h) - fn(S0 - h)) / (2 * h); }
const g = E.greeks('call', S, K, T, vol, r, q);
const dS = 0.01;
const fdDelta = fd('call', s => E.bsPrice('call', s, K, T, vol, r, q), S, dS);
ok('Delta ≈ 有限差分', close(g.delta, fdDelta, 2e-4), `解析=${g.delta.toFixed(6)} FD=${fdDelta.toFixed(6)}`);

const fdGamma = (E.bsPrice('call', S + dS, K, T, vol, r, q) - 2 * c + E.bsPrice('call', S - dS, K, T, vol, r, q)) / (dS * dS);
ok('Gamma ≈ 有限差分', close(g.gamma, fdGamma, 1e-5), `解析=${g.gamma.toFixed(8)} FD=${fdGamma.toFixed(8)}`);

const dv = 0.0001;
const fdVega = (E.bsPrice('call', S, K, T, vol + dv, r, q) - E.bsPrice('call', S, K, T, vol - dv, r, q)) / (2 * dv) / 100;
ok('Vega(每1%) ≈ 有限差分', close(g.vega, fdVega, 1e-5), `解析=${g.vega.toFixed(6)} FD=${fdVega.toFixed(6)}`);

const dT = 1 / 365 / 100;
const fdTheta = -(E.bsPrice('call', S, K, T + dT, vol, r, q) - E.bsPrice('call', S, K, T - dT, vol, r, q)) / (2 * dT) / 365;
ok('Theta(每日) ≈ 有限差分', close(g.theta, fdTheta, 1e-4), `解析=${g.theta.toFixed(6)} FD=${fdTheta.toFixed(6)}`);

const dr = 1e-6;
const fdRho = (E.bsPrice('call', S, K, T, vol, r + dr, q) - E.bsPrice('call', S, K, T, vol, r - dr, q)) / (2 * dr) / 100;
ok('Rho(每1%) ≈ 有限差分', close(g.rho, fdRho, 1e-5), `解析=${g.rho.toFixed(6)} FD=${fdRho.toFixed(6)}`);

// 二阶：Vanna = dDelta/dvol
const fdVanna = (E.greeks('call', S, K, T, vol + dv, r, q).delta - E.greeks('call', S, K, T, vol - dv, r, q).delta) / (2 * dv) / 100;
ok('Vanna ≈ 有限差分', close(g.vanna, fdVanna, 5e-3), `解析=${g.vanna.toFixed(8)} FD=${fdVanna.toFixed(8)}`);

// 二阶：Vomma = dVega/dvol
const fdVomma = (E.greeks('call', S, K, T, vol + dv, r, q).vega - E.greeks('call', S, K, T, vol - dv, r, q).vega) / (2 * dv);
ok('Vomma ≈ 有限差分', close(g.vomma, fdVomma, 5e-3), `解析=${g.vomma.toFixed(8)} FD=${fdVomma.toFixed(8)}`);

// 二阶：Charm = dDelta/dt (每日)
const fdCharm = (E.greeks('call', S, K, T + dT, vol, r, q).delta - E.greeks('call', S, K, T - dT, vol, r, q).delta) / (2 * dT) / 365;
ok('Charm ≈ 有限差分', close(g.charm, fdCharm, 5e-3), `解析=${g.charm.toFixed(8)} FD=${fdCharm.toFixed(8)}`);

// Put Greeks 一致性：Put Delta = Call Delta - e^{-qT}
const gp = E.greeks('put', S, K, T, vol, r, q);
ok('Put Delta = Call Delta - e^(-qT)', close(gp.delta, g.delta - Math.exp(-q * T), 1e-12));
ok('Put Gamma = Call Gamma', close(gp.gamma, g.gamma, 1e-15));
ok('Put Vega = Call Vega', close(gp.vega, g.vega, 1e-15));

/* ---------- 8. 概率 vs 蒙特卡洛 ---------- */
function mcProbAbove(S0, T, v, r0, q0, X, paths) {
  let hit = 0;
  const dt = T, sd = v * Math.sqrt(T), nu = (r0 - q0 - 0.5 * v * v) * T;
  for (let i = 0; i < paths; i++) {
    // Box-Muller
    const u1 = Math.random() || 1e-9, u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    if (S0 * Math.exp(nu + sd * z) > X) hit++;
  }
  return hit / paths;
}
const mcA = mcProbAbove(S, T, vol, r, q, 380, 400000);
const anA = E.probAbove(S, T, vol, r, q, 380);
ok('P(S_T>380) ≈ 蒙特卡洛', Math.abs(mcA - anA) < 0.005, `解析=${(anA * 100).toFixed(2)}% MC=${(mcA * 100).toFixed(2)}%`);

// P(ITM) 应等于 N(d2)
ok('P(ITM call) = N(d2)', close(E.greeks('call', S, K, T, vol, r, q).probITM, E.normCDF(E.greeks('call', S, K, T, vol, r, q).d2), 1e-12));

// 概率归一性
const band = E.probBetween(S, T, vol, r, q, 0, 1e9);
ok('全区间概率 = 1', close(band, 1, 1e-9), String(band));

/* ---------- 9. probTouch vs 蒙特卡洛（路径最大值 + 布朗桥修正） ---------- */
// 离散步长的 MC 会系统性低估首次通过概率（漏掉步间穿越），
// 因此加入 Brownian bridge 修正，使离散模拟与连续时间解析解可比。
function mcTouchUp(S0, T, v, r0, q0, H, paths, steps) {
  let hit = 0;
  const dt = T / steps, sd = v * Math.sqrt(dt), nu = (r0 - q0 - 0.5 * v * v) * dt;
  const vv = v * v * dt;
  for (let i = 0; i < paths; i++) {
    let s = S0, touched = false, pHit = 1;
    for (let j = 0; j < steps; j++) {
      const u1 = Math.random() || 1e-9, u2 = Math.random();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const sNext = s * Math.exp(nu + sd * z);
      if (s >= H || sNext >= H) { touched = true; break; }
      // 布朗桥：未触及条件下，步间穿越 H 的概率
      const a = Math.log(H / s), b = Math.log(H / sNext);
      pHit *= (1 - Math.exp(-2 * a * b / vv));
      if (pHit < 1e-12) { /* 提前收敛 */ }
      s = sNext;
    }
    if (!touched) {
      // 未在任何节点触及，用累积的"未穿越概率"判断是否曾在步间穿越
      if (Math.random() < 1 - pHit) hit++;
    } else hit++;
  }
  return hit / paths;
}
// 无漂移情形下 probTouch 应约等于 2×P(ITM)（反射原理的经典结论）
const noDriftR = 0.5 * vol * vol; // 令 r-q = σ²/2 → ln 漂移 ν = 0
const ptUp = E.probTouch(S, T, vol, noDriftR, 0, 400, 'up');
const pITM400 = E.probAbove(S, T, vol, noDriftR, 0, 400);
ok('无漂移时 P(touch) ≈ 2×P(ITM)', close(ptUp, 2 * pITM400, 1e-6), `touch=${(ptUp * 100).toFixed(3)}% 2×ITM=${(2 * pITM400 * 100).toFixed(3)}%`);

const mcT = mcTouchUp(S, T, vol, noDriftR, 0, 400, 60000, 90);
ok('P(touch up 400) ≈ 蒙特卡洛(路径)', Math.abs(mcT - ptUp) < 0.02, `解析=${(ptUp * 100).toFixed(2)}% MC=${(mcT * 100).toFixed(2)}%`);

const ptDn = E.probTouch(S, T, vol, noDriftR, 0, 320, 'down');
const mcTDn = (function () {
  let hit = 0; const paths = 60000, steps = 90;
  const dt = T / steps, sd = vol * Math.sqrt(dt), nu = (noDriftR - 0 - 0.5 * vol * vol) * dt;
  const vv = vol * vol * dt;
  for (let i = 0; i < paths; i++) {
    let s = S, t = false, pHit = 1;
    for (let j = 0; j < steps; j++) {
      const u1 = Math.random() || 1e-9, u2 = Math.random();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const sNext = s * Math.exp(nu + sd * z);
      if (s <= 320 || sNext <= 320) { t = true; break; }
      const a = Math.log(320 / s), b = Math.log(320 / sNext);
      pHit *= (1 - Math.exp(-2 * a * b / vv));
      s = sNext;
    }
    if (t || Math.random() < 1 - pHit) hit++;
  }
  return hit / paths;
})();
ok('P(touch down 320) ≈ 蒙特卡洛(路径)', Math.abs(mcTDn - ptDn) < 0.02, `解析=${(ptDn * 100).toFixed(2)}% MC=${(mcTDn * 100).toFixed(2)}%`);

/* ---------- 10. 历史波动率 ---------- */
// 构造已知波动率的几何布朗运动
function genGBM(S0, v, days, seed) {
  let s = S0, out = [S0];
  let st = seed || 12345;
  const rnd = () => { st = (st * 1103515245 + 12345) & 0x7fffffff; return st / 0x7fffffff; };
  for (let i = 0; i < days; i++) {
    const u1 = rnd() || 1e-9, u2 = rnd();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    s *= Math.exp((-0.5 * v * v) / 252 + v * Math.sqrt(1 / 252) * z);
    out.push(s);
  }
  return out;
}
const series = genGBM(100, 0.40, 600, 999);
const hv20 = E.hvCloseToClose(series, 20);
const hv252 = E.hvCloseToClose(series, 252);
ok('HV20 落在合理区间 (0.15~0.75)', hv20 > 0.15 && hv20 < 0.75, 'HV20=' + (hv20 * 100).toFixed(2) + '%');
ok('HV252 逼近真实 vol 40%', Math.abs(hv252 - 0.40) < 0.06, 'HV252=' + (hv252 * 100).toFixed(2) + '% (真值40%)');

// 其余 OHLC 估计器必须同样可用（曾因变量名笔误在运行期崩溃）
(function () {
  const o = [], h = [], l = [], c = [];
  let s = 100, st = 4242;
  const rnd = () => { st = (st * 1103515245 + 12345) & 0x7fffffff; return st / 0x7fffffff; };
  for (let i = 0; i < 300; i++) {
    const op = s;
    const u1 = rnd() || 1e-9, u2 = rnd();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    s *= Math.exp((-0.5 * 0.36 * 0.36) / 252 + 0.36 * Math.sqrt(1 / 252) * z);
    o.push(op); c.push(s);
    h.push(Math.max(op, s) * (1 + rnd() * 0.01));
    l.push(Math.min(op, s) * (1 - rnd() * 0.01));
  }
  const p = E.hvParkinson(h, l, 252);
  const gk = E.hvGarmanKlass(o, h, l, c, 252);
  const yz = E.hvYangZhang(o, h, l, c, 252);
  ok('Parkinson 估计器可用', p !== null && p > 0.1 && p < 0.9, 'HV=' + (p * 100).toFixed(2) + '% (真值36%)');
  ok('Garman-Klass 估计器可用', gk !== null && gk > 0.1 && gk < 0.9, 'HV=' + (gk * 100).toFixed(2) + '%');
  ok('Yang-Zhang 估计器可用', yz !== null && yz > 0.1 && yz < 0.9, 'HV=' + (yz * 100).toFixed(2) + '%');
  ok('realizedVol 批量返回各周期', (function () {
    const r = E.realizedVol(c, [10, 20, 60]);
    return r.hv10 !== null && r.hv20 !== null && r.hv60 !== null;
  })());
})();

/* ---------- 11. IV Rank / Percentile ---------- */
const ivSeries = Array.from({ length: 252 }, (_, i) => 30 + 20 * Math.sin(i / 20) + (i % 7));
const curIV = 34.8;
const rank = E.ivRank(curIV, ivSeries);
const pct = E.ivPercentile(curIV, ivSeries);
ok('IV Rank ∈ [0,100]', rank >= 0 && rank <= 100, 'IV Rank=' + rank.toFixed(1));
ok('IV Percentile ∈ [0,100]', pct >= 0 && pct <= 100, 'IV Percentile=' + pct.toFixed(1));
const lo = Math.min(...ivSeries), hi = Math.max(...ivSeries);
ok('IV Rank 公式正确', close(rank, (curIV - lo) / (hi - lo) * 100, 1e-9), `手算=${((curIV - lo) / (hi - lo) * 100).toFixed(2)}`);
ok('IV Rank 边界=0', close(E.ivRank(lo, ivSeries), 0, 1e-12));
ok('IV Rank 边界=100', close(E.ivRank(hi, ivSeries), 100, 1e-12));

/* ---------- 12. 预期移动 ---------- */
const em = E.expectedMove(S, 30 / 365, 0.348, 1);
ok('1σ 预期移动 = S·σ·√T', close(em.dollars, S * 0.348 * Math.sqrt(30 / 365), 1e-9), `±${em.dollars.toFixed(2)} (${em.percent.toFixed(2)}%)`);
ok('±1σ 区间含约68%概率', close(E.probBetween(S, 30 / 365, 0.348, 0, 0, em.lower, em.upper), 0.683, 0.01),
  `实际=${(E.probBetween(S, 30 / 365, 0.348, 0, 0, em.lower, em.upper) * 100).toFixed(2)}%`);

/* ---------- 13. 退化与边界（原站最容易崩的地方） ---------- */
ok('T=0 不崩', close(E.bsPrice('call', 100, 90, 0, 0.3, 0.05, 0), 10, 1e-12));
// vol=0 → 确定性贴现远期：call = S − K·e^-rT
ok('vol=0 用贴现远期而非内在价值',
  close(E.bsPrice('call', 100, 90, 1, 0, 0.05, 0), 100 - 90 * Math.exp(-0.05), 1e-9),
  `P=${E.bsPrice('call', 100, 90, 1, 0, 0.05, 0).toFixed(4)} 期望=${(100 - 90 * Math.exp(-0.05)).toFixed(4)}`);
ok('极小 vol 不崩', isFinite(E.bsPrice('call', 100, 100, 1, 1e-8, 0.05, 0)));
ok('深度 OTM 不返回 NaN', isFinite(E.bsPrice('call', 100, 500, 0.5, 0.3, 0.05, 0)));
ok('超大 vol 不崩', isFinite(E.bsPrice('call', 100, 100, 1, 3, 0.05, 0)));
const gEdge = E.greeks('call', 100, 100, 0, 0.3, 0.05, 0);
ok('T=0 的 Greeks 不返回 NaN', isFinite(gEdge.delta) && isFinite(gEdge.theta));
ok('parityFill 平价补全正确', close(E.parityFill('put', c, S, K, T, r, q), p, 1e-9));

/* ---------- 输出 ---------- */
console.log('\n' + '='.repeat(78));
results.forEach(r => {
  const tag = r[0] === 'PASS' ? '  ✓' : '  ✗';
  console.log(tag + ' ' + r[1].padEnd(38) + (r[2] ? '  ' + r[2] : ''));
});
console.log('='.repeat(78));
console.log(`通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
