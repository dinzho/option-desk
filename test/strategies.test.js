/* 策略引擎验证：与闭式解 / 已知结论对照 */
const E = require('../src/engine.js');
const St = require('../src/strategies.js');

let pass = 0, fail = 0; const out = [];
function ok(name, cond, detail) { cond ? pass++ : fail++; out.push([cond, name, detail || '']); }
function close(a, b, tol) { return Math.abs(a - b) <= tol; }

const spot = 357.61, rate = 0.043, div = 0.007, iv = 0.348;
const opts = { rate, dividend: div };
const L = (o) => St.makeLeg(o);

/* ---------- 1. 单腿 Long Call ---------- */
{
  const K = 360, dte = 45;
  const px = E.bsPrice('call', spot, K, dte / 365, iv, rate, div);
  const legs = [L({ kind: 'call', side: 1, strike: K, dte, qty: 1, price: px, iv })];
  const p = St.riskProfile(legs, spot, opts);
  ok('LongCall 最大亏损 = 权利金', close(p.maxLoss, -px * 100, 0.01), `${p.maxLoss.toFixed(2)} vs ${(-px * 100).toFixed(2)}`);
  ok('LongCall 盈利无限', p.unlimitedProfit === true);
  ok('LongCall 平衡点 = K + 权利金', close(p.breakevens[0], K + px, 0.05), `BE=${p.breakevens[0].toFixed(3)} 期望=${(K + px).toFixed(3)}`);
  ok('LongCall 净权利金为负(debit)', close(St.netPremium(legs), -px * 100, 1e-6));
}

/* ---------- 2. 单腿 Short Put (CSP) ---------- */
{
  const K = 340, dte = 45;
  const px = E.bsPrice('put', spot, K, dte / 365, iv, rate, div);
  const legs = [L({ kind: 'put', side: -1, strike: K, dte, qty: 1, price: px, iv })];
  const p = St.riskProfile(legs, spot, opts);
  ok('CSP 最大盈利 = 权利金', close(p.maxProfit, px * 100, 0.01), `${p.maxProfit.toFixed(2)} vs ${(px * 100).toFixed(2)}`);
  // 最大亏损 = (K - 0) - premium，即标的归零
  ok('CSP 最大亏损 = K - 权利金(归零)', close(p.maxLoss, -(K - px) * 100, 0.01), `${p.maxLoss.toFixed(2)} vs ${(-(K - px) * 100).toFixed(2)}`);
  ok('CSP 平衡点 = K - 权利金', close(p.breakevens[0], K - px, 0.05), `BE=${p.breakevens[0].toFixed(3)} 期望=${(K - px).toFixed(3)}`);
  ok('CSP 净权利金为正(credit)', close(St.netPremium(legs), px * 100, 1e-6));
}

/* ---------- 3. Bull Call Spread（闭式解） ---------- */
{
  const K1 = 350, K2 = 370, dte = 45, T = dte / 365;
  const p1 = E.bsPrice('call', spot, K1, T, iv, rate, div);
  const p2 = E.bsPrice('call', spot, K2, T, iv, rate, div);
  const debit = (p1 - p2) * 100;
  const legs = [
    L({ kind: 'call', side: 1, strike: K1, dte, qty: 1, price: p1, iv }),
    L({ kind: 'call', side: -1, strike: K2, dte, qty: 1, price: p2, iv })
  ];
  const p = St.riskProfile(legs, spot, opts);
  ok('牛市价差 最大亏损 = 净支出', close(p.maxLoss, -debit, 0.01), `${p.maxLoss.toFixed(2)} vs ${(-debit).toFixed(2)}`);
  ok('牛市价差 最大盈利 = 价差宽度 - 净支出', close(p.maxProfit, (K2 - K1) * 100 - debit, 0.01),
    `${p.maxProfit.toFixed(2)} vs ${((K2 - K1) * 100 - debit).toFixed(2)}`);
  ok('牛市价差 无无限风险', !p.unlimitedLoss && !p.unlimitedProfit);
  ok('牛市价差 平衡点 = K1 + 净支出/100', close(p.breakevens[0], K1 + debit / 100, 0.05),
    `BE=${p.breakevens[0].toFixed(3)} 期望=${(K1 + debit / 100).toFixed(3)}`);
}

/* ---------- 4. 裸卖 Call → 必须识别为无限风险 ---------- */
{
  const K = 400, dte = 45;
  const px = E.bsPrice('call', spot, K, dte / 365, iv, rate, div);
  const legs = [L({ kind: 'call', side: -1, strike: K, dte, qty: 1, price: px, iv })];
  const p = St.riskProfile(legs, spot, opts);
  ok('裸卖Call 识别为无限亏损', p.unlimitedLoss === true && p.maxLoss === null);
  ok('裸卖Call 最大盈利 = 权利金', close(p.maxProfit, px * 100, 0.01));
}

/* ---------- 5. Iron Condor：四腿、双平衡点、有限风险 ---------- */
{
  const dte = 45, T = dte / 365;
  const K = [320, 335, 380, 395]; // 买put / 卖put / 卖call / 买call
  const pr = K.map((k, i) => E.bsPrice(i < 2 ? 'put' : 'call', spot, k, T, iv, rate, div));
  const legs = [
    L({ kind: 'put', side: 1, strike: K[0], dte, qty: 1, price: pr[0], iv }),
    L({ kind: 'put', side: -1, strike: K[1], dte, qty: 1, price: pr[1], iv }),
    L({ kind: 'call', side: -1, strike: K[2], dte, qty: 1, price: pr[2], iv }),
    L({ kind: 'call', side: 1, strike: K[3], dte, qty: 1, price: pr[3], iv })
  ];
  const p = St.riskProfile(legs, spot, opts);
  const credit = (pr[1] + pr[2] - pr[0] - pr[3]) * 100;
  ok('铁鹰 净收入 = credit', close(St.netPremium(legs), credit, 1e-6), `${St.netPremium(legs).toFixed(2)}`);
  ok('铁鹰 最大盈利 = credit', close(p.maxProfit, credit, 0.01), `${p.maxProfit.toFixed(2)} vs ${credit.toFixed(2)}`);
  const wingWidth = (K[1] - K[0]) * 100;
  ok('铁鹰 最大亏损 = 翼宽 - credit', close(p.maxLoss, -(wingWidth - credit), 0.01),
    `${p.maxLoss.toFixed(2)} vs ${(-(wingWidth - credit)).toFixed(2)}`);
  ok('铁鹰 风险有限', !p.unlimitedLoss && !p.unlimitedProfit);
  ok('铁鹰 两个平衡点', p.breakevens.length === 2, `BE=[${p.breakevens.map(b => b.toFixed(2)).join(', ')}]`);
  ok('铁鹰 下平衡点 = 卖putK - credit/100', close(p.breakevens[0], K[1] - credit / 100, 0.05),
    `${p.breakevens[0].toFixed(3)} 期望=${(K[1] - credit / 100).toFixed(3)}`);
  ok('铁鹰 上平衡点 = 卖callK + credit/100', close(p.breakevens[1], K[2] + credit / 100, 0.05),
    `${p.breakevens[1].toFixed(3)} 期望=${(K[2] + credit / 100).toFixed(3)}`);
}

/* ---------- 6. Covered Call：含股票腿 ---------- */
{
  const K = 370, dte = 45;
  const px = E.bsPrice('call', spot, K, dte / 365, iv, rate, div);
  const legs = [
    L({ kind: 'stock', side: 1, qty: 100, price: spot, dte }),
    L({ kind: 'call', side: -1, strike: K, dte, qty: 1, price: px, iv })
  ];
  const p = St.riskProfile(legs, spot, opts);
  ok('备兑 最大盈利 = (K - S) + 权利金', close(p.maxProfit, (K - spot) * 100 + px * 100, 0.01),
    `${p.maxProfit.toFixed(2)} vs ${((K - spot) * 100 + px * 100).toFixed(2)}`);
  ok('备兑 下行风险 = 持股成本 - 权利金', close(p.maxLoss, -(spot - px) * 100, 0.01),
    `${p.maxLoss.toFixed(2)} vs ${(-(spot - px) * 100).toFixed(2)}`);
  ok('备兑 平衡点 = 成本 - 权利金', close(p.breakevens[0], spot - px, 0.05), `${p.breakevens[0].toFixed(3)}`);
  const g = St.positionGreeks(legs, spot, rate, div);
  const callDelta = E.greeks('call', spot, K, dte / 365, iv, rate, div).delta;
  ok('备兑 Delta = 100 - 100×CallDelta', close(g.delta, 100 - 100 * callDelta, 1e-9),
    `${g.delta.toFixed(4)} 期望=${(100 - 100 * callDelta).toFixed(4)}`);
}

/* ---------- 7. Greeks 汇总：可加性 ---------- */
{
  const dte = 45, T = dte / 365;
  const legs = [
    L({ kind: 'call', side: 1, strike: 350, dte, qty: 2, price: 20, iv }),
    L({ kind: 'put', side: -1, strike: 340, dte, qty: 1, price: 8, iv })
  ];
  const g = St.positionGreeks(legs, spot, rate, div);
  const g1 = E.greeks('call', spot, 350, T, iv, rate, div);
  const g2 = E.greeks('put', spot, 340, T, iv, rate, div);
  ok('组合 Delta = 2×100×Δcall − 1×100×Δput', close(g.delta, 2 * 100 * g1.delta - 100 * g2.delta, 1e-9),
    `${g.delta.toFixed(4)}`);
  ok('组合 Vega 可加', close(g.vega, 2 * 100 * g1.vega - 100 * g2.vega, 1e-9));
  ok('组合 Gamma 可加', close(g.gamma, 2 * 100 * g1.gamma - 100 * g2.gamma, 1e-9));
}

/* ---------- 8. 时间演化：到期时 T+n 曲线应收敛到到期曲线 ---------- */
{
  const K = 360, dte = 45;
  const px = E.bsPrice('call', spot, K, dte / 365, iv, rate, div);
  const legs = [L({ kind: 'call', side: 1, strike: K, dte, qty: 1, price: px, iv })];
  const atExpiry = St.positionValue(legs, 400, 1e9, opts).pnl;
  const atDte45 = St.positionValue(legs, 400, 45, opts).pnl;
  ok('到期损益 = 内在价值 - 成本', close(atExpiry, (400 - K) * 100 - px * 100, 0.01), `${atExpiry.toFixed(2)}`);
  ok('T+45(即到期) 与到期曲线一致', close(atDte45, atExpiry, 1e-6), `${atDte45.toFixed(4)} vs ${atExpiry.toFixed(4)}`);
  // 未到期时，时间价值应使价格高于内在价值
  const atT0 = St.positionValue(legs, 400, 0, opts).pnl;
  ok('T+0 含时间价值 > 到期值', atT0 > atExpiry, `T+0=${atT0.toFixed(2)} 到期=${atExpiry.toFixed(2)}`);
}

/* ---------- 9. IV 偏移的影响 ---------- */
{
  const K = 360, dte = 45;
  const px = E.bsPrice('call', spot, K, dte / 365, iv, rate, div);
  const longLegs = [L({ kind: 'call', side: 1, strike: K, dte, qty: 1, price: px, iv })];
  const up = St.positionValue(longLegs, spot, 0, Object.assign({ ivShift: 10 }, opts)).pnl;
  const base = St.positionValue(longLegs, spot, 0, opts).pnl;
  ok('Long Call: IV 上升 → 盈利增加', up > base, `IV+10=${up.toFixed(2)} 基准=${base.toFixed(2)}`);
  const shortLegs = [L({ kind: 'call', side: -1, strike: K, dte, qty: 1, price: px, iv })];
  const sUp = St.positionValue(shortLegs, spot, 0, Object.assign({ ivShift: 10 }, opts)).pnl;
  const sBase = St.positionValue(shortLegs, spot, 0, opts).pnl;
  ok('Short Call: IV 上升 → 亏损增加', sUp < sBase, `IV+10=${sUp.toFixed(2)} 基准=${sBase.toFixed(2)}`);
  // Vega 一致性：ΔPnL ≈ vega × 10
  const vega = St.positionGreeks(longLegs, spot, rate, div).vega;
  ok('IV 偏移的 PnL 变化 ≈ Vega × 位移', Math.abs((up - base) - vega * 10) < Math.abs(vega * 10) * 0.05,
    `实际=${(up - base).toFixed(2)} Vega×10=${(vega * 10).toFixed(2)}`);
}

/* ---------- 10. 概率分析：POP 合理性 ---------- */
{
  const dte = 45, T = dte / 365;
  const K = 340;
  const px = E.bsPrice('put', spot, K, T, iv, rate, div);
  const csp = [L({ kind: 'put', side: -1, strike: K, dte, qty: 1, price: px, iv })];
  const pa = St.probabilityAnalysis(csp, spot, opts);
  ok('CSP 的 POP ∈ (0,1)', pa.pop > 0 && pa.pop < 1, `POP=${(pa.pop * 100).toFixed(2)}%`);
  // 深 OTM 卖 put 的 POP 应显著高于 50%
  ok('深OTM CSP 的 POP > 60%', pa.pop > 0.60, `POP=${(pa.pop * 100).toFixed(2)}%`);
  // 卖方的 EV 在风险中性测度下应接近 0（无套利定价的必然结果）
  ok('风险中性测度下 EV ≈ 0', Math.abs(pa.ev) < Math.abs(px * 100) * 0.15,
    `EV=$${pa.ev.toFixed(2)} 权利金=$${(px * 100).toFixed(2)}`);
  const deepOTM = [L({ kind: 'put', side: -1, strike: 250, dte, qty: 1, price: E.bsPrice('put', spot, 250, T, iv, rate, div), iv })];
  const paDeep = St.probabilityAnalysis(deepOTM, spot, opts);
  ok('越深 OTM 的 POP 越高', paDeep.pop > pa.pop, `深度=${(paDeep.pop * 100).toFixed(2)}% vs 浅=${(pa.pop * 100).toFixed(2)}%`);
}

/* ---------- 11. 模板库完整性 ---------- */
{
  const ids = St.TEMPLATES.map(t => t.id);
  ok('模板数量 ≥ 20', St.TEMPLATES.length >= 20, `${St.TEMPLATES.length} 个模板`);
  ok('模板 id 无重复', new Set(ids).size === ids.length);
  let bad = [];
  St.TEMPLATES.forEach(t => {
    const ctx = { spot, dte: 45, dte2: 400, qty: 1, iv, rate, dividend: div, widthPct: 5, wingPct: 5 };
    const legs = St.buildTemplate(t.id, ctx);
    if (!legs || !legs.length) { bad.push(t.id + ':空'); return; }
    const p = St.riskProfile(legs, spot, opts);
    if (!p) { bad.push(t.id + ':无法定价'); return; }
    if (!isFinite(p.maxProfit !== null ? p.maxProfit : 0) || !isFinite(p.maxLoss !== null ? p.maxLoss : 0)) bad.push(t.id + ':NaN');
    // 每条腿的行权价必须为正
    legs.forEach(l => { if (l.kind !== 'stock' && (l.strike === null || l.strike <= 0)) bad.push(t.id + ':行权价异常'); });
    // 权利金必须非负
    legs.forEach(l => { if (l.price < 0) bad.push(t.id + ':负价格'); });
  });
  ok('全部模板可正确构建与定价', bad.length === 0, bad.slice(0, 5).join(' | ') || '无异常');

  // 每个模板的腿数应与声明一致
  const mismatch = St.TEMPLATES.filter(t => St.buildTemplate(t.id, { spot, dte: 45, dte2: 400, qty: 1, iv, rate, dividend: div, widthPct: 5 }).length !== t.legs);
  ok('模板腿数与声明一致', mismatch.length === 0, mismatch.map(t => t.id).join(',') || '');
}

/* ---------- 12. 结构评分 ---------- */
{
  const dte = 45, T = dte / 365;
  const mk = (k, side, kind) => L({ kind, side, strike: k, dte, qty: 1, price: E.bsPrice(kind, spot, k, T, iv, rate, div), iv });
  const condor = [mk(320, 1, 'put'), mk(335, -1, 'put'), mk(380, -1, 'call'), mk(395, 1, 'call')];
  const s = St.scoreStructure(condor, spot, opts);
  ok('评分 ∈ [0,100]', s.score >= 0 && s.score <= 100, `score=${s.score.toFixed(1)} (${s.label})`);
  ok('评分含各分项', s.components.length >= 6, s.components.map(c => `${c.name}:${c.tier}`).join(' '));
  // 极端糟糕的结构应得低分：深度 OTM 买 leg，几乎必亏
  const junk = [L({ kind: 'call', side: 1, strike: 600, dte: 3, qty: 1, price: 0.05, iv })];
  const sj = St.scoreStructure(junk, spot, opts);
  ok('垃圾结构评分偏低', sj.score < s.score, `垃圾=${sj.score.toFixed(1)} vs 铁鹰=${s.score.toFixed(1)}`);
}

/* ---------- 13. 矩阵与热力图 ---------- */
{
  const dte = 45;
  const px = E.bsPrice('call', spot, 360, dte / 365, iv, rate, div);
  const legs = [L({ kind: 'call', side: 1, strike: 360, dte, qty: 1, price: px, iv })];
  const m1 = St.matrix(legs, spot, Object.assign({ mode: 'time', rows: 11, cols: 6 }, opts));
  ok('时间矩阵 维度正确', m1.rows.length === 11 && m1.cols.length === 6);
  ok('时间矩阵 首行股价最高', m1.rows[0].stock > m1.rows[10].stock, `${m1.rows[0].stock.toFixed(1)} > ${m1.rows[10].stock.toFixed(1)}`);
  ok('时间矩阵 无 NaN', m1.rows.every(r => r.cells.every(c => isFinite(c.value))));
  const m2 = St.matrix(legs, spot, Object.assign({ mode: 'iv', rows: 11, cols: 7, ivSpan: 20 }, opts));
  ok('IV 矩阵 无 NaN', m2.rows.every(r => r.cells.every(c => isFinite(c.value))));
  // Long Call：IV 越高越有利，最右列(IV+20)应优于最左列(IV-20)
  const midRow = m2.rows[5];
  ok('Long Call: IV 上升 → 估值提升', midRow.cells[6].value > midRow.cells[0].value,
    `IV-20=${midRow.cells[0].value.toFixed(1)} IV+20=${midRow.cells[6].value.toFixed(1)}`);
}

/* ---------- 14. 边界与健壮性 ---------- */
{
  ok('空组合返回 null', St.riskProfile([], spot, opts) === null);
  const zeroDte = [L({ kind: 'call', side: 1, strike: 360, dte: 0, qty: 1, price: 5, iv })];
  const pz = St.riskProfile(zeroDte, spot, opts);
  ok('DTE=0 不崩', pz && isFinite(pz.maxLoss), `maxLoss=${pz && pz.maxLoss}`);
  const noIV = [L({ kind: 'call', side: 1, strike: 360, dte: 45, qty: 1, price: 5, iv: null })];
  const pn = St.riskProfile(noIV, spot, opts);
  ok('缺 IV 时不崩（退化为内在价值）', pn && isFinite(pn.maxLoss));
  const manyQty = [L({ kind: 'call', side: 1, strike: 360, dte: 45, qty: 1000, price: 5, iv })];
  const pm = St.riskProfile(manyQty, spot, opts);
  ok('大数量不溢出', pm && isFinite(pm.maxLoss) && isFinite(pm.maxProfit));
}

/* ---------- 输出 ---------- */
console.log('\n' + '='.repeat(84));
out.forEach(r => console.log((r[0] ? '  ✓ ' : '  ✗ ') + r[1].padEnd(40) + (r[2] ? '  ' + r[2] : '')));
console.log('='.repeat(84));
console.log(`通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
