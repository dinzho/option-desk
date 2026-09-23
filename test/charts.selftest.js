/* charts.js 自測：無 jsdom，用 {innerHTML} stub 驗證不拋異常且產出合法 SVG */
var OC = require('/workspace/options-desk/src/charts.js')
var FNS = ['renderPayoff', 'renderMultiCurve', 'renderHeatmap', 'renderTermStructure',
  'renderSkew', 'renderDistribution', 'renderGreeksBars', 'renderIVHistory']

var pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}
function run(name, fn, data, opts) {
  var el = { innerHTML: '' }
  try {
    var out = fn(el, data, opts)
    var svg = el.innerHTML
    var valid = typeof svg === 'string' && svg.indexOf('<svg') === 0 && svg.indexOf('</svg>') > 0
    ok(name, valid && svg === out, valid ? '' : 'SVG 不合法')
    if (/NaN|Infinity|undefined/.test(svg.replace(/undefined-/g, ''))) ok(name + ' 無 NaN 座標', false, svg.match(/.{0,40}(NaN|Infinity).{0,20}/))
    else ok(name + ' 無 NaN 座標', true)
    return svg
  } catch (e) {
    ok(name, false, e.message)
    return ''
  }
}

/* 全 NaN / 長度 0 的資料契約 */
var NaN_DATA = {
  renderPayoff: { spot: NaN, points: [{ stock: NaN, pnl: NaN }, { stock: NaN, pnl: NaN }], breakevens: [NaN], maxProfit: null, maxLoss: null, bands: [{ from: NaN, to: NaN, kind: 'loss' }] },
  renderMultiCurve: { series: [{ name: 'T+0', points: [{ stock: NaN, pnl: NaN }] }, null, { name: 'X', points: [] }], breakevens: [NaN] },
  renderHeatmap: { rows: [{ label: '', cells: [{ value: NaN, text: 'NaN%' }] }, null], cols: [], metricLabel: '' },
  renderTermStructure: { points: [{ dte: NaN, iv: NaN }], hv20: null, hv252: null },
  renderSkew: { points: [{ strike: NaN, iv: NaN, moneyness: NaN }], spot: NaN },
  renderDistribution: { points: [{ price: NaN, density: NaN }], intervals: [{ from: NaN, to: NaN, label: '±1σ', level: 1 }], breakevens: null },
  renderGreeksBars: { items: [{ name: 'Delta', value: NaN }, null, { name: 'X' }] },
  renderIVHistory: { points: [{ date: 'x', iv: NaN, hv: NaN }], ivRank: null, ivPercentile: null, currentIV: NaN }
}

/* ---- 空資料 ---- */
console.log('== 空資料 / 異常輸入 ==')
FNS.forEach(function (f) {
  run(f + ' [undefined]', OC[f], undefined)
  run(f + ' [{}]', OC[f], {})
  run(f + ' [全 NaN]', OC[f], NaN_DATA[f])
})
run('renderPayoff [data=null]', OC.renderPayoff, null)

/* ---- 正常資料 ---- */
console.log('== 正常資料 ==')
var stockPrices = []
for (var s = 250; s <= 480; s += 5) stockPrices.push(s)
function pnlAt(k) { return Math.max(-12065, Math.min(8000, (k - 420.65) * 100 * 1.2 - 12065 + 12065 - 12065 + (k - 420.65) * 100)) }

var payoffData = {
  spot: 357.61,
  points: stockPrices.map(function (k) { return { stock: k, pnl: (k - 420.65) * 100 } }),
  breakevens: [420.65],
  maxProfit: null, maxLoss: -12065,
  bands: [{ from: 250, to: 420.65, kind: 'loss' }, { from: 420.65, to: 480, kind: 'profit' }],
  title: '到期损益 (P&L at Expiration)'
}
var paySvg = run('renderPayoff', OC.renderPayoff, payoffData)
ok('payoff 含盈虧平衡標記', paySvg.indexOf('BE 420.65') > 0)
ok('payoff 含 Unlimited 標註', paySvg.indexOf('Unlimited') > 0)
ok('payoff 含現價標註', paySvg.indexOf('现价') > 0)

run('renderMultiCurve', OC.renderMultiCurve, {
  spot: 357.61,
  series: [
    { name: 'T+0', color: 'var(--c-accent)', points: stockPrices.map(function (k) { return { stock: k, pnl: (k - 430) * 60 } }) },
    { name: 'T+30', color: 'var(--c-buy)', points: stockPrices.map(function (k) { return { stock: k, pnl: (k - 425) * 85 } }) },
    { name: '到期', color: 'var(--c-sell)', dashed: true, points: stockPrices.map(function (k) { return { stock: k, pnl: (k - 420.65) * 100 } }) }
  ],
  breakevens: [420.65], title: '时间衰减下的损益曲线'
})

run('renderHeatmap', OC.renderHeatmap, {
  rows: [500, 460, 420, 380, 340, 300].map(function (k) {
    return {
      label: '$' + k, cells: [0, 30, 60, 90].map(function (d) {
        var v = (k - 380) / 380 * 100 * (1 - d / 200)
        return { value: v, text: (v >= 0 ? '+' : '') + v.toFixed(1) + '%' }
      })
    }
  }),
  cols: [{ label: '今天' }, { label: '30D' }, { label: '60D' }, { label: '90D' }],
  metricLabel: '收益率 %', title: '股价 × 时间 热力图'
})
run('renderHeatmap [全正]', OC.renderHeatmap, {
  rows: [{ label: '$400', cells: [{ value: 10, text: '+10%' }, { value: 90, text: '+90%' }] }],
  cols: [{ label: 'A' }, { label: 'B' }]
})
run('renderHeatmap [全負]', OC.renderHeatmap, {
  rows: [{ label: '$400', cells: [{ value: -10, text: '-10%' }, { value: -90, text: '-90%' }] }],
  cols: [{ label: 'A' }, { label: 'B' }]
})

var tsSvg = run('renderTermStructure', OC.renderTermStructure, {
  points: [{ dte: 7, iv: 41.2 }, { dte: 30, iv: 34.8 }, { dte: 90, iv: 33.1 }, { dte: 180, iv: 32.4 }],
  spot: 357.61, hv20: 32.6, hv252: 45.2, title: 'IV 期限结构'
})
ok('termStructure Backwardation 徽章', tsSvg.indexOf('Backwardation') > 0)
var ts2 = run('renderTermStructure [Contango]', OC.renderTermStructure, {
  points: [{ dte: 7, iv: 30 }, { dte: 90, iv: 38 }], hv20: null, hv252: null
})
ok('termStructure Contango 徽章', ts2.indexOf('Contango') > 0)

run('renderSkew', OC.renderSkew, {
  points: [300, 320, 340, 360, 380, 400].map(function (k) {
    return { strike: k, iv: 38 + (360 - k) / 60 * 4, moneyness: (k - 357.61) / 357.61 * 100 }
  }),
  spot: 357.61, title: 'IV Skew（同一到期日）'
})

var distPts = []
for (var px = 280; px <= 460; px += 4) {
  var z = (Math.log(px / 357.61)) / (0.28 * Math.sqrt(0.25))
  distPts.push({ price: px, density: Math.exp(-0.5 * z * z) / (px * 0.28 * Math.sqrt(2 * Math.PI * 0.25)) })
}
run('renderDistribution', OC.renderDistribution, {
  points: distPts, spot: 357.61,
  intervals: [{ from: 330, to: 385, label: '±1σ (68%)', level: 1 }, { from: 305, to: 410, label: '±2σ (95%)', level: 2 }],
  breakevens: [420.65], title: '到期价格概率分布'
})

run('renderGreeksBars', OC.renderGreeksBars, {
  items: [
    { name: 'Delta', value: 76.5, unit: '股当量', desc: '方向敞口' },
    { name: 'Gamma', value: 0.42, unit: '', desc: 'Delta 变化率' },
    { name: 'Theta', value: -68.5, unit: '$/天', desc: '时间衰减' },
    { name: 'Vega', value: 146.6, unit: '$/1% IV', desc: '波动率敞口' },
    { name: 'Rho', value: 12.1, unit: '$/1% 利率', desc: '利率敞口' }
  ], title: '组合 Greeks 敞口'
})

var hist = []
for (var d = 0; d < 60; d++) {
  var dt = new Date(Date.UTC(2025, 0, 2 + d))
  hist.push({ date: dt.toISOString().slice(0, 10), iv: 40 + 8 * Math.sin(d / 6), hv: d < 40 ? 38 + 5 * Math.cos(d / 5) : null })
}
run('renderIVHistory', OC.renderIVHistory, {
  points: hist, ivRank: 2, ivPercentile: 5, currentIV: 34.8, title: '历史 IV vs 实现波动率'
})

/* ---- 響應式 / 主題 / 匯出 ---- */
console.log('== 結構檢查 ==')
FNS.forEach(function (f) { ok(f + ' 已導出', typeof OC[f] === 'function') })
var anySvg = paySvg
ok('viewBox 存在', anySvg.indexOf('viewBox="0 0') > 0)
ok('width=100%', anySvg.indexOf('width="100%"') > 0)
ok('preserveAspectRatio', anySvg.indexOf('preserveAspectRatio') > 0)
ok('無寫死像素寬（無 width="720"）', !/width="720"/.test(anySvg))
ok('使用 CSS 變數取色', anySvg.indexOf('var(--c-profit') > 0 && anySvg.indexOf('var(--c-loss') > 0)
ok('無硬編碼 hex 主色（僅 var() fallback 內允許）',
  !/(?:fill|stroke|stop-color)\s*[:=]\s*["']?#[0-9a-fA-F]{6}/.test(anySvg))
ok('含 <title> tooltip', anySvg.indexOf('<title>') > 0)
run('renderPayoff [自訂寬高]', OC.renderPayoff, payoffData, { width: 480, height: 240 })

console.log('\n' + (fail ? 'FAILED' : 'ALL PASSED') + ' — pass=' + pass + ' fail=' + fail)
process.exit(fail ? 1 : 0)
