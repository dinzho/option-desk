/* =============================================================================
 * OptionDesk App v2.0 — UI 与交互
 *
 * 单位约定（全文统一）：
 *   IV / 利率 / 股息率 → 小数（0.348 = 34.8%）；仅输入框与显示处用百分数
 *   ivShift            → IV 百分点（10 表示 +10pt）
 * ============================================================================= */
(function () {
  'use strict';
  var E = window.OptionEngine, S = window.OptionStrategies,
    D = window.OptionData, C = window.OptionCharts;
  if (!E || !S || !D || !C) { console.error('模块未全部载入'); return; }

  /* ============================ 状态 ============================ */
  var state = {
    symbol: 'AVGO',
    spot: 357.61, iv: 0.348, rate: 0.043, div: 0.007,
    legs: [],
    template: 'long_call',
    dte: 45, dte2: 550, width: 5, wing: 5, qty: 1, american: true,
    chains: {},            // dte -> {calls, puts, dte, spot}
    expirations: [],
    activeExpiry: null,
    history: null, realized: null, ivPos: null, ivHistory: null,
    quote: null, isDemo: false,
    matrixMode: 'time', matrixMetric: 'roi', chainFilter: 'all',
    proxies: null
  };

  /* ============================ 工具 ============================ */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt !== undefined) n.textContent = txt;
    return n;
  }
  function money(v, digits) {
    if (!E.finite(v)) return '—';
    var d = digits === undefined ? 0 : digits;
    return (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function pct(v, d) {
    if (!E.finite(v)) return '—';
    return v.toFixed(d === undefined ? 1 : d) + '%';
  }
  function pctSigned(v, d) {
    if (!E.finite(v)) return '—';
    return (v >= 0 ? '+' : '') + v.toFixed(d === undefined ? 1 : d) + '%';
  }
  function num(v, d) {
    if (!E.finite(v)) return '—';
    return v.toFixed(d === undefined ? 2 : d);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function debounce(fn, ms) {
    var t; return function () {
      var a = arguments, self = this;
      clearTimeout(t); t = setTimeout(function () { fn.apply(self, a); }, ms || 150);
    };
  }
  function toast(msg, kind) {
    var stack = $('toast-stack'); if (!stack) return;
    // 样式契约：.toast.ok / .toast.warn / .toast.err，且需 .is-visible 才会显现
    var cls = kind === 'bad' ? 'err' : (kind || 'ok');
    var t = el('div', 'toast ' + cls, msg);
    stack.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('is-visible'); });
    setTimeout(function () {
      t.classList.remove('is-visible');
      setTimeout(function () { t.remove(); }, 250);
    }, 3200);
  }
  function setStatus(text, kind) {
    // 样式契约：状态灯由父元素 .status 的 .is-live / .is-loading / .is-error 驱动
    var wrap = $('data-status'), t = $('status-text');
    if (!wrap || !t) return;
    t.textContent = text;
    wrap.className = 'status' + (kind === 'ok' ? ' is-live' : kind === 'warn' ? ' is-loading' : kind === 'bad' ? ' is-error' : '');
  }

  /* ============================ 腿编辑器 ============================ */
  var LEG_HEAD =
    '<div class="legs-head">' +
    '<span>方向</span><span>类型</span><span>行权价</span><span>到期日</span><span>DTE</span>' +
    '<span>数量</span><span>权利金 $</span><span>IV %</span><span></span></div>';

  function renderLegs() {
    var box = $('legs-table'); if (!box) return;
    box.innerHTML = '';
    if (!state.legs.length) {
      box.appendChild(el('div', 'empty', '尚未构建持仓。选择一个策略模板后点「生成策略」，或点击期权链中的合约。'));
      $('legs-foot').innerHTML = '';
      return;
    }
    box.innerHTML = LEG_HEAD;

    state.legs.forEach(function (leg, i) {
      var row = el('div', 'leg-row ' + (leg.side === 1 ? 'is-buy' : 'is-sell'));
      var isStock = leg.kind === 'stock';

      var sideSel = el('select', 'select leg-side');
      [['1', '买入'], ['-1', '卖出']].forEach(function (o) {
        var op = el('option', null, o[1]); op.value = o[0];
        if (String(leg.side) === o[0]) op.selected = true;
        sideSel.appendChild(op);
      });
      sideSel.onchange = function () { state.legs[i].side = parseInt(sideSel.value, 10); recompute(); };

      var kindSel = el('select', 'select');
      [['call', 'Call'], ['put', 'Put'], ['stock', '股票']].forEach(function (o) {
        var op = el('option', null, o[1]); op.value = o[0];
        if (leg.kind === o[0]) op.selected = true;
        kindSel.appendChild(op);
      });
      kindSel.onchange = function () {
        state.legs[i].kind = kindSel.value;
        if (kindSel.value === 'stock') { state.legs[i].strike = null; state.legs[i].iv = null; }
        else if (state.legs[i].strike === null) {
          state.legs[i].strike = S.roundStrike(state.spot, state.spot);
          state.legs[i].dte = state.dte; state.legs[i].iv = state.iv;
        }
        recompute();
      };

      function cellInput(value, step, onSet, disabled, title) {
        var inp = el('input', 'input is-num');
        inp.type = 'number'; inp.step = step;
        inp.value = value == null ? '' : value;
        if (disabled) inp.disabled = true;
        if (title) inp.title = title;
        inp.oninput = debounce(function () { onSet(parseFloat(inp.value)); }, 220);
        return inp;
      }

      row.appendChild(sideSel);
      row.appendChild(kindSel);
      row.appendChild(cellInput(isStock ? null : leg.strike, 0.5, function (v) {
        if (E.finite(v)) { state.legs[i].strike = v; recompute(); }
      }, isStock, isStock ? '股票腿无行权价' : '行权价'));
      row.appendChild(cellInput(isStock ? null : leg.dte, 1, function (v) {
        if (E.finite(v)) {
          state.legs[i].dte = Math.max(0, Math.round(v));
          state.legs[i].expiry = null;   // DTE 改咗，舊到期日作廢，改由 DTE 推算
          recompute();
        }
      }, isStock, '距到期天数'));
      // 到期日：優先顯示快照帶嚟嘅真實日期；冇就由 DTE 推算
      var expTxt = '—', expTip = '';
      if (!isStock) {
        if (leg.expiry) { expTxt = leg.expiry.slice(5).replace('-', '/'); expTip = '到期日 ' + leg.expiry + '（快照真實到期日）'; }
        else if (E.finite(leg.dte)) {
          var dd = new Date(Date.now() + leg.dte * 86400000);
          expTxt = (dd.getMonth() + 1) + '/' + dd.getDate();
          expTip = '由 DTE ' + leg.dte + ' 天推算（估計到期日）';
        }
      }
      var expCell = el('span', 'leg-expiry', expTxt);
      expCell.title = expTip;
      row.appendChild(expCell);
      row.appendChild(cellInput(leg.qty, isStock ? 1 : 1, function (v) {
        if (E.finite(v)) { state.legs[i].qty = Math.max(1, Math.round(v)); recompute(); }
      }, false, isStock ? '股数' : '合约张数'));
      row.appendChild(cellInput(leg.price, 0.01, function (v) {
        if (E.finite(v)) { state.legs[i].price = v; recompute(); }
      }, false, isStock ? '持股成本' : '每股权利金（1 张合约 = 100 股，即 ×100）'));
      row.appendChild(cellInput(isStock ? null : (leg.iv == null ? '' : +(leg.iv * 100).toFixed(1)), 0.1, function (v) {
        if (E.finite(v)) { state.legs[i].iv = v / 100; recompute(); }
      }, isStock, '隐含波动率 %'));

      var del = el('button', 'leg-del', '✕');
      del.title = '删除该腿';
      del.onclick = function () { state.legs.splice(i, 1); recompute(); };
      row.appendChild(del);

      box.appendChild(row);
    });

    var net = S.netPremium(state.legs);
    var g = S.positionGreeks(state.legs, state.spot, state.rate, state.div);
    $('legs-foot').innerHTML =
      '<div class="stat-row"><span class="stat-label">净权利金</span><span class="stat-value ' + (net >= 0 ? 'pos' : 'neg') + '">' +
      money(Math.abs(net)) + (net >= 0 ? ' （收入）' : ' （支出）') + '</span></div>' +
      '<div class="stat-row"><span class="stat-label">组合 Delta</span><span class="stat-value">' + num(g.delta, 1) + ' 股当量</span></div>' +
      '<div class="stat-row"><span class="stat-label">组合 Theta</span><span class="stat-value ' + (g.theta >= 0 ? 'pos' : 'neg') + '">' + money(g.theta, 2) + ' /天</span></div>';
  }

  /* ============================ IV 分析台 ============================ */
  function renderIV() {
    var kpis = $('iv-kpis'); if (!kpis) return;
    var r = state.realized || {};
    var ivPctNow = state.iv * 100;
    var pos = state.ivPos;

    function kpi(label, value, delta, cls) {
      return '<div class="kpi ' + (cls || '') + '"><span class="kpi-label">' + esc(label) + '</span>' +
        '<span class="kpi-value">' + value + '</span>' +
        '<span class="kpi-delta">' + esc(delta || '') + '</span></div>';
    }

    var div20 = E.ivhvDivergence(state.iv, r.hv20);
    var div252 = E.ivhvDivergence(state.iv, r.hv252);

    kpis.innerHTML =
      kpi('当前 IV（ATM）', pct(ivPctNow), state.isDemo ? '演示数据' : (state.quote ? state.quote.symbol : state.symbol),
        pos && pos.ivRank != null && pos.ivRank <= 20 ? 'is-good' : '') +
      kpi('IV Rank', pos && pos.ivRank != null ? pct(pos.ivRank, 0) : '—',
        pos ? (pos.ivRank != null ? (pos.ivRank <= 20 ? '偏低 · 适合买方' : pos.ivRank >= 70 ? '偏高 · 适合卖方' : '中性区间') : '样本不足') : '—') +
      kpi('IV Percentile', pos && pos.ivPercentile != null ? pct(pos.ivPercentile, 0) : '—',
        pos ? '52周样本 ' + (pos.samples || 0) + ' 个' : '—') +
      kpi('20日 实现波动率', r.hv20 != null ? pct(r.hv20 * 100) : '—', '近期实际波动') +
      kpi('252日 实现波动率', r.hv252 != null ? pct(r.hv252 * 100) : '—', '长期基准') +
      kpi('IV − HV20', div20 != null ? pctSigned(div20) : '—', div20 != null ? (div20 > 15 ? '期权偏贵' : div20 < -15 ? '期权偏便宜' : '接近均衡') : '',
        div20 != null ? (div20 > 15 ? 'is-bad' : div20 < -15 ? 'is-good' : '') : '') +
      kpi('IV − HV252', div252 != null ? pctSigned(div252) : '—', '相对长期均值',
        div252 != null ? (div252 > 15 ? 'is-bad' : div252 < -15 ? 'is-good' : '') : '') +
      kpi('1σ 预期移动（30天）', (function () {
        var em = E.expectedMove(state.spot, 30 / 365, state.iv, 1);
        return em ? '±' + money(em.dollars, 0) : '—';
      })(), (function () {
        var em = E.expectedMove(state.spot, 30 / 365, state.iv, 1);
        return em ? '±' + pct(em.percent) : '';
      })());

    // ---- 结论 ----
    var v = $('iv-verdict'), vt = $('iv-verdict-text');
    var rank = pos ? pos.ivRank : null;
    var tier = 'yellow', headline = '波动率数据不足', sub = '载入历史数据后可生成判断。';
    if (rank != null && E.finite(div20)) {
      if (rank <= 25 && div20 < 0) {
        tier = 'green';
        headline = 'IV 处于低位且低于实现波动率 —— 期权相对便宜';
        sub = '历史上 ' + (pos.ivPercentile != null ? pct(pos.ivPercentile, 0) : '—') + ' 的时间里 IV 比现在更低。买方（Long Straddle/Strangle、价差）在定价上占优，但需确认是否有催化剂。';
      } else if (rank >= 70 && div20 > 0) {
        tier = 'red';
        headline = 'IV 处于高位且高于实现波动率 —— 期权偏贵';
        sub = 'IV 比近 20 日实际波动高出 ' + pct(div20) + '。卖方（备兑、卖 Put、铁鹰）收取的权利金较厚，但需承担 Gamma 尾部风险。';
      } else if (div20 > 15) {
        tier = 'yellow';
        headline = 'IV 高于近期实现波动率 ' + pct(div20);
        sub = '市场隐含的波动高于最近实际发生的波动，卖方在统计上占优；若预期有事件驱动则另论。';
      } else if (div20 < -15) {
        tier = 'green';
        headline = 'IV 低于近期实现波动率 ' + pct(Math.abs(div20));
        sub = '期权定价相对便宜，买方占优。注意：IV 低于 HV 常出现在财报后波动率回落阶段。';
      } else {
        tier = 'yellow';
        headline = 'IV 与实现波动率基本均衡';
        sub = 'IV ' + pct(ivPctNow) + ' vs HV20 ' + (r.hv20 != null ? pct(r.hv20 * 100) : '—') + '。定价无明显偏向，需依赖方向判断而非波动率。';
      }
    } else if (r.hv20 != null) {
      headline = 'IV 相对位置样本不足，但可比较 IV 与 HV';
      sub = 'IV ' + pct(ivPctNow) + ' vs HV20 ' + pct(r.hv20 * 100) + '（' + pctSigned(div20) + '）。';
    }
    v.className = 'verdict ' + tier;
    vt.innerHTML = '<span class="verdict-tier">' + (tier === 'green' ? '买方占优' : tier === 'red' ? '卖方占优' : '中性') + '</span>' +
      '<div class="verdict-headline">' + esc(headline) + '</div>' +
      '<div class="verdict-sub">' + esc(sub) + '</div>';

    // ---- 图表 ----
    if (C.renderIVHistory) {
      var pts = buildIVHistoryPoints();
      C.renderIVHistory($('chart-iv-history'), {
        points: pts, ivRank: pos ? pos.ivRank : null,
        ivPercentile: pos ? pos.ivPercentile : null,
        currentIV: ivPctNow,
        title: 'IV 快照 vs 20日滚动实现波动率'
      });
    }
    if (C.renderTermStructure) {
      var ts = D.buildTermStructure(state.chains, state.spot);
      C.renderTermStructure($('chart-term'), {
        points: ts, spot: state.spot,
        hv20: r.hv20 != null ? r.hv20 * 100 : null,
        hv252: r.hv252 != null ? r.hv252 * 100 : null,
        title: 'IV 期限结构'
      });
    }
    if (C.renderSkew) {
      var ch = currentChain();
      if (ch && ch.calls && ch.calls.length) {
        C.renderSkew($('chart-skew'), {
          points: ch.calls.filter(function (o) { return E.finite(o.iv); })
            .map(function (o) { return { strike: o.strike, iv: o.iv * 100, moneyness: o.moneyness }; }),
          spot: state.spot, title: 'Call IV 微笑'
        });
      } else {
        C.renderSkew($('chart-skew'), { points: [], spot: state.spot, title: 'Call IV 微笑' });
      }
    }

    // ---- 明细 ----
    var st = $('iv-stats'); if (st) {
      function row(label, value, strong) {
        return '<div class="stat-row' + (strong ? ' is-strong' : '') + '"><span class="stat-label">' + esc(label) + '</span><span class="stat-value">' + value + '</span></div>';
      }
      var html = '';
      ['hv10', 'hv20', 'hv30', 'hv60', 'hv90', 'hv252'].forEach(function (k) {
        var v = r[k];
        html += row('实现波动率 ' + k.replace('hv', '') + ' 日', v != null ? pct(v * 100) : '—');
      });
      if (r.parkinson20 != null) html += row('Parkinson 20日（高低价）', pct(r.parkinson20 * 100));
      if (r.garmanKlass20 != null) html += row('Garman-Klass 20日（OHLC）', pct(r.garmanKlass20 * 100));
      if (r.yangZhang20 != null) html += row('Yang-Zhang 20日（抗跳空）', pct(r.yangZhang20 * 100));
      html += '<div class="divider"></div>';
      html += row('52周最高价', r.high52 != null ? money(r.high52, 2) : '—');
      html += row('52周最低价', r.low52 != null ? money(r.low52, 2) : '—');
      html += row('52周振幅', (r.high52 != null && r.low52 != null && r.low52 > 0) ? pct((r.high52 / r.low52 - 1) * 100) : '—');
      if (pos && pos.caveat) {
        html += '<div class="note is-warn" style="margin-top:10px">' + esc(pos.caveat) + '</div>';
      }
      st.innerHTML = html;
    }
  }

  /** 构造 IV 历史图数据：IV 用本地累积快照，HV 用滚动 20 日真实值 */
  function buildIVHistoryPoints() {
    var out = [];
    var hist = state.history;
    if (hist && hist.closes && hist.closes.length > 30) {
      var c = hist.closes;
      for (var i = 30; i <= c.length; i++) {
        var hv = E.hvCloseToClose(c.slice(0, i), 20);
        if (E.finite(hv)) out.push({ date: hist.dates[i - 1], iv: null, hv: +(hv * 100).toFixed(2) });
      }
    }
    // 叠加 IV 线：优先用数据源提供的历史（演示/导入），否则用本地逐日累积的快照
    var snaps = (state.ivHistory && state.ivHistory.length) ? state.ivHistory : D.getIVSeries(state.symbol);
    if (snaps.length) {
      var map = {};
      snaps.forEach(function (s) { if (E.finite(s.iv)) map[s.date] = s.iv * 100; });
      out.forEach(function (p) { if (map[p.date] != null) p.iv = +map[p.date].toFixed(2); });
      // 若 HV 序列为空（无历史数据），直接用 IV 序列撑起整张图
      if (!out.length) {
        out = snaps.map(function (s) { return { date: s.date, iv: +(s.iv * 100).toFixed(2), hv: null }; });
      }
    }
    return out.slice(-252);
  }

  /* ============================ 策略构建器 ============================ */
  function renderBuilder() {
    if (!state.legs.length) {
      $('score-ring').style.setProperty('--score', 0);
      $('score-ring').className = 'score-ring';
      $('score-label').textContent = '尚未构建';
      $('builder-kpis').innerHTML = '<div class="empty">选择一个策略模板后点「生成策略」，或直接点击期权链中的合约。</div>';
      ['chart-payoff', 'chart-time', 'chart-greeks', 'score-components'].forEach(function (id) { $(id).innerHTML = '<div class="empty">—</div>'; });
      return;
    }
    var opts = { rate: state.rate, dividend: state.div, american: state.american };
    var sc = S.scoreStructure(state.legs, state.spot, opts);
    if (!sc) return;
    var p = sc.profile, g = sc.greeks, pr = sc.probability;

    // 评分环
    var ring = $('score-ring');
    ring.style.setProperty('--score', sc.score.toFixed(0));
    ring.className = 'score-ring tier-' + (sc.tier === 'green' ? 'green' : sc.tier === 'yellow' ? 'yellow' : 'red');
    ring.innerHTML = '<span class="score-val">' + sc.score.toFixed(0) + '</span><span class="score-cap">/ 100</span>';
    $('score-label').textContent = sc.label;

    var bv = $('builder-verdict');
    bv.className = 'verdict ' + sc.tier;
    var worst = sc.components.filter(function (c) { return c.tier === 'red'; });
    var head = sc.tier === 'green' ? '结构较扎实' : sc.tier === 'yellow' ? '可用，但有明显取舍' : '结构偏脆弱';
    var subText = worst.length
      ? '需要留意：' + worst.map(function (c) { return c.name + '（' + c.display + '）'; }).join('、') + '。'
      : '各项指标均未触发风险阈值。';
    if (p.unlimitedLoss) subText += ' 注意：该结构存在无限亏损风险（裸卖腿），务必设置止损。';
    $('builder-verdict-text').innerHTML = '<span class="verdict-tier">' + head + '</span>' +
      '<div class="verdict-headline">' + esc(head) + '</div><div class="verdict-sub">' + esc(subText) + '</div>';

    // KPI
    function kpi(label, value, delta, cls, title) {
      return '<div class="kpi ' + (cls || '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '><span class="kpi-label">' + esc(label) + '</span>' +
        '<span class="kpi-value">' + value + '</span><span class="kpi-delta">' + esc(delta || '') + '</span></div>';
    }
    var rr = p.riskReward;
    $('builder-kpis').innerHTML =
      kpi('净权利金', money(Math.abs(p.netPremium)), p.netPremium >= 0 ? '净收入 credit' : '净支出 debit',
        p.netPremium >= 0 ? 'is-good' : '') +
      kpi('最大盈利', p.maxProfit === null ? '无限' : money(p.maxProfit),
        p.maxProfitAt != null ? '出现在 ' + money(p.maxProfitAt, 0) : '', p.maxProfit !== null ? 'is-good' : '') +
      kpi('最大亏损', p.maxLoss === null ? '无限' : money(p.maxLoss),
        p.maxLossAt != null ? '出现在 ' + money(p.maxLossAt, 0) : '', p.maxLoss === null ? 'is-bad' : '') +
      kpi('风险回报比', rr === null ? '—' : rr.toFixed(2) + ' : 1', rr === null ? '含无限端' : '', rr !== null && rr >= 2 ? 'is-good' : '') +
      kpi('盈亏平衡点', p.breakevens.length ? p.breakevens.map(function (b) { return money(b, 2); }).join(' / ') : '—',
        p.breakevens.length ? p.breakevens.length + ' 个' : '无', null,
        p.breakevens.length ? p.breakevens.map(function (b) { return b.toFixed(2); }).join(' / ') : '') +
      kpi('占用资金（估）', money(p.capital), p.capital > 0 ? '简化估算，非券商实收' : '') +
      kpi('盈利概率 POP', pr ? pct(pr.pop * 100, 1) : '—', pr ? '风险中性测度' : '', pr && pr.pop >= 0.65 ? 'is-good' : '') +
      kpi('期望值 EV', pr ? money(pr.ev) : '—', pr ? '风险中性下理论值' : '');

    // 损益曲线
    if (C.renderPayoff) {
      C.renderPayoff($('chart-payoff'), {
        spot: state.spot,
        points: p.curve.map(function (pt) { return { stock: pt.stock, pnl: pt.pnl }; }),
        breakevens: p.breakevens,
        maxProfit: p.maxProfit, maxLoss: p.maxLoss,
        bands: p.bands,
        title: '到期损益'
      });
    }
    // 时间路径
    if (C.renderMultiCurve) {
      var slices = S.timeSlices(state.legs, state.spot, opts);
      var palette = ['var(--c-accent)', 'var(--c-buy)', 'var(--c-sell)', 'var(--c-warn)', 'var(--c-profit)', 'var(--c-loss)'];
      C.renderMultiCurve($('chart-time'), {
        spot: state.spot,
        series: slices.map(function (s, i) {
          return {
            name: s.label, color: palette[i % palette.length],
            dashed: s.days === slices[slices.length - 1].days,
            points: s.points
          };
        }),
        breakevens: p.breakevens,
        title: '不同时点的损益曲线'
      });
    }
    // Greeks
    if (C.renderGreeksBars) {
      C.renderGreeksBars($('chart-greeks'), {
        items: [
          { name: 'Delta', value: g.delta, unit: '股当量', desc: '方向敞口' },
          { name: 'Gamma', value: g.gamma, unit: '', desc: 'Delta 变化率' },
          { name: 'Theta', value: g.theta, unit: '$/天', desc: '时间衰减' },
          { name: 'Vega', value: g.vega, unit: '$/1% IV', desc: '波动率敞口' },
          { name: 'Rho', value: g.rho, unit: '$/1% 利率', desc: '利率敞口' },
          { name: 'Vanna', value: g.vanna, unit: '', desc: 'Δ 对 IV 的敏感' },
          { name: 'Charm', value: g.charm, unit: '', desc: 'Δ 对时间的敏感' },
          { name: 'Vomma', value: g.vomma, unit: '', desc: 'Vega 对 IV 的敏感' }
        ], title: '组合 Greeks（含二阶）'
      });
    }
    // 分项
    var tierName = { green: '良好', yellow: '注意', red: '风险' };
    $('score-components').innerHTML = sc.components.map(function (c) {
      return '<div class="stat-row"><span class="stat-label">' + esc(c.name) +
        ' <span class="muted">· ' + esc(c.note || '') + '</span></span>' +
        '<span class="stat-value"><span class="badge badge-' + (c.tier === 'green' ? 'green' : c.tier === 'yellow' ? 'warn' : 'red') + '">' +
        esc(tierName[c.tier] || '—') + '</span> ' + esc(c.display) + '</span></div>';
    }).join('');
  }

  /* ============================ 期权链 ============================ */
  function currentChain() {
    if (state.activeExpiry != null && state.chains[state.activeExpiry]) return state.chains[state.activeExpiry];
    var keys = Object.keys(state.chains);
    if (!keys.length) return null;
    return state.chains[keys[0]];
  }

  function renderChain() {
    var seg = $('expiry-seg');
    seg.innerHTML = '';
    var dtes = Object.keys(state.chains).map(Number).sort(function (a, b) { return a - b; });
    if (!dtes.length) {
      $('chain-body').innerHTML = '<tr><td colspan="13"><div class="empty">暂无期权链数据。可点「演示数据」体验，或粘贴 CSV 导入。</div></td></tr>';
      $('chain-meta').textContent = '—';
      ['chart-chain-skew', 'chart-liquidity'].forEach(function (id) { $(id).innerHTML = '<div class="empty">—</div>'; });
      return;
    }
    if (state.activeExpiry == null || dtes.indexOf(state.activeExpiry) < 0) state.activeExpiry = dtes[0];
    dtes.forEach(function (d) {
      var chd = state.chains[d] || {};
      var lbl = chd.expiration
        ? (chd.expiration.slice(5).replace('-', '/') + ' · ' + d + '天')
        : (d + ' 天');
      var b = el('button', 'seg-btn' + (d === state.activeExpiry ? ' is-active' : ''), lbl);
      if (chd.expiration) b.title = '到期日 ' + chd.expiration;
      b.onclick = function () { state.activeExpiry = d; renderChain(); };
      seg.appendChild(b);
    });

    var ch = currentChain();
    if (!ch) return;
    var strikes = {};
    (ch.calls || []).forEach(function (o) { strikes[o.strike] = strikes[o.strike] || {}; strikes[o.strike].call = o; });
    (ch.puts || []).forEach(function (o) { strikes[o.strike] = strikes[o.strike] || {}; strikes[o.strike].put = o; });
    var ks = Object.keys(strikes).map(Number).sort(function (a, b) { return a - b; });

    var filter = state.chainFilter;
    var spot = state.spot;
    var html = '';
    ks.forEach(function (K) {
      var c = strikes[K].call, p = strikes[K].put;
      var cITM = spot > K, pITM = spot < K;
      if (filter === 'otm' && (cITM || pITM)) { /* 仍显示整行，因左右分属不同侧 */ }
      var rowCls = (Math.abs(K - spot) < (spot * 0.005)) ? ' class="is-atm"' : '';
      function cell(o, kind) {
        if (!o) return '<td class="col-num cell-dim">—</td><td class="col-num cell-dim">—</td><td class="col-num cell-dim">—</td><td class="col-num cell-dim">—</td><td class="col-num cell-dim">—</td><td class="col-num cell-dim">—</td>';
        var delta = o.greeks ? o.greeks.delta : null;
        var g = '<td class="col-num' + (o.greeks ? '' : ' cell-dim') + '">' + (delta != null ? delta.toFixed(3) : '—') + '</td>' +
          '<td class="col-num' + (E.finite(o.iv) ? '' : ' cell-dim') + '">' + (E.finite(o.iv) ? (o.iv * 100).toFixed(1) : '—') + '</td>' +
          '<td class="col-num pick" data-kind="' + kind + '" data-strike="' + K + '">' + (o.bid != null ? o.bid.toFixed(2) : '—') + '</td>' +
          '<td class="col-num pick" data-kind="' + kind + '" data-strike="' + K + '">' + (o.ask != null ? o.ask.toFixed(2) : '—') + '</td>' +
          '<td class="col-num pick is-mid" data-kind="' + kind + '" data-strike="' + K + '">' + (o.mid != null ? o.mid.toFixed(2) : '—') + '</td>' +
          '<td class="col-num">' + (o.openInterest != null ? o.openInterest.toLocaleString('en-US') : '—') + '</td>';
        return kind === 'put'
          ? '<td class="col-num">' + (o.openInterest != null ? o.openInterest.toLocaleString('en-US') : '—') + '</td>' +
          '<td class="col-num pick is-mid" data-kind="put" data-strike="' + K + '">' + (o.mid != null ? o.mid.toFixed(2) : '—') + '</td>' +
          '<td class="col-num pick" data-kind="put" data-strike="' + K + '">' + (o.ask != null ? o.ask.toFixed(2) : '—') + '</td>' +
          '<td class="col-num pick" data-kind="put" data-strike="' + K + '">' + (o.bid != null ? o.bid.toFixed(2) : '—') + '</td>' +
          '<td class="col-num' + (E.finite(o.iv) ? '' : ' cell-dim') + '">' + (E.finite(o.iv) ? (o.iv * 100).toFixed(1) : '—') + '</td>' +
          '<td class="col-num' + (o.greeks ? '' : ' cell-dim') + '">' + (o.greeks ? o.greeks.delta.toFixed(3) : '—') + '</td>'
          : g;
      }
      // 表头顺序：CALL(Δ IV Bid Ask Mid OI) | 行权价 | PUT(Bid Ask Mid IV Δ OI)
      var left = c
        ? '<td class="col-num' + (c.greeks ? '' : ' cell-dim') + '">' + (c.greeks ? c.greeks.delta.toFixed(3) : '—') + '</td>' +
        '<td class="col-num' + (E.finite(c.iv) ? '' : ' cell-dim') + '">' + (E.finite(c.iv) ? (c.iv * 100).toFixed(1) : '—') + '</td>' +
        '<td class="col-num pick" data-kind="call" data-strike="' + K + '">' + (c.bid != null ? c.bid.toFixed(2) : '—') + '</td>' +
        '<td class="col-num pick" data-kind="call" data-strike="' + K + '">' + (c.ask != null ? c.ask.toFixed(2) : '—') + '</td>' +
        '<td class="col-num pick is-mid" data-kind="call" data-strike="' + K + '">' + (c.mid != null ? c.mid.toFixed(2) : '—') + '</td>' +
        '<td class="col-num">' + (c.openInterest != null ? c.openInterest.toLocaleString('en-US') : '—') + '</td>'
        : '<td class="col-num cell-dim">—</td><td class="col-num cell-dim">—</td><td class="col-num cell-dim">—</td><td class="col-num cell-dim">—</td><td class="col-num cell-dim">—</td><td class="col-num cell-dim">—</td>';
      var right = p
        ? '<td class="col-num pick" data-kind="put" data-strike="' + K + '">' + (p.bid != null ? p.bid.toFixed(2) : '—') + '</td>' +
        '<td class="col-num pick" data-kind="put" data-strike="' + K + '">' + (p.ask != null ? p.ask.toFixed(2) : '—') + '</td>' +
        '<td class="col-num pick is-mid" data-kind="put" data-strike="' + K + '">' + (p.mid != null ? p.mid.toFixed(2) : '—') + '</td>' +
        '<td class="col-num' + (E.finite(p.iv) ? '' : ' cell-dim') + '">' + (E.finite(p.iv) ? (p.iv * 100).toFixed(1) : '—') + '</td>' +
        '<td class="col-num' + (p.greeks ? '' : ' cell-dim') + '">' + (p.greeks ? p.greeks.delta.toFixed(3) : '—') + '</td>' +
        '<td class="col-num">' + (p.openInterest != null ? p.openInterest.toLocaleString('en-US') : '—') + '</td>'
        : '<td class="col-num cell-dim">—</td><td class="col-num cell-dim">—</td><td class="col-num cell-dim">—</td><td class="col-num cell-dim">—</td><td class="col-num cell-dim">—</td><td class="col-num cell-dim">—</td>';
      html += '<tr' + rowCls + '>' + left + '<td class="col-mid">' + K + '</td>' + right + '</tr>';
    });
    $('chain-body').innerHTML = html;
    $('chain-meta').textContent = (ch.expiration ? '到期日 ' + ch.expiration + '（' + ch.dte + ' 天后）· ' : ch.dte + ' 天后到期 · ') + ks.length + ' 个行权价 · 现价 ' + money(state.spot, 2);

    // 绑定点击：加入持仓
    Array.prototype.forEach.call(document.querySelectorAll('#chain-body .pick'), function (td) {
      td.style.cursor = 'pointer';
      td.onclick = function () {
        var kind = td.getAttribute('data-kind'), K = parseFloat(td.getAttribute('data-strike'));
        var o = (kind === 'call' ? ch.calls : ch.puts).filter(function (x) { return x.strike === K; })[0];
        if (!o) return;
        addLegFromContract(o, kind);
      };
    });

    // Skew
    if (C.renderSkew) {
      var allPts = (ch.calls || []).concat(ch.puts || []).filter(function (o) { return E.finite(o.iv); })
        .map(function (o) { return { strike: o.strike, iv: o.iv * 100, moneyness: o.moneyness, kind: o.kind }; });
      allPts.sort(function (a, b) { return a.strike - b.strike; });
      C.renderSkew($('chart-chain-skew'), { points: allPts, spot: state.spot, title: 'IV 微笑（Call + Put）' });
    }
    // 流动性
    if (C.renderGreeksBars) {
      var liqPts = (ch.calls || []).filter(function (o) { return E.finite(o.spreadPct) && o.openInterest > 0; });
      C.renderGreeksBars($('chart-liquidity'), {
        items: liqPts.slice(0, 12).map(function (o) {
          return { name: 'K ' + o.strike, value: -o.spreadPct, unit: '% 价差', desc: 'OI ' + (o.openInterest || 0) };
        }), title: '做市价差（越接近 0 越窄，负值仅表示方向）'
      });
    }
  }

  function addLegFromContract(o, kind) {
    var price = E.finite(o.mid) ? o.mid : (E.finite(o.last) ? o.last : 0);
    var leg = S.makeLeg({
      kind: kind, side: 1, strike: o.strike, dte: o.dte || currentChain().dte,
      expiry: o.expiration || (currentChain() || {}).expiration || null,
      qty: state.qty || 1, price: price, iv: o.iv, bid: o.bid, ask: o.ask, oi: o.openInterest, volume: o.volume
    });
    // 同类型同行权价同到期日已存在 → 反向则平仓，否则加仓
    var dup = state.legs.filter(function (l) {
      return l.kind === kind && l.strike === o.strike && l.dte === leg.dte;
    })[0];
    if (dup) {
      if (dup.side === leg.side) dup.qty += leg.qty;
      else { dup.qty -= leg.qty; if (dup.qty <= 0) state.legs.splice(state.legs.indexOf(dup), 1); }
    } else {
      if (state.legs.length >= 8) { toast('最多支持 8 条腿', 'warn'); return; }
      state.legs.push(leg);
    }
    toast('已加入：' + (kind === 'call' ? 'Call' : 'Put') + ' ' + o.strike + ' @ ' + num(price, 2) +
      (leg.expiry ? ' · 到期 ' + leg.expiry : ''));
    recompute();
  }

  /* ============================ 风险与压力 ============================ */
  function renderRisk() {
    if (!state.legs.length) {
      $('risk-kpis').innerHTML = '<div class="empty">先构建持仓</div>';
      ['chart-dist', 'chart-heatmap'].forEach(function (id) { $(id).innerHTML = '<div class="empty">—</div>'; });
      $('scenario-body').innerHTML = ''; $('stress-body').innerHTML = '';
      return;
    }
    var opts = { rate: state.rate, dividend: state.div, american: state.american };
    var p = S.riskProfile(state.legs, state.spot, opts);
    var pr = S.probabilityAnalysis(state.legs, state.spot, opts);
    var vol = S.weightedIV(state.legs, state.spot) || state.iv;
    var maxDte = state.legs.reduce(function (m, l) { return Math.max(m, l.dte); }, 0);
    var T = maxDte / 365;

    function kpi(label, value, delta, cls) {
      return '<div class="kpi ' + (cls || '') + '"><span class="kpi-label">' + esc(label) + '</span>' +
        '<span class="kpi-value">' + value + '</span><span class="kpi-delta">' + esc(delta || '') + '</span></div>';
    }
    var em1 = E.expectedMove(state.spot, T, vol, 1);
    var em2 = E.expectedMove(state.spot, T, vol, 2);
    var inBE = null;
    if (pr && pr.breakevenRisk && pr.breakevenRisk.length) {
      inBE = 1 - pr.breakevenRisk.reduce(function (s, b) { return s + (b.probBeyond || 0); }, 0);
    }
    $('risk-kpis').innerHTML =
      kpi('盈利概率 POP', pr ? pct(pr.pop * 100, 1) : '—', '风险中性测度', pr && pr.pop >= 0.65 ? 'is-good' : '') +
      kpi('期望值 EV', pr ? money(pr.ev) : '—', pr ? '到期理论期望' : '') +
      kpi('±1σ 到期区间', em1 ? money(em1.lower, 0) + ' – ' + money(em1.upper, 0) : '—', em1 ? '约 68% 概率' : '') +
      kpi('±2σ 到期区间', em2 ? money(em2.lower, 0) + ' – ' + money(em2.upper, 0) : '—', em2 ? '约 95% 概率' : '') +
      kpi('到期落在盈利区', inBE != null ? pct(inBE * 100, 1) : '—', '由平衡点反推', inBE != null && inBE >= 0.6 ? 'is-good' : '') +
      kpi('组合加权 IV', pct(vol * 100), '按 Vega 加权');

    // 分布图
    if (C.renderDistribution) {
      var curve = E.densityCurve(state.spot, T, vol, state.rate, state.div, null, 141);
      C.renderDistribution($('chart-dist'), {
        points: curve, spot: state.spot,
        intervals: [
          { from: em1.lower, to: em1.upper, label: '±1σ (68%)', level: 1 },
          { from: em2.lower, to: em2.upper, label: '±2σ (95%)', level: 2 }
        ],
        breakevens: p.breakevens,
        title: '风险中性到期价格分布'
      });
    }

    // 热力矩阵
    if (C.renderHeatmap) {
      var m = S.matrix(state.legs, state.spot, {
        mode: state.matrixMode, metric: state.matrixMetric,
        rows: 17, cols: 13, rate: state.rate, dividend: state.div, american: state.american
      });
      $('matrix-title').textContent = (state.matrixMode === 'time' ? '股价 × 时间' : '股价 × IV 偏移') +
        ' 热力图（' + (state.matrixMetric === 'roi' ? '收益率 %' : state.matrixMetric === 'pnl' ? '盈亏 $' : '估值 $') + '）';
      C.renderHeatmap($('chart-heatmap'), {
        rows: m.rows, cols: m.cols,
        metricLabel: state.matrixMetric === 'roi' ? '收益率 %' : state.matrixMetric === 'pnl' ? '盈亏 $' : '估值 $',
        title: $('matrix-title').textContent
      });
      $('matrix-meta').textContent = state.matrixMode === 'time'
        ? '横轴为距今天数，纵轴为股价'
        : '横轴为 IV 相对当前值的偏移（百分点）';
    }

    // 情景表
    var sb = $('scenario-body'); if (sb) {
      var html = '';
      for (var i = -50; i <= 50; i += 10) {
        var St2 = state.spot * (1 + i / 100);
        var res = S.positionValue(state.legs, St2, maxDte, opts);
        var cost = Math.abs(res.cost) || 1;
        var roi = res.pnl / cost * 100;
        var stockPnl = 0;
        state.legs.forEach(function (l) { if (l.kind === 'stock') stockPnl += l.side * l.qty * (St2 - l.price); });
        var diff = res.pnl - stockPnl;
        var cls = i === 0 ? ' class="is-atm"' : '';
        html += '<tr' + cls + '><td>' + pctSigned(i, 0) + '</td><td class="col-num">' + money(St2, 2) + '</td>' +
          '<td class="col-num ' + (res.pnl >= 0 ? 'pos' : 'neg') + '">' + money(res.pnl) + '</td>' +
          '<td class="col-num ' + (roi >= 0 ? 'pos' : 'neg') + '">' + pctSigned(roi, 0) + '</td>' +
          '<td class="col-num">' + (stockPnl !== 0 ? money(stockPnl) : '—') + '</td>' +
          '<td class="col-num ' + (diff >= 0 ? 'pos' : 'neg') + '">' + (stockPnl !== 0 ? money(diff) : '—') + '</td></tr>';
      }
      sb.innerHTML = html;
    }

    // 压力测试
    var tb = $('stress-body'); if (tb) {
      var base = S.positionValue(state.legs, state.spot, 0, opts).pnl;
      var maxLoss = p.maxLoss !== null ? Math.abs(p.maxLoss) : null;
      function shock(label, o, days, note) {
        var v = S.positionValue(state.legs, state.spot, days || 0, Object.assign({ rate: state.rate, dividend: state.div, american: state.american }, o)).pnl;
        var d = v - base;
        var rel = maxLoss && maxLoss > 0 ? Math.abs(d) / maxLoss * 100 : null;
        return '<tr><td>' + esc(label) + '</td><td class="col-num ' + (d >= 0 ? 'pos' : 'neg') + '">' + money(d) + '</td>' +
          '<td class="col-num">' + (rel != null ? pct(rel, 1) : '—') + '</td><td class="muted">' + esc(note) + '</td></tr>';
      }
      tb.innerHTML =
        shock('IV −10 个百分点', { ivShift: -10 }, 0, '波动率崩塌（常见于财报后）') +
        shock('IV −5 个百分点', { ivShift: -5 }, 0, '温和回落') +
        shock('IV +5 个百分点', { ivShift: 5 }, 0, '波动率抬升') +
        shock('IV +10 个百分点', { ivShift: 10 }, 0, '恐慌/事件冲击') +
        shock('时间流逝 7 天', {}, 7, 'Theta 衰减') +
        shock('时间流逝 30 天', {}, 30, '中期持有') +
        shock('股价 −10%', {}, 0, '下跌冲击') +
        shock('股价 +10%', {}, 0, '上涨冲击') +
        shock('利率 +1 个百分点', { rate: state.rate + 0.01 }, 0, 'Rho 敞口');
      // 股价冲击需要单独处理（positionValue 的 S 参数）
      var down = S.positionValue(state.legs, state.spot * 0.9, 0, opts).pnl;
      var up = S.positionValue(state.legs, state.spot * 1.1, 0, opts).pnl;
      tb.innerHTML = tb.innerHTML
        .replace(/<tr><td>股价 −10%<\/td>.*?<\/tr>/, '<tr><td>股价 −10%</td><td class="col-num ' + (down - base >= 0 ? 'pos' : 'neg') + '">' + money(down - base) + '</td><td class="col-num">' + (maxLoss ? pct(Math.abs(down - base) / maxLoss * 100, 1) : '—') + '</td><td class="muted">下跌冲击（含 Delta/Gamma）</td></tr>')
        .replace(/<tr><td>股价 \+10%<\/td>.*?<\/tr>/, '<tr><td>股价 +10%</td><td class="col-num ' + (up - base >= 0 ? 'pos' : 'neg') + '">' + money(up - base) + '</td><td class="col-num">' + (maxLoss ? pct(Math.abs(up - base) / maxLoss * 100, 1) : '—') + '</td><td class="muted">上涨冲击（含 Delta/Gamma）</td></tr>');
    }
  }

  /* ============================ 总渲染 ============================ */
  var recomputeRaf = null;
  function recompute() {
    renderLegs();
    renderBuilder();
    renderRisk();
  }
  function renderAll() {
    renderIV();
    renderChain();
    recompute();
  }

  /* ============================ 数据载入 ============================ */
  function applySnapshot(snap) {
    state.symbol = snap.symbol;
    state.spot = snap.price;
    state.iv = snap.iv != null ? snap.iv : state.iv;
    state.rate = snap.rate != null ? snap.rate : state.rate;
    state.div = snap.dividend != null ? snap.dividend : state.div;
    state.realized = snap.realized || null;
    state.ivPos = snap.ivPosition || null;
    state.history = snap.history || null;
    state.ivHistory = snap.ivHistory || null;
    state.chains = snap.chains || {};
    state.activeExpiry = null;
    state.isDemo = !!snap.isDemo;
    state.quote = { symbol: snap.symbol, price: snap.price, change: snap.change, changePct: snap.changePct };
    // 同步输入框
    $('in-spot').value = state.spot.toFixed(2);
    $('in-iv').value = (state.iv * 100).toFixed(1);
    $('in-rate').value = (state.rate * 100).toFixed(1);
    $('in-div').value = (state.div * 100).toFixed(1);
    $('q-sym').textContent = snap.symbol;
    $('q-price').textContent = money(state.spot, 2);
    var chg = snap.changePct;
    $('q-change').textContent = (chg != null ? (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%' : '—');
    $('q-change').className = 'pill ' + (chg == null ? '' : chg >= 0 ? 'pos' : 'neg');
    optSel = 0;
    renderAll();
    renderOptimal();
  }

  /** 階段降級：① Nasdaq 即時 → ② Yahoo 即時 → ③ 演示數據 */
  function loadSymbol(sym) {
    sym = String(sym || '').trim().toUpperCase();
    if (!sym) { toast('请输入股票代码', 'warn'); return; }
    state.symbol = sym;
    setStatus('载入中…', 'warn');
    var stagesEl = $('status-text');

    function wantStages() {
      return {
        onProgress: function (name, phase) {
          stagesEl.textContent = name + '…';
          if (phase === 'fail') toast(name + ' 获取失败，将尝试降级', 'warn');
        },
        rate: state.rate, dividend: state.div,
        proxies: state.proxies
      };
    }

    function finish(snap, whenOK, whenWarn) {
      applySnapshot(snap);
      if (whenOK) { setStatus(whenOK, 'ok'); toast('已载入 ' + sym + ' 实时数据（Nasdaq）'); }
      else { setStatus('部分数据缺失', 'warn'); toast(whenWarn, 'warn'); }
      if (snap.atmIV == null && snap.realized && snap.realized.hv20) {
        state.iv = snap.realized.hv20;
        $('in-iv').value = (state.iv * 100).toFixed(1);
        renderAll();
      }
    }

    // ① Nasdaq（主）
    D.loadNasdaq(sym, wantStages()).then(function (snap) {
      finish(snap, '实时数据 · Nasdaq', null);
    }).catch(function (e1) {
      setStatus('Nasdaq 不可用', 'warn');
      // ② Yahoo（備）
      return D.loadAll(sym, wantStages()).then(function (out) {
        if (!out) throw new Error('无返回');
        var chainMap = {};
        if (out.chain) chainMap[out.chain.dte] = out.chain;
        finish({
          symbol: sym,
          price: out.spot || state.spot,
          iv: out.atmIV != null ? out.atmIV : null,
          rate: state.rate, dividend: state.div,
          realized: out.realized,
          ivPosition: out.ivPosition,
          chains: chainMap,
          change: out.quote ? out.quote.change : null,
          changePct: out.quote ? out.quote.changePct : null,
          isDemo: false
        }, out.errors && out.errors.length ? null : '实时数据 · Yahoo',
          out.errors && out.errors.length ? ('部分数据未取到：' + out.errors[0]) : null);
      });
    }).catch(function (e2) {
      setStatus('实时源不可用', 'bad');
      toast('实时数据失败（需先运行 proxy.py）：' + e2.message + ' — 已切换到演示数据', 'warn');
      applySnapshot(D.demoSnapshot(sym));
      setStatus('演示数据', 'warn');
    });
  }

  /* ============================ 模板 ============================ */
  // 每個模板實際用到嘅參數——未列入嘅欄位自動收埋，唔再全部固定晒出嚟
  var TPL_PARAMS = {
    long_call: ['dte', 'width', 'qty'], long_put: ['dte', 'width', 'qty'],
    leaps_call: ['dte', 'qty'],
    covered_call: ['dte', 'width', 'qty'], csp: ['dte', 'width', 'qty'],
    pmcc: ['dte', 'dte2', 'width', 'qty'],
    protective_put: ['dte', 'width', 'qty'], collar: ['dte', 'width', 'qty'],
    bull_call_spread: ['dte', 'width', 'qty'], bear_put_spread: ['dte', 'width', 'qty'],
    bull_put_spread: ['dte', 'width', 'qty'], bear_call_spread: ['dte', 'width', 'qty'],
    long_straddle: ['dte', 'qty'], short_straddle: ['dte', 'qty'],
    long_strangle: ['dte', 'width', 'qty'], short_strangle: ['dte', 'width', 'qty'],
    iron_condor: ['dte', 'width', 'wing', 'qty'], iron_butterfly: ['dte', 'width', 'qty'],
    long_butterfly: ['dte', 'width', 'qty'],
    calendar_call: ['dte', 'dte2', 'width', 'qty'], calendar_put: ['dte', 'dte2', 'width', 'qty'],
    diagonal_call: ['dte', 'dte2', 'width', 'qty'],
    ratio_backspread_call: ['dte', 'width', 'qty'], ratio_backspread_put: ['dte', 'width', 'qty'],
    jade_lizard: ['dte', 'width', 'wing', 'qty']
  };
  // 「行權价间距」標籤按模板語義調整
  var TPL_WIDTH_LABEL = {
    long_call: '行權價偏移 %', long_put: '行權價偏移 %', leaps_call: '行權價偏移 %',
    calendar_call: '行權價偏移 %', calendar_put: '行權價偏移 %'
  };
  // 每個模板嘅建議參數值——揀模板即自動帶入（長短腿 DTE／寬度／翼寬各有合理預設，仍可手改）
  var TPL_DEFAULTS = {
    long_call: { dte: 45, width: 5 }, long_put: { dte: 45, width: 5 },
    leaps_call: { dte: 550, width: 10 },
    covered_call: { dte: 30, width: 5 }, csp: { dte: 30, width: 5 },
    pmcc: { dte: 45, dte2: 550, width: 7 },
    protective_put: { dte: 45, width: 5 }, collar: { dte: 45, width: 5 },
    bull_call_spread: { dte: 45, width: 5 }, bear_put_spread: { dte: 45, width: 5 },
    bull_put_spread: { dte: 30, width: 5 }, bear_call_spread: { dte: 30, width: 5 },
    long_straddle: { dte: 45 }, short_straddle: { dte: 45 },
    long_strangle: { dte: 45, width: 5 }, short_strangle: { dte: 45, width: 5 },
    iron_condor: { dte: 45, width: 5, wing: 5 }, iron_butterfly: { dte: 45, width: 5 },
    long_butterfly: { dte: 45, width: 5 },
    calendar_call: { dte: 30, dte2: 60, width: 0 }, calendar_put: { dte: 30, dte2: 60, width: 0 },
    diagonal_call: { dte: 45, dte2: 400, width: 5 },
    ratio_backspread_call: { dte: 45, width: 5 }, ratio_backspread_put: { dte: 45, width: 5 },
    jade_lizard: { dte: 30, width: 5, wing: 5 }
  };

  function applyTplParams(tplId) {
    var t = S.TEMPLATE_MAP[tplId];
    var used = TPL_PARAMS[tplId] || ['dte', 'dte2', 'width', 'wing', 'qty'];
    [['in-dte', 'dte'], ['in-dte2', 'dte2'], ['in-width', 'width'],
     ['in-wing', 'wing'], ['in-qty', 'qty']].forEach(function (pair) {
      var input = $(pair[0]);
      var field = input.parentNode;
      if (field) field.style.display = used.indexOf(pair[1]) >= 0 ? '' : 'none';
    });
    // 揀模板即自動帶入該模板嘅建議值（長短腿 DTE／寬度／翼寬），state 同輸入框同步更新
    var defs = TPL_DEFAULTS[tplId];
    if (defs) {
      [['dte', 'in-dte'], ['dte2', 'in-dte2'], ['width', 'in-width'], ['wing', 'in-wing']]
        .forEach(function (p) {
          if (defs[p[0]] == null || used.indexOf(p[0]) < 0) return;
          var inp = $(p[1]);
          if (inp && String(inp.value) !== String(defs[p[0]])) {
            inp.value = defs[p[0]];
            state[p[0]] = defs[p[0]];
          }
        });
      if (typeof recompute === 'function') recompute();
    }
    // 長腿 DTE 唔喺參數入面但佢係萬年 550 之類，照收埋
    var wl = TPL_WIDTH_LABEL[tplId];
    if (wl) {
      var lbl = $('in-width').parentNode.querySelector('label');
      if (lbl) lbl.textContent = wl;
    }
    // 描述補埋腿數同適用參數提示，模板之間內容就唔會一樣
    if (t) {
      var pn = used.filter(function (k) { return k !== 'qty'; })
        .map(function (k) { return { dte: '短腿DTE', dte2: '長腿DTE', width: (TPL_WIDTH_LABEL[tplId] || '價差寬度').replace(' %', ''), wing: '保護翼寬' }[k]; });
      $('tpl-desc').innerHTML = esc(t.desc) +
        '<br><i class="tpl-meta">' + t.legs + ' 腿 · 用到參數：' + esc(pn.join('、')) + '</i>';
    }
  }

  function initTemplates() {
    var sel = $('in-template');
    var groups = {};
    S.TEMPLATES.forEach(function (t) { (groups[t.group] = groups[t.group] || []).push(t); });
    sel.innerHTML = '';
    Object.keys(groups).forEach(function (g) {
      var og = el('optgroup'); og.label = g;
      groups[g].forEach(function (t) {
        var op = el('option', null, t.name); op.value = t.id;
        if (t.id === state.template) op.selected = true;
        og.appendChild(op);
      });
      sel.appendChild(og);
    });
    $('tpl-count').textContent = S.TEMPLATES.length + ' 个';
    sel.onchange = function () {
      state.template = sel.value;
      applyTplParams(state.template);
    };
    applyTplParams(state.template);
  }

  function buildStrategy(jump) {
    var ctx = {
      spot: state.spot, dte: state.dte, dte2: state.dte2,
      widthPct: state.width, wingPct: state.wing, qty: state.qty,
      iv: state.iv, rate: state.rate, dividend: state.div,
      chain: function (kind, strike, dte) {
        // 若本地已有该到期日的真实链，优先取真实报价。
        // 匹配条件必须严格：到期日 ±7 天、行权价 ±2.5%（约一个档位）。
        // 放太宽会让「45 天的腿配上 60 天的价格」，全部指标失真。
        var best = null, bd = Infinity;
        Object.keys(state.chains).forEach(function (k) {
          var c = state.chains[k];
          var d = Math.abs(c.dte - dte);
          if (d < bd) { bd = d; best = c; }
        });
        if (!best || bd > 7) return null;
        var arr = kind === 'put' ? best.puts : best.calls;
        if (!arr || !arr.length) return null;
        var pick = null, pd = Infinity;
        arr.forEach(function (o) { var d = Math.abs(o.strike - strike); if (d < pd) { pd = d; pick = o; } });
        if (!pick || pd > state.spot * 0.025) return null;
        return { price: pick.mid, iv: pick.iv, bid: pick.bid, ask: pick.ask, oi: pick.openInterest, volume: pick.volume };
      }
    };
    var legs = S.buildTemplate(state.template, ctx);
    if (!legs) { toast('模板生成失败', 'warn'); return; }
    state.legs = legs;
    recompute();
    toast('已生成：' + S.TEMPLATE_MAP[state.template].name);
    // 跳轉到策略構建器分頁，用戶即刻見到生成嘅持倉同指標（首次自動生成唔跳）
    if (jump) {
      var tab = document.querySelector('.tab[data-tab="builder"]');
      if (tab) tab.click();
      var panel = document.querySelector('.tab-panel[data-panel="builder"]');
      if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  /* ============================ 最优策略推荐（加载个股即列） ============================ */
  // 用户查个股载入时，自动对全部模板用真实期权链报价试建，按「年化回报」排名，
  // 列出最优的一个 + 原因，唔使再一个个模板去揀。
  function optimalChainPicker() {
    return function (kind, strike, dte) {
      var best = null, bd = Infinity;
      Object.keys(state.chains).forEach(function (k) {
        var c = state.chains[k];
        var d = Math.abs((c.dte || 0) - dte);
        if (d < bd) { bd = d; best = c; }
      });
      if (!best || bd > 7) return null;
      var arr = kind === 'put' ? (best.puts || []) : (best.calls || []);
      if (!arr.length) return null;
      var pick = null, pd = Infinity;
      arr.forEach(function (o) { var d = Math.abs((o.strike || 0) - strike); if (d < pd) { pd = d; pick = o; } });
      if (!pick || pd > state.spot * 0.025) return null;
      return { price: pick.mid, iv: pick.iv, bid: pick.bid, ask: pick.ask, oi: pick.openInterest, volume: pick.volume };
    };
  }

  var optRanked = [];
  var optSel = 0;

  function rankStrategies() {
    if (!state.spot || !state.chains || !Object.keys(state.chains).length) return [];
    var ctx = { spot: state.spot, iv: state.iv, rate: state.rate, dividend: state.div, qty: 1, chain: optimalChainPicker() };
    var out = [];
    S.TEMPLATES.forEach(function (t) {
      var def = TPL_DEFAULTS[t.id] || {};
      ctx.dte = def.dte || 45;
      ctx.dte2 = def.dte2 || ctx.dte;
      ctx.widthPct = (def.width != null) ? def.width : 5;
      ctx.wingPct = (def.wing != null) ? def.wing : 5;
      var legs;
      try { legs = S.buildTemplate(t.id, ctx); } catch (e) { return; }
      if (!legs || !legs.length) return;
      // 必须全部期权腿都有真实可成交报价（有 oi + bid/ask），否则无法实际交易，跳过
      var tradable = legs.every(function (l) {
        if (l.kind === 'stock') return true;
        return l.oi != null && l.oi !== undefined && l.bid != null && l.ask != null;
      });
      if (!tradable) return;
      var sc;
      try { sc = S.scoreStructure(legs, state.spot, { rate: state.rate, dividend: state.div, iv: state.iv }); }
      catch (e) { return; }
      if (!sc || !sc.profile) return;
      var effC = null;
      if (sc.components) for (var i = 0; i < sc.components.length; i++) if (sc.components[i].key === 'eff') effC = sc.components[i];
      if (!effC || !E.finite(effC.value)) return;   // 只排「盈利封顶、可算年化」的结构（长腿裸买期权无封顶，唔计）
      var net = legs.reduce(function (s, l) { if (l.kind === 'stock') return s; return s + (l.side || 0) * (l.price || 0) * (l.qty || 1) * 100; }, 0);
      // 净收租（credit）结构：Long Put / Ratio Backspread 等系「股价归零」嘅理论盈利，
      // 除咗极少本金后年化动辄过万 %，完全失真，亦唔系真实可落袋回报，一律排除。
      // 剩低嘅系有限风险、净收权利金嘅收租型结构（卖 Put / 卖 Call / 铁鹰 / 蝶式 / 备兑等），
      // 呢啲年化先系真实可达——亦顺带覆盖用户想要嘅 sell put 家族。
      var NO_GO = { long_call: 1, long_put: 1, leaps_call: 1, ratio_backspread_call: 1, ratio_backspread_put: 1 };
      if (NO_GO[t.id]) return;
      if (!E.finite(sc.profile.maxLoss)) return;     // 必须有限风险
      if (!(net < 0)) return;                         // 必须系净收租（credit）结构
      out.push({ id: t.id, name: t.name, group: t.group, dir: t.dir, legs: legs, eff: effC.value, profile: sc.profile, prob: sc.probability, net: net });
    });
    out.sort(function (a, b) { return b.eff - a.eff; });
    return out;
  }

  function legTag(l) {
    var act = l.side === -1 ? '卖' : '买';
    if (l.kind === 'stock') return act + ' 正股';
    var k = l.kind === 'put' ? 'P' : 'C';
    return act + ' ' + k + ' ' + (l.strike != null ? l.strike.toFixed(2) : '—') + ' @' + (l.price != null ? l.price.toFixed(2) : '—');
  }

  function optimalReason(item) {
    var p = item.profile, b = item.prob;
    var pop = (b && E.finite(b.pop)) ? (b.pop * 100).toFixed(0) + '%' : '—';
    var be = (p.breakevens && p.breakevens.length) ? '$' + p.breakevens[0].toFixed(2) : '—';
    var cap = E.finite(p.capital) ? '$' + Math.round(p.capital) : '—';
    var credit = -item.net;                       // net<0 即收租（credit）
    var hasStock = item.legs.some(function (l) { return l.kind === 'stock'; });
    // 代表到期日：取多数腿的 dte
    var dtes = {};
    item.legs.forEach(function (l) { if (l.dte != null) dtes[l.dte] = (dtes[l.dte] || 0) + 1; });
    var repDte = 0, repN = 0;
    Object.keys(dtes).forEach(function (k) { if (dtes[k] > repN) { repN = dtes[k]; repDte = +k; } });
    var dteTxt = repDte ? ('约 ' + repDte + ' 天后期权到期') : '';
    var head;
    if (credit > 0) {
      head = '净收 ' + money(credit) + ' 权利金，占用资金 ' + cap +
        (dteTxt ? '，' + dteTxt : '') +
        '；若到期守住损平点 ' + be + ' 则全数落袋（盈利概率 ' + pop + '），年化回报 ' + item.eff.toFixed(0) + '%。';
    } else {
      head = '付出 ' + money(-credit) + ' 权利金，占用资金 ' + cap +
        (dteTxt ? '，' + dteTxt : '') +
        '，最大盈利 ' + (E.finite(p.maxProfit) ? money(p.maxProfit) : '—') + '（盈利概率 ' + pop + '），年化回报 ' + item.eff.toFixed(0) + '%。';
    }
    if (hasStock) head += '（需持有/买入正股）';
    return head;
  }

  // 每条腿的成交明细行（方向 / 类型 / 行权价 / 到期 / 中价 / 买价 / 卖价 / OI）
  function optLegRows(item) {
    return item.legs.map(function (l) {
      if (l.kind === 'stock') {
        return '<tr><td class="' + (l.side === -1 ? 'neg' : 'pos') + '">' + (l.side === -1 ? '卖' : '买') + '</td>' +
          '<td>正股</td><td>—</td><td>—</td><td>' + (E.finite(l.price) ? l.price.toFixed(2) : '—') + '</td><td>—</td><td>—</td><td>—</td></tr>';
      }
      var k = l.kind === 'put' ? 'P' : 'C';
      var dte = l.dte != null ? l.dte + 'D' : '—';
      var mk = E.finite(l.price) ? l.price.toFixed(2) : '—';
      var bd = E.finite(l.bid) ? l.bid.toFixed(2) : '—';
      var ak = E.finite(l.ask) ? l.ask.toFixed(2) : '—';
      var oi = E.finite(l.oi) ? Math.round(l.oi) : '—';
      return '<tr><td class="' + (l.side === -1 ? 'neg' : 'pos') + '">' + (l.side === -1 ? '卖' : '买') + '</td>' +
        '<td>' + k + '</td><td>' + (E.finite(l.strike) ? l.strike.toFixed(2) : '—') + '</td><td>' + dte + '</td>' +
        '<td>' + mk + '</td><td>' + bd + '</td><td>' + ak + '</td><td>' + oi + '</td></tr>';
    }).join('');
  }

  // 保守可成交净额：卖腿取买一(bid)、买腿取卖一(ask)，即对你最不利档位
  function optRealistic(item) {
    var sum = 0;
    item.legs.forEach(function (l) {
      if (l.kind === 'stock') return;
      var px = l.side === -1 ? (E.finite(l.bid) ? l.bid : l.price) : (E.finite(l.ask) ? l.ask : l.price);
      sum += (l.side || 0) * (px || 0) * (l.qty || 1) * 100;
    });
    return sum; // 同 net 口径：<0 即净收
  }

  // 流动性提示：任一期权腿 OI 偏低则列出行权价
  function optLiquidity(item) {
    var bad = [];
    item.legs.forEach(function (l) {
      if (l.kind === 'stock') return;
      if (E.finite(l.oi) && l.oi > 0 && l.oi < 200) bad.push((E.finite(l.strike) ? l.strike.toFixed(0) : '') + (l.kind === 'put' ? 'P' : 'C'));
    });
    return bad;
  }

  function optStat(label, val, cls) {
    return '<div class="opt-stat"><span class="opt-stat-label">' + label + '</span><b class="opt-stat-val ' + (cls || '') + '">' + val + '</b></div>';
  }

  function renderOptimal() {
    var box = document.getElementById('optimal-box');
    if (!box) return;
    var ranked = rankStrategies();
    optRanked = ranked;
    if (!ranked.length) { box.hidden = true; box.innerHTML = ''; return; }
    if (optSel >= ranked.length) optSel = 0;
    var item = ranked[optSel];
    var isTop = (optSel === 0);
    var runners = ranked.filter(function (_, i) { return i !== optSel; }).slice(0, 4);
    var legsTbl =
      '<table class="opt-legs-tbl"><thead><tr>' +
      '<th>方向</th><th>类型</th><th>行权价</th><th>到期</th><th>中价</th><th>买价</th><th>卖价</th><th>OI</th>' +
      '</tr></thead><tbody>' + optLegRows(item) + '</tbody></table>';
    var markCredit = -item.net;
    var realNet = optRealistic(item);
    var realCredit = -realNet;
    var fillHtml;
    if (markCredit > 0) {
      fillHtml = '<span class="opt-fill-row">中价估算净收 <b>' + money(markCredit) + '</b> ｜ 保守可成交净收 <b class="pos">' + money(realCredit) + '</b></span>' +
        '<span class="opt-fill-note">展示价为 bid/ask 中点(mark)；保守估算取「卖腿买一 / 买腿卖一」，即对你最不利档位，实际多在两者之间</span>';
    } else {
      fillHtml = '<span class="opt-fill-row">中价估算付出 <b>' + money(-markCredit) + '</b> ｜ 保守需付 <b class="neg">' + money(-realCredit) + '</b></span>' +
        '<span class="opt-fill-note">展示价为 bid/ask 中点(mark)；保守估算取「买腿卖一 / 卖腿买一」，即对你最不利档位</span>';
    }
    var liq = optLiquidity(item);
    if (liq.length) {
      fillHtml += '<span class="opt-fill-warn">⚠ 腿 ' + liq.join('、') + ' 持仓量(OI)&lt;200，实际成交可能滑点较大或难成交</span>';
    }
    var runnersHtml = runners.map(function (r) {
      var idx = ranked.indexOf(r);
      return '<span class="opt-runner" data-idx="' + idx + '"><b>' + esc(r.name) + '</b> ' + (r.eff >= 0 ? '+' : '') + r.eff.toFixed(0) + '%</span>';
    }).join('');
    box.hidden = false;
    box.innerHTML =
      '<div class="opt-hero' + (isTop ? '' : ' is-cand') + '">' +
        '<div class="opt-top"><span class="opt-badge">' + (isTop ? '🏆 最优策略' : '候选策略') + '</span>' +
          '<span class="opt-sub">按年化回报排名 · 收租型有限风险 · 共 ' + ranked.length + ' 个可交易结构</span>' +
          (isTop ? '' : '<span class="opt-back" data-idx="0">↩ 回到最优</span>') + '</div>' +
        '<div class="opt-name">' + esc(item.name) + ' <span class="opt-group">' + esc(item.group) + '</span></div>' +
        legsTbl +
        '<div class="opt-grid">' +
          optStat('年化回报', '+' + item.eff.toFixed(0) + '%', 'up') +
          optStat('盈利概率', (item.prob && E.finite(item.prob.pop) ? (item.prob.pop * 100).toFixed(0) + '%' : '—'), '') +
          optStat('占用资金', (E.finite(item.profile.capital) ? '$' + Math.round(item.profile.capital) : '—'), '') +
          optStat('最大盈利', (E.finite(item.profile.maxProfit) ? money(item.profile.maxProfit) : '—'), '') +
        '</div>' +
        '<div class="opt-fill">' + fillHtml + '</div>' +
        '<div class="opt-reason">' + esc(optimalReason(item)) + '</div>' +
        (runnersHtml ? '<div class="opt-runners"><span class="opt-runners-label">其他候选（点击查看明细）：</span>' + runnersHtml + '</div>' : '') +
      '</div>';
    box.querySelectorAll('.opt-runner, .opt-back').forEach(function (sp) {
      sp.onclick = function () { optSel = parseInt(sp.getAttribute('data-idx'), 10) || 0; renderOptimal(); };
    });
  }

  /* ============================ 数据源配置 ============================ */
  function initProxyUI() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem('optiondesk.proxies') || 'null'); } catch (e) { }
    state.proxies = saved || D.PROXIES.map(function (p) { return p.id; });

    function renderList() {
      var box = $('proxy-list'); box.innerHTML = '';
      state.proxies.forEach(function (id, i) {
        var p = D.PROXIES.filter(function (x) { return x.id === id; })[0];
        if (!p) return;
        var row = el('div', 'row');
        row.appendChild(el('span', 'mono grow', p.name));
        var up = el('button', 'btn btn-sm btn-ghost', '↑');
        up.disabled = i === 0;
        up.onclick = function () { var t = state.proxies[i - 1]; state.proxies[i - 1] = state.proxies[i]; state.proxies[i] = t; renderList(); };
        var dn = el('button', 'btn btn-sm btn-ghost', '↓');
        dn.disabled = i === state.proxies.length - 1;
        dn.onclick = function () { var t = state.proxies[i + 1]; state.proxies[i + 1] = state.proxies[i]; state.proxies[i] = t; renderList(); };
        row.appendChild(up); row.appendChild(dn);
        box.appendChild(row);
      });
    }
    renderList();

    $('btn-save-proxy').onclick = function () {
      try { localStorage.setItem('optiondesk.proxies', JSON.stringify(state.proxies)); } catch (e) { }
      toast('已保存代理顺序');
      $('ds-modal').hidden = true;
    };
    $('btn-test-proxy').onclick = function () {
      var out = $('proxy-test-out');
      out.textContent = '测试中…';
      var results = [];
      var seq = state.proxies.reduce(function (promise, id) {
        return promise.then(function () {
          var p = D.PROXIES.filter(function (x) { return x.id === id; })[0];
          return D.fetchThroughProxies('/v8/finance/chart/AAPL?range=5d&interval=1d', { proxies: [id], timeout: 7000 })
            .then(function () { results.push('✓ ' + p.name); })
            .catch(function (e) { results.push('✗ ' + p.name + ' — ' + e.message); })
            .then(function () { out.innerHTML = results.join('<br>'); });
        });
      }, Promise.resolve());
      seq.then(function () { out.innerHTML = results.join('<br>'); });
    };
    $('btn-datasource').onclick = function () { $('ds-modal').hidden = false; };
    $('ds-close').onclick = function () { $('ds-modal').hidden = true; };
  }

  /* ============================ 每日扫描 ============================ */
  function renderScan() {
    var el = $('scan-root');
    if (!el || typeof window.ScanPanel === 'undefined') return;
    if (!window.ScanPanel.state.onOpen) {
      window.ScanPanel.state.onOpen = function (sym) {
        // 跳到 IV 分析台并尝试抓该标的（需要联网或本地代理；烤入版会退回提示）
        var tab = document.querySelector('.tab[data-tab="iv"]');
        if (tab) tab.click();
        loadSymbol(sym);
      };
    }
    window.ScanPanel.render(el, window.__DESK_SCAN__ || null);
  }

  /* ============================ 事件绑定 ============================ */
  function bind() {
    // Tabs
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.onclick = function () {
        Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (x) { x.classList.remove('is-active'); });
        Array.prototype.forEach.call(document.querySelectorAll('.tab-panel'), function (x) { x.classList.remove('is-active'); });
        t.classList.add('is-active');
        var panel = document.querySelector('.tab-panel[data-panel="' + t.getAttribute('data-tab') + '"]');
        if (panel) panel.classList.add('is-active');
        // 切到图表 tab 时重绘（隐藏时尺寸为 0）
        if (t.getAttribute('data-tab') === 'risk') renderRisk();
        if (t.getAttribute('data-tab') === 'builder') renderBuilder();
        if (t.getAttribute('data-tab') === 'chain') renderChain();
        if (t.getAttribute('data-tab') === 'iv') renderIV();
        if (t.getAttribute('data-tab') === 'scan') renderScan();
      };
    });

    // 主题
    var savedTheme = null;
    try { savedTheme = localStorage.getItem('optiondesk.theme'); } catch (e) { }
    if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
    $('btn-theme').onclick = function () {
      var cur = document.documentElement.getAttribute('data-theme') || 'dark';
      var next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('optiondesk.theme', next); } catch (e) { }
      renderAll();
    };

    // 载入
    $('symbol-form').onsubmit = function (e) { e.preventDefault(); loadSymbol($('symbol-input').value); };
    $('btn-demo').onclick = function () {
      applySnapshot(D.demoSnapshot($('symbol-input').value || 'AVGO'));
      setStatus('演示数据', 'warn');
      toast('已载入演示数据（AVGO 快照）');
    };
    $('btn-build').onclick = function () { buildStrategy(true); };
    $('btn-add-leg').onclick = function () {
      if (state.legs.length >= 8) { toast('最多支持 8 条腿', 'warn'); return; }
      var ch = currentChain();
      var K = S.roundStrike(state.spot, state.spot);
      var price = 0, iv = state.iv;
      if (ch && ch.calls && ch.calls.length) {
        var pick = null, pd = Infinity;
        ch.calls.forEach(function (o) { var d = Math.abs(o.strike - K); if (d < pd) { pd = d; pick = o; } });
        if (pick) { price = pick.mid || 0; iv = pick.iv || state.iv; }
      } else {
        price = E.bsPrice('call', state.spot, K, state.dte / 365, state.iv, state.rate, state.div);
      }
      state.legs.push(S.makeLeg({ kind: 'call', side: 1, strike: K, dte: state.dte, qty: 1, price: price, iv: iv }));
      recompute();
    };

    // 参数输入
    function bindNum(id, key, transform) {
      var inp = $(id);
      inp.oninput = debounce(function () {
        var v = parseFloat(inp.value);
        if (!E.finite(v)) return;
        state[key] = transform ? transform(v) : v;
        recompute();
      }, 220);
    }
    bindNum('in-spot', 'spot');
    bindNum('in-iv', 'iv', function (v) { return v / 100; });
    bindNum('in-rate', 'rate', function (v) { return v / 100; });
    bindNum('in-div', 'div', function (v) { return v / 100; });
    bindNum('in-dte', 'dte', Math.round);
    bindNum('in-dte2', 'dte2', Math.round);
    bindNum('in-width', 'width');
    bindNum('in-wing', 'wing');
    bindNum('in-qty', 'qty', Math.round);
    $('in-american').onchange = function () { state.american = $('in-american').value === '1'; recompute(); };

    // 矩阵切换
    Array.prototype.forEach.call(document.querySelectorAll('#matrix-mode .seg-btn'), function (b) {
      b.onclick = function () {
        Array.prototype.forEach.call(document.querySelectorAll('#matrix-mode .seg-btn'), function (x) { x.classList.remove('is-active'); });
        b.classList.add('is-active');
        state.matrixMode = b.getAttribute('data-mode');
        renderRisk();
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('#matrix-metric .seg-btn'), function (b) {
      b.onclick = function () {
        Array.prototype.forEach.call(document.querySelectorAll('#matrix-metric .seg-btn'), function (x) { x.classList.remove('is-active'); });
        b.classList.add('is-active');
        state.matrixMetric = b.getAttribute('data-metric');
        renderRisk();
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('#chain-filter .seg-btn'), function (b) {
      b.onclick = function () {
        Array.prototype.forEach.call(document.querySelectorAll('#chain-filter .seg-btn'), function (x) { x.classList.remove('is-active'); });
        b.classList.add('is-active');
        state.chainFilter = b.getAttribute('data-filter');
        renderChain();
      };
    });

    // CSV 导入
    $('btn-import-csv').onclick = function () {
      try {
        var raw = $('in-csv').value;
        var parsed = D.parseChainCSV(raw, { dte: state.dte });
        var ch = D.enrichImported(parsed, state.spot, { rate: state.rate, dividend: state.div });
        ch.dte = state.dte; ch.spot = state.spot;
        state.chains[state.dte] = ch;
        state.activeExpiry = state.dte;
        renderChain();
        toast('已导入 ' + (ch.calls.length + ch.puts.length) + ' 个合约并补齐 Greeks');
      } catch (e) { toast('导入失败：' + e.message, 'bad'); }
    };

    // 导出
    $('btn-export').onclick = function () {
      var data = JSON.stringify({ symbol: state.symbol, spot: state.spot, legs: state.legs }, null, 2);
      try {
        var blob = new Blob([data], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'optiondesk-position-' + state.symbol + '.json';
        a.click();
      } catch (e) { toast('导出失败', 'bad'); }
    };

    window.addEventListener('resize', debounce(function () { renderAll(); }, 300));
  }

  /* ============================ 初始化 ============================ */
  function init() {
    initTemplates();
    initProxyUI();
    bind();
    // 首屏系每日扫描，先渲染（烤入数据，零联网）
    renderScan();
    // 首次进入：优先用烤入的真实快照（零联网），否则退回演示数据
    if (!tryBakedSnapshot()) {
      applySnapshot(D.demoSnapshot('AVGO'));
      setStatus('演示数据', 'warn');
    }
    applyTplParams(state.template);
    // 默认生成一个策略，避免空白
    buildStrategy();
    renderDataStamp();
  }

  /** 站顶数据更新提示：读取 build meta + 烤入扫描日期 */
  function renderDataStamp() {
    var el = document.getElementById('data-stamp');
    if (!el) return;
    var buildMeta = document.querySelector('meta[name="build"]');
    var buildStr = buildMeta ? (buildMeta.getAttribute('content') || '').trim() : '';
    var scan = window.__DESK_SCAN__;
    var scanDate = (scan && scan.date) ? String(scan.date) : '';
    var txt;
    if (scanDate && buildStr) {
      txt = '数据日期 ' + scanDate + ' · 自动更新于 ' + buildStr;
    } else if (buildStr) {
      txt = '自动更新于 ' + buildStr;
    } else if (scanDate) {
      txt = '数据日期 ' + scanDate;
    } else {
      txt = '演示数据 · 未联网';
    }
    el.textContent = txt;
  }

  /** 读取 build.py 烤进 HTML 的真实快照；成功返回 true */
  function tryBakedSnapshot() {
    if (typeof window === 'undefined' || !window.__DESK_SNAPSHOT__) return false;
    var snap;
    try {
      snap = D.fromNasdaq(window.__DESK_SNAPSHOT__, {
        rate: state.rate, dividend: state.div
      });
    } catch (e) {
      console.error('快照解析失败', e);
      return false;
    }
    if (!snap) return false;
    applySnapshot(snap);
    var accepted = snap.quality ? snap.quality.kept : 0;
    setStatus('内置快照 · ' + snap.symbol, 'ok');
    toast('已载入烤入的 %s 真实数据（%d 张合约，抓取于 %s），无需联网'
      .replace('%s', snap.symbol).replace('%d', accepted)
      .replace('%s', snap.fetchedAt || '—'));
    return true;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
