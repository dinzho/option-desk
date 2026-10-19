/* =============================================================================
 * src/scan.js — 每日扫描面板
 *
 * 输入：scan.py / src/score.js 产出的 scan JSON
 * 输出：一眼看清「今日有冇嘢做」的卡片流 + VR×IVRank 散点图
 *
 * 设计原则：
 *   1. 结论先行 —— 顶部一张卡直接答「今日有几多个机会」，唔使逐行睇
 *   2. 每个机会必须落到可执行：具体 strike、credit、POP、到期日
 *   3. 跨财报等风险做徽章，唔抢主标签
 *   4. 唔联网也能用（数据由 build.py 烤进 HTML）
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScanPanel = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  /* ---------------------------- 小工具 ---------------------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function n2(v) { return isNum(v) ? (Math.round(v * 100) / 100) : null; }
  function pc(v, d) { return isNum(v) ? v.toFixed(d == null ? 1 : d) + '%' : '—'; }
  function money(v) { return isNum(v) ? '$' + v.toFixed(2) : '—'; }
  function int(v) { return isNum(v) ? Math.round(v).toLocaleString('en-US') : '—'; }
  function dash(v) { return (v == null || v === '') ? '—' : v; }

  /** 涨跌配色：绿升红降（中国习惯） */
  function chgCls(v) { return !isNum(v) ? '' : (v > 0 ? 'up' : (v < 0 ? 'down' : '')); }
  function chgTxt(v) { return !isNum(v) ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + '%'; }

  /* ---------------------------- 内部状态 ---------------------------- */
  var S = { data: null, filter: 'ALL', onOpen: null };

  /* ==========================================================================
   * 1. 顶部结论卡
   * ======================================================================== */
  function renderVerdict(d) {
    var sm = d.summary || {};
    var act = sm.actionable || 0;
    var watch = sm.watch || 0;
    var byTag = sm.byTag || {};

    // 结论：讲人话，唔好讲数字
    var tone, headline, sub;
    if (act >= 3) {
      tone = 'good';
      headline = '今日有 ' + act + ' 个值得做的机会';
      sub = '另有 ' + watch + ' 个观察项。优先看下面排最前的几张卡。';
    } else if (act > 0) {
      tone = 'good';
      headline = '今日有 ' + act + ' 个机会，其余一般';
      sub = '机会不多，挑最优质的那个做，不用贪多。另 ' + watch + ' 个观察项。';
    } else if (watch >= 3) {
      tone = 'warn';
      headline = '今日无强信号，有 ' + watch + ' 个可观察';
      sub = '未够条件出手。可以摆住观察，等 IV 或动能出现变化再落场。';
    } else {
      tone = 'flat';
      headline = '今日基本冇嘢做';
      sub = '全池未触发明确方向。空仓等待也是一种操作，不要勉强出手。';
    }

    var chips = '';
    Object.keys(d.tags || {}).forEach(function (k) {
      var c = byTag[k] || 0;
      if (!c) return;
      var t = d.tags[k];
      chips += '<span class="scan-chip" data-filter="' + esc(k) + '" style="--chip:' + esc(t.color) + '">' +
        '<i></i>' + esc(t.label) + '<b>' + c + '</b></span>';
    });

    return '' +
      '<div class="scan-verdict is-' + tone + '">' +
        '<div class="sv-left">' +
          '<div class="sv-badge">' + (tone === 'good' ? '可出手' : (tone === 'warn' ? '观察' : '空仓')) + '</div>' +
          '<div class="sv-num">' + act + '<span>个机会</span></div>' +
        '</div>' +
        '<div class="sv-mid">' +
          '<h3>' + esc(headline) + '</h3>' +
          '<p>' + esc(sub) + '</p>' +
          '<div class="sv-chips">' + chips + '</div>' +
        '</div>' +
        '<div class="sv-right">' +
          '<div><span>扫描</span><b>' + (sm.scanned || 0) + '</b></div>' +
          '<div><span>合格</span><b>' + (sm.survived || 0) + '</b></div>' +
          '<div><span>剔除</span><b>' + (sm.rejected || 0) + '</b></div>' +
          '<div><span>用时</span><b>' + (sm.fetchSeconds != null ? sm.fetchSeconds.toFixed(0) + 's' : '—') + '</b></div>' +
        '</div>' +
      '</div>' +
      '<div class="scan-meta">' +
        '<span>数据日期 <b>' + esc(d.date || '—') + '</b></span>' +
        '<span>生成 <b>' + esc((d.generatedAt || '').slice(11, 16) || '—') + '</b></span>' +
        '<span>利率 <b>' + pc((d.rate || 0) * 100, 1) + '</b></span>' +
        '<span class="src">' + esc(d.source || '') + '</span>' +
      '</div>';
  }

  /* ==========================================================================
   * 2. 散点图：X = VR(IV/HV)，Y = IV Rank，气泡 = 未平仓量
   *    四象限一眼分出「收租 / 买波 / 一般」
   * ======================================================================== */
  function renderScatter(items, tags) {
    var W = 900, H = 400, m = { t: 18, r: 18, b: 46, l: 58 };
    var pw = W - m.l - m.r, ph = H - m.t - m.b;

    var pts = items.filter(function (r) { return isNum(r.vr) && isNum(r.ivRank); });
    if (pts.length < 2) return '<div class="scan-empty">数据不足，画不出散点图</div>';

    var xs = pts.map(function (r) { return r.vr; });
    var ys = pts.map(function (r) { return r.ivRank; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    // 保证 VR=1 同 IVRank=50 一定在视野内（呢两条系分象限嘅基准线）
    x0 = Math.min(x0, 0.95); x1 = Math.max(x1, 1.25);
    y0 = Math.min(y0, 10); y1 = Math.max(y1, 90);
    var px = function (v) { return m.l + (v - x0) / (x1 - x0 || 1) * pw; };
    var py = function (v) { return m.t + ph - (v - y0) / (y1 - y0 || 1) * ph; };

    var ois = pts.map(function (r) { return Math.log10(Math.max(r.oiTotal || 1, 1)); });
    var o0 = Math.min.apply(null, ois), o1 = Math.max.apply(null, ois);
    var pr = function (r) { return 5 + (Math.log10(Math.max(r.oiTotal || 1, 1)) - o0) / ((o1 - o0) || 1) * 13; };

    var g = '';
    // 网格
    for (var i = 0; i <= 4; i++) {
      var yy = m.t + ph * i / 4;
      g += '<line x1="' + m.l + '" y1="' + yy.toFixed(1) + '" x2="' + (m.l + pw) + '" y2="' + yy.toFixed(1) +
        '" class="sc-grid"/>' +
        '<text x="' + (m.l - 8) + '" y="' + (yy + 4).toFixed(1) + '" class="sc-tick" text-anchor="end">' +
        Math.round(y0 + (y1 - y0) * (1 - i / 4)) + '</text>';
    }
    for (var j = 0; j <= 4; j++) {
      var xx = m.l + pw * j / 4;
      g += '<line x1="' + xx.toFixed(1) + '" y1="' + m.t + '" x2="' + xx.toFixed(1) + '" y2="' + (m.t + ph) +
        '" class="sc-grid"/>' +
        '<text x="' + xx.toFixed(1) + '" y="' + (m.t + ph + 18) + '" class="sc-tick" text-anchor="middle">' +
        (x0 + (x1 - x0) * j / 4).toFixed(2) + '</text>';
    }
    // 基准线
    g += '<line x1="' + px(1).toFixed(1) + '" y1="' + m.t + '" x2="' + px(1).toFixed(1) + '" y2="' + (m.t + ph) +
      '" class="sc-ref"/>' +
      '<line x1="' + m.l + '" y1="' + py(50).toFixed(1) + '" x2="' + (m.l + pw) + '" y2="' + py(50).toFixed(1) +
      '" class="sc-ref"/>';
    // 象限标注
    g += '<text x="' + (m.l + pw - 6) + '" y="' + (m.t + 16) + '" class="sc-quad" text-anchor="end">IV 贵 + 历史高位 → 收租</text>';
    g += '<text x="' + (m.l + 6) + '" y="' + (m.t + ph - 8) + '" class="sc-quad">IV 平 + 历史低位 → 买波</text>';
    // 轴名
    g += '<text x="' + (m.l + pw / 2) + '" y="' + (H - 8) + '" class="sc-axis" text-anchor="middle">VR = IV30 / HV20（&gt;1 即 IV 贵过已实现）</text>';
    g += '<text x="14" y="' + (m.t + ph / 2) + '" class="sc-axis" text-anchor="middle" transform="rotate(-90 14 ' +
      (m.t + ph / 2) + ')">IV Rank</text>';

    // 点
    pts.forEach(function (r) {
      var t = (tags && tags[r.tag]) || { color: '#94a3b8', label: r.tag };
      g += '<circle cx="' + px(r.vr).toFixed(1) + '" cy="' + py(r.ivRank).toFixed(1) + '" r="' + pr(r).toFixed(1) +
        '" fill="' + t.color + '" fill-opacity="0.22" stroke="' + t.color + '" stroke-width="1.5">' +
        '<title>' + esc(r.symbol) + '　分 ' + r.score + '　IV30 ' + pc(r.iv30 * 100) + '　VR ' +
        (isNum(r.vr) ? r.vr.toFixed(2) : '—') + '　IVRank ' + (isNum(r.ivRank) ? r.ivRank.toFixed(0) : '—') +
        '　OI ' + int(r.oiTotal) + '</title></circle>';
      g += '<text x="' + px(r.vr).toFixed(1) + '" y="' + (py(r.ivRank) - pr(r) - 3).toFixed(1) +
        '" class="sc-lbl" text-anchor="middle">' + esc(r.symbol) + '</text>';
    });

    return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="sc-svg" role="img" aria-label="VR 与 IV Rank 散点图">' + g + '</svg>';
  }

  /* ==========================================================================
   * 3. 单张机会卡
   * ======================================================================== */
  function renderCard(r, tags) {
    var t = (tags && tags[r.tag]) || { label: r.tag || '—', short: '?', color: '#94a3b8', desc: '' };
    var st = r.structure || null;

    // 副标签徽章（剔除主标签）。跨財報單獨用 ⚠ 樣式，
    // 因為佢喺財報季會出現喺大量標的身上，普通徽章會令版面好亂。
    var badges = (r.tags || []).filter(function (k) { return k !== r.tag; }).map(function (k) {
      var b = (tags && tags[k]) || { label: k, color: '#94a3b8' };
      if (k === 'EARNINGS' && r.tag !== 'EARNINGS') {
        return '<span class="scan-badge is-warn">⚠ 跨財報' +
          (r.dEarn ? '（' + r.dEarn + '天）' : '') + '</span>';
      }
      return '<span class="scan-badge" style="--chip:' + esc(b.color) + '">' + esc(b.label) + '</span>';
    }).join('');

    // 结构腿
    var legs = '';
    if (st && st.legs && st.legs.length) {
      legs = st.legs.map(function (L) {
        var actCls = L.act === 'sell' ? 'sell' : 'buy';
        return '<span class="leg ' + actCls + '">' + (L.act === 'sell' ? '卖' : '买') + ' ' +
          (L.kind === 'put' ? 'Put' : 'Call') + ' ' + L.K + ' @' + money(L.mid) + '</span>';
      }).join('');
    }

    var profitLine = '';
    if (st) {
      // Straddle 类结构嘅 maxProfit 系 null（上行方向理论上限唔封顶），
      // 显示「—」会令人以为计错数，要讲清楚。
      var mp = isNum(st.maxProfit) ? money(st.maxProfit) : '理论上不设上限';
      var perContract = isNum(st.credit) ? st.credit : (isNum(st.debit) ? st.debit : null);
      if (isNum(st.credit)) profitLine = '收 ' + money(st.credit) + '／股';
      else if (isNum(st.debit)) profitLine = '付 ' + money(st.debit) + '／股';
      // 1 张 = 100 股，落单实际金额的系呢个
      if (perContract != null) profitLine += '（$' + (perContract * 100).toFixed(0) + '／张，1 张 = 100 股）';
      profitLine += '　最大赚 ' + mp;
      if (isNum(st.pop)) profitLine += '　POP ' + pc(st.pop * 100, 0);
      if (isNum(st.maxLoss)) profitLine += '　最大亏 ' + money(st.maxLoss);
    }

    // 到期日 —— 用户问「做边一日」就系睇呢度
    var expiryLine = '';
    if (st && st.expiry) {
      expiryLine = '<span class="sc-expiry">到期 <b>' + esc(st.expiry) + '</b>' +
        (st.dte != null ? ' · 仲有 ' + st.dte + ' 天' : '') + '</span>';
    }

    return '' +
      '<article class="scan-card" data-sym="' + esc(r.symbol) + '" data-tag="' + esc(r.tag) + '" style="--chip:' + esc(t.color) + '">' +
        '<div class="sc-head">' +
          '<div class="sc-sym">' +
            '<b>' + esc(r.symbol) + '</b>' +
            '<span class="sc-name">' + esc(r.name || '') + '</span>' +
          '</div>' +
          '<div class="sc-price">' +
            '<b>' + money(r.price) + '</b>' +
            '<span class="' + chgCls(r.changePct) + '">' + chgTxt(r.changePct) + '</span>' +
          '</div>' +
          '<div class="sc-score">' +
            '<div class="sc-ring" style="--p:' + Math.round(r.score || 0) + '">' +
              '<span>' + Math.round(r.score || 0) + '</span>' +
            '</div>' +
            '<i>评分</i>' +
          '</div>' +
        '</div>' +

        '<div class="sc-tagline">' +
          '<span class="scan-tag">' + esc(t.label) + '</span>' + badges +
          '<span class="sc-trig">' + (r.multiTrigger ? '多维度确认' : '单维度') + '</span>' +
        '</div>' +

        '<div class="sc-why">' + esc((r.reasons && r.reasons[0]) || t.desc || '') + '</div>' +

        '<div class="sc-metrics">' +
          metric('IV30', pc(isNum(r.iv30) ? r.iv30 * 100 : null)) +
          metric('HV20', pc(isNum(r.hv20) ? r.hv20 * 100 : null)) +
          metric('VR', isNum(r.vr) ? r.vr.toFixed(2) : '—', vrCls(r.vr)) +
          metric('IV Rank', isNum(r.ivRank) ? r.ivRank.toFixed(0) : '—') +
          metric('期限结构', isNum(r.ts) ? r.ts.toFixed(2) : '—') +
          metric('到期', (r.dte != null ? r.dte + '天' : '—') + (r.expiry ? ' · ' + r.expiry.slice(5) : '')) +
          metric('ATM 价差', pc(r.atmSpreadPct)) +
          metric('未平仓', int(r.oiTotal)) +
        '</div>' +

        (st ? '<div class="sc-struct">' +
          '<div class="scs-head"><b>' + esc(st.name || '建议结构') + '</b>' + expiryLine +
            (r.earningsDate ? '<span class="sc-warn">财报 ' + esc(r.earningsDate) + '</span>' : '') +
          '</div>' +
          '<div class="scs-legs">' + legs + '</div>' +
          '<div class="scs-pnl">' + esc(profitLine) + '</div>' +
          breakEvenHtml(st, r.price) +
          (st.note ? '<div class="scs-note">' + esc(st.note) + '</div>' : '') +
          '</div>' : '') +

        '<div class="sc-actions">' +
          '<button class="btn btn-xs" data-act="copy" data-sym="' + esc(r.symbol) + '">复制腿</button>' +
          '<button class="btn btn-xs btn-ghost" data-act="open" data-sym="' + esc(r.symbol) + '">打开分析台</button>' +
        '</div>' +
      '</article>';
  }

  function metric(k, v, cls) {
    return '<div class="scm"><span>' + esc(k) + '</span><b class="' + (cls || '') + '">' + esc(v) + '</b></div>';
  }

  /**
   * 损益平衡 —— 成张卡最重要嘅一行。
   * 用户要嘅唔系一堆 Greeks，而系「要升／跌几多先赚」或者「跌穿几多先蚀」。
   * 买方（debit）同卖方（credit）语义相反，文案要分开写。
   */
  function breakEvenHtml(st, S) {
    var be = st.breakEven, mv = st.movePct;
    if (!be) return '';
    var isBuy = isNum(st.debit);
    var lo = isNum(be.lower) ? be.lower : null;
    var hi = isNum(be.upper) ? be.upper : null;
    var body = '';

    if (lo != null && hi != null) {
      if (isBuy) {
        // Long Straddle：两边都要过先赚
        body = '要跌到 <b>' + money(lo) + '</b> 以下，或升到 <b>' + money(hi) + '</b> 以上先赚钱';
        if (mv && isNum(mv.down) && isNum(mv.up))
          body += '<span class="bemove">即要跌 <b>' + Math.abs(mv.down).toFixed(1) + '%</b>' +
            ' 或升 <b>' + mv.up.toFixed(1) + '%</b></span>';
      } else {
        // Iron Condor / 双卖：中间安全区
        body = '安全区 <b>' + money(lo) + ' ~ ' + money(hi) + '</b>，到期喺区间内就全收';
        if (mv && isNum(mv.down) && isNum(mv.up))
          body += '<span class="bemove">即可跌 <b>' + Math.abs(mv.down).toFixed(1) + '%</b>' +
            ' 或升 <b>' + mv.up.toFixed(1) + '%</b> 都仲赚</span>';
      }
    } else if (lo != null) {
      body = isBuy
        ? ('要跌到 <b>' + money(lo) + '</b> 以下先赚钱')
        : ('跌穿 <b>' + money(lo) + '</b> 先开始蚀');
      if (mv && isNum(mv.down))
        body += '<span class="bemove">' + (isBuy ? '即要跌 ' : '缓冲 ') +
          '<b>' + Math.abs(mv.down).toFixed(1) + '%</b></span>';
    } else if (hi != null) {
      body = isBuy
        ? ('要升到 <b>' + money(hi) + '</b> 以上先赚钱')
        : ('升穿 <b>' + money(hi) + '</b> 先开始蚀');
      if (mv && isNum(mv.up))
        body += '<span class="bemove">' + (isBuy ? '即要升 ' : '缓冲 ') +
          '<b>' + mv.up.toFixed(1) + '%</b></span>';
    } else {
      return '';
    }

    return '<div class="scs-be"><span class="be-tag">损平</span>' +
      '<span class="be-body">' + body + '</span>' +
      (isNum(S) ? '<span class="be-now">现价 ' + money(S) + '</span>' : '') +
      '</div>';
  }
  function vrCls(v) { return !isNum(v) ? '' : (v >= 1.15 ? 'up' : (v <= 0.92 ? 'down' : '')); }

  /* ==========================================================================
   * 4. 主渲染
   * ======================================================================== */
  function render(el, data) {
    if (!el) return;
    if (!data || !data.results) {
      el.innerHTML = '<div class="scan-empty">' +
        '<b>还未跑今日扫描</b>' +
        '<p>运行 <code>python3 scan.py --top 60</code> 生成数据，再 <code>python3 build.py --scan scan/latest.json</code> 烤入本页。</p>' +
        '</div>';
      return;
    }
    S.data = data;

    var all = data.results || [];
    var tags = data.tags || {};

    // 筛选列（含「全部」）
    var counts = { ALL: all.length };
    all.forEach(function (r) { counts[r.tag] = (counts[r.tag] || 0) + 1; });
    var order = ['ALL', 'SELL_PREMIUM', 'BUY_VOL', 'EARNINGS', 'SQUEEZE_FLOW', 'RANGE', 'NEUTRAL'];
    var tabsHtml = order.filter(function (k) { return counts[k]; }).map(function (k) {
      var label = k === 'ALL' ? '全部' : ((tags[k] && tags[k].label) || k);
      var color = k === 'ALL' ? '#059669' : ((tags[k] && tags[k].color) || '#94a3b8');
      return '<button class="scan-tab' + (S.filter === k ? ' is-active' : '') + '" data-filter="' + esc(k) +
        '" style="--chip:' + esc(color) + '">' + esc(label) + '<b>' + counts[k] + '</b></button>';
    }).join('');

    var shown = S.filter === 'ALL' ? all : all.filter(function (r) { return r.tag === S.filter; });

    el.innerHTML =
      renderVerdict(data) +
      '<div class="scan-tabs">' + tabsHtml + '</div>' +
      '<div class="chart-box"><div class="chart-title">VR × IV Rank 分布（气泡大小 = 未平仓量）</div>' +
        renderScatter(all, tags) + '</div>' +
      '<div class="scan-list">' +
        (shown.length ? shown.map(function (r) { return renderCard(r, tags); }).join('')
          : '<div class="scan-empty">这个标签今日无标的</div>') +
      '</div>' +
      rejectedHtml(data);

    bindEvents(el);
  }

  function rejectedHtml(d) {
    var rj = d.rejected || [];
    if (!rj.length) return '';
    return '<details class="scan-rej"><summary>已剔除 ' + rj.length + ' 档（不合格，不要碰）</summary>' +
      '<div class="rej-list">' + rj.map(function (x) {
        return '<div><b>' + esc(x.symbol) + '</b><span>' + esc((x.reasons || []).join('；')) + '</span></div>';
      }).join('') + '</div></details>';
  }

  /* ---------------------------- 交互 ---------------------------- */
  function bindEvents(el) {
    Array.prototype.forEach.call(el.querySelectorAll('.scan-tab'), function (b) {
      b.onclick = function () {
        S.filter = b.getAttribute('data-filter');
        render(el, S.data);
      };
    });
    Array.prototype.forEach.call(el.querySelectorAll('[data-act]'), function (b) {
      b.onclick = function () {
        var sym = b.getAttribute('data-sym');
        var rec = (S.data.results || []).filter(function (x) { return x.symbol === sym; })[0];
        if (b.getAttribute('data-act') === 'copy') copyLegs(rec);
        else if (S.onOpen) S.onOpen(sym, rec);
      };
    });
  }

  function copyLegs(rec) {
    if (!rec || !rec.structure || !rec.structure.legs) return;
    var txt = rec.symbol + ' ' + (rec.structure.name || '') + ' 到期 ' + (rec.expiry || '') + '\n' +
      rec.structure.legs.map(function (L) {
        return (L.act === 'sell' ? 'SELL' : 'BUY') + ' ' + (L.kind === 'put' ? 'P' : 'C') + ' ' + L.K +
          ' @' + (isNum(L.mid) ? L.mid.toFixed(2) : '—');
      }).join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { flash('已复制 ' + rec.symbol + ' 的腿'); },
        function () { window.prompt('复制以下内容：', txt); });
    } else {
      window.prompt('复制以下内容：', txt);
    }
  }

  function flash(msg) {
    var d = document.createElement('div');
    d.className = 'scan-toast';
    d.textContent = msg;
    document.body.appendChild(d);
    setTimeout(function () { d.classList.add('is-out'); }, 1600);
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 2200);
  }

  return { render: render, state: S, copyLegs: copyLegs };
});
