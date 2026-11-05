/* =============================================================================
 * OptionDesk Data Layer v2.0 — 免费数据源适配
 *
 * 设计原则：
 *   1. 全部走用户自己的浏览器，不经过任何我们的服务器（隐私 + 零成本）
 *   2. 多数据源 + 多 CORS 代理自动轮换，任一可用即可
 *   3. 任何一步失败都优雅降级，绝不出现"白屏无数据"
 *   4. 本地累积 IV 历史（localStorage），随时间自然积累出真实 IV Rank
 *
 * 注意：Yahoo Finance 的非官方端点可能随时变更或限流。
 * 最稳妥的方式是运行随附的 proxy.py 本地代理（零依赖、零费用、无 CORS 问题）。
 * ============================================================================= */
(function (root, factory) {
  var E = (typeof module === 'object' && module.exports) ? require('./engine.js') : root.OptionEngine;
  var api = factory(E);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OptionData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E) {
  'use strict';

  /* ---------- 数据通道（按可靠性排序） ----------
   * custom：用家自設嘅 Cloudflare Worker 代理（喺「数据源」設定入填 URL）。
   *         呢個係線上版唯一穩定嘅即時數據通道——GitHub Pages 係純靜態，
   *         冇得跑後台函數，所以要靠外部 Worker 做 server-side 代理。
   *         （之前 Netlify Function 代理就係做緊呢件事，遷站後已移除。）
   * allorigins：公共 CORS 代理，偶爾可用，作最後兜底。
   * local：隨附 proxy.py 本地代理，純本地開發用。
   * 線上版已將掃描數據烤入 HTML——掃描過嘅 150 隻股可以零網絡即時載入 IV 指標。
   */
    function customProxyUrl() {
    try {
      var u = (localStorage.getItem('optiondesk.customProxy') || '').trim();
      if (!/^https?:\/\//.test(u)) {
        // 預設指向站長部署嘅 Cloudflare Worker 代理（public repo，所有訪客共用此額度）
        u = 'https://option-desk-proxy.dinpredjudice.workers.dev';
      }
      return u;
    } catch (e) { return 'https://option-desk-proxy.dinpredjudice.workers.dev'; }
  }
  var PROXIES = [
    { id: 'custom', name: '自訂 Worker 代理', build: function (u) { var b = customProxyUrl(); return b + (b.indexOf('?') >= 0 ? '&' : '?') + 'url=' + encodeURIComponent(u); }, custom: true },
    { id: 'allorigins', name: 'AllOrigins', build: function (u) { return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u); } },
    { id: 'local', name: '本地代理 (本地開發用)', build: function (u) { return 'http://127.0.0.1:8787/?url=' + encodeURIComponent(u); }, local: true }
  ];

  var YAHOO_HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

  function hasFetch() { return typeof fetch === 'function'; }

  /** 带超时的 fetch */
  function fetchWithTimeout(url, timeoutMs, headers) {
    if (!hasFetch()) return Promise.reject(new Error('当前环境不支持 fetch'));
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('请求超时')); }, timeoutMs || 12000);
      fetch(url, { headers: headers || {}, cache: 'no-store' })
        .then(function (r) {
          clearTimeout(timer);
          if (!r.ok) { reject(new Error('HTTP ' + r.status)); return null; }
          return r.text();
        })
        .then(function (t) { if (t !== null) resolve(t); })
        .catch(function (e) { clearTimeout(timer); reject(e); });
    });
  }

  /**
   * 依次尝试代理 × 主机，返回第一个成功的响应文本。
   * onProgress(proxyName, ok, errMsg) 用于 UI 展示探测过程。
   */
  function fetchThroughProxies(targetUrl, opts) {
    opts = opts || {};
    var order = (opts.proxies && opts.proxies.length) ? opts.proxies : PROXIES.map(function (p) { return p.id; });
    var list = order.map(function (id) {
      return PROXIES.filter(function (p) { return p.id === id; })[0];
    }).filter(Boolean).filter(function (p) { return !(p.custom && !customProxyUrl()); });
    var hosts = (opts.direct ? [''] : YAHOO_HOSTS.slice());
    var attempts = [];

    function tryNext(i, j) {
      if (i >= list.length) {
        return Promise.reject(new Error('全部代理均失败：' + attempts.map(function (a) { return a.id + '(' + a.err + ')'; }).join(' · ')));
      }
      var proxy = list[i];
      var host = hosts[j];
      // 目标 URL 若已含主机则不拼接；否则用当前主机
      var full = /^https?:\/\//.test(targetUrl) ? targetUrl : (host + targetUrl);
      var url = proxy.build(full);
      return fetchWithTimeout(url, opts.timeout || 7000).then(function (text) {
        var body = text;
        if (proxy.parse) {
          try { body = proxy.parse(JSON.parse(text)); } catch (e) { body = text; }
        }
        if (!body || body.length < 10) throw new Error('空响应');
        return body;
      }).then(function (body) {
        if (opts.onProgress) opts.onProgress(proxy.name, true, null);
        return { body: body, proxy: proxy.id, url: url };
      }).catch(function (err) {
        attempts.push({ id: proxy.id, err: err.message });
        if (opts.onProgress) opts.onProgress(proxy.name, false, err.message);
        if (j + 1 < hosts.length) return tryNext(i, j + 1);
        return tryNext(i + 1, 0);
      });
    }
    return tryNext(0, 0);
  }

  /* ===========================================================================
   * 1. 标的历史价格 → 实现波动率
   * ======================================================================== */

  /** 抓取历史 K 线。返回 {closes, highs, lows, opens, timestamps, meta} */
  function fetchHistory(symbol, range, opts) {
    range = range || '1y';
    var path = '/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=' + range + '&interval=1d&includePrePost=false';
    return fetchThroughProxies(path, opts).then(function (res) {
      var j;
      try { j = JSON.parse(res.body); } catch (e) { throw new Error('历史数据解析失败'); }
      var r = j && j.chart && j.chart.result && j.chart.result[0];
      if (!r) throw new Error('未返回历史数据（代码可能有误）');
      var q = r.indicators && r.indicators.quote && r.indicators.quote[0] || {};
      var ts = r.timestamp || [];
      var closes = [], highs = [], lows = [], opens = [], dates = [];
      for (var i = 0; i < ts.length; i++) {
        var c = q.close && q.close[i];
        if (!E.finite(c) || c <= 0) continue;   // 跳过缺失日
        closes.push(c);
        highs.push(E.finite(q.high && q.high[i]) ? q.high[i] : c);
        lows.push(E.finite(q.low && q.low[i]) ? q.low[i] : c);
        opens.push(E.finite(q.open && q.open[i]) ? q.open[i] : c);
        dates.push(new Date(ts[i] * 1000).toISOString().slice(0, 10));
      }
      if (closes.length < 3) throw new Error('历史数据不足');
      return {
        symbol: symbol.toUpperCase(),
        closes: closes, highs: highs, lows: lows, opens: opens, dates: dates,
        meta: r.meta || {}, source: res.proxy
      };
    });
  }

  /** 由历史数据计算全套实现波动率 */
  function computeRealizedVol(hist) {
    if (!hist || !hist.closes || hist.closes.length < 3) return null;
    var c = hist.closes;
    return {
      hv10: E.hvCloseToClose(c, 10),
      hv20: E.hvCloseToClose(c, 20),
      hv30: E.hvCloseToClose(c, 30),
      hv60: E.hvCloseToClose(c, 60),
      hv90: E.hvCloseToClose(c, 90),
      hv252: E.hvCloseToClose(c, 252),
      parkinson20: E.hvParkinson(hist.highs, hist.lows, 20),
      garmanKlass20: E.hvGarmanKlass(hist.opens, hist.highs, hist.lows, c, 20),
      yangZhang20: E.hvYangZhang(hist.opens, hist.highs, hist.lows, c, 20),
      // 52 周高低价位
      high52: Math.max.apply(null, c.slice(-252)),
      low52: Math.min.apply(null, c.slice(-252))
    };
  }

  /* ===========================================================================
   * 2. 报价
   * ======================================================================== */
  function fetchQuote(symbol, opts) {
    var path = '/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=5d&interval=1d';
    return fetchThroughProxies(path, opts).then(function (res) {
      var j; try { j = JSON.parse(res.body); } catch (e) { throw new Error('报价解析失败'); }
      var r = j && j.chart && j.chart.result && j.chart.result[0];
      if (!r) throw new Error('未返回报价');
      var m = r.meta || {};
      var price = E.finite(m.regularMarketPrice) ? m.regularMarketPrice
        : (E.finite(m.previousClose) ? m.previousClose : null);
      if (price === null) throw new Error('无有效价格');
      return {
        symbol: (m.symbol || symbol).toUpperCase(),
        price: price,
        previousClose: E.num(m.previousClose),
        change: E.finite(m.regularMarketPrice) && E.finite(m.previousClose) ? m.regularMarketPrice - m.previousClose : null,
        changePct: E.finite(m.regularMarketPrice) && E.finite(m.previousClose) && m.previousClose ? (m.regularMarketPrice / m.previousClose - 1) * 100 : null,
        currency: m.currency || 'USD',
        name: m.longName || m.shortName || '',
        marketTime: E.finite(m.regularMarketTime) ? new Date(m.regularMarketTime * 1000).toISOString() : null,
        source: res.proxy
      };
    });
  }

  /* ===========================================================================
   * 3. 期权链
   * ======================================================================== */

  /** 取得到期日列表（Unix 秒） */
  function fetchExpirations(symbol, opts) {
    var path = '/v7/finance/options/' + encodeURIComponent(symbol);
    return fetchThroughProxies(path, opts).then(function (res) {
      var j; try { j = JSON.parse(res.body); } catch (e) { throw new Error('期权链解析失败'); }
      var r = j && j.optionChain && j.optionChain.result && j.optionChain.result[0];
      if (!r) throw new Error('未返回期权链（该代码可能无期权，或接口被限制）');
      return {
        expirations: (r.expirationDates || []).map(function (t) {
          return { ts: t, date: new Date(t * 1000).toISOString().slice(0, 10) };
        }),
        strikes: r.strikes || [],
        quote: r.quote || {},
        source: res.proxy
      };
    });
  }

  /**
   * 取指定到期日的期权链，并补全计算字段（Greeks、IV、中间价等）。
   * Yahoo 只给 IV 不给 Greeks —— 这里用引擎自行补全，是本工具相对原站的核心价值之一。
   */
  function fetchChain(symbol, expirationTs, opts) {
    opts = opts || {};
    var path = '/v7/finance/options/' + encodeURIComponent(symbol) +
      (expirationTs ? '?date=' + expirationTs : '');
    return fetchThroughProxies(path, opts).then(function (res) {
      var j; try { j = JSON.parse(res.body); } catch (e) { throw new Error('期权链解析失败'); }
      var r = j && j.optionChain && j.optionChain.result && j.optionChain.result[0];
      if (!r) throw new Error('未返回期权链');
      var quote = r.quote || {};
      var spot = E.finite(quote.regularMarketPrice) ? quote.regularMarketPrice
        : (opts.spot || null);
      var opt = (r.options && r.options[0]) || null;
      if (!opt) throw new Error('该到期日无合约数据');

      var rate = E.finite(opts.rate) ? opts.rate : 0.043;
      var div = E.finite(opts.dividend) ? opts.dividend : 0;
      var expDate = new Date(opt.expirationDate * 1000).toISOString().slice(0, 10);
      var dte = Math.max(0, Math.round((opt.expirationDate * 1000 - Date.now()) / 86400000));
      var T = dte / 365;

      function enrich(arr, kind) {
        return (arr || []).map(function (o) {
          var bid = E.num(o.bid), ask = E.num(o.ask), last = E.num(o.lastPrice);
          var mid = (bid !== null && ask !== null && (bid > 0 || ask > 0))
            ? (bid + ask) / 2
            : (last !== null ? last : null);
          var iv = E.num(o.impliedVolatility);
          // Yahoo 偶尔给出异常 IV（如 0 或 > 5），用市价重解一次更可靠
          if ((iv === null || iv <= 0.001 || iv > 3) && mid !== null && mid > 0 && spot && dte > 0) {
            var solved = E.impliedVolEx(kind, mid, spot, o.strike, T, rate, div, true);
            if (solved.identifiable) iv = solved.iv;
          }
          var g = (E.finite(iv) && iv > 0 && spot && T > 0)
            ? E.greeks(kind, spot, o.strike, T, iv, rate, div) : null;
          var spread = (bid !== null && ask !== null && (bid + ask) > 0)
            ? (ask - bid) / ((ask + bid) / 2) * 100 : null;
          return {
            kind: kind, contractSymbol: o.contractSymbol || null,
            strike: E.num(o.strike), bid: bid, ask: ask, last: last, mid: mid,
            iv: iv, ivIdentifiable: !(E.finite(iv) && iv > 0 && g && Math.abs(g.vega) < 1e-4),
            volume: E.num(o.volume), openInterest: E.num(o.openInterest),
            inTheMoney: !!o.inTheMoney,
            spreadPct: spread,
            greeks: g,
            dte: dte, expiration: expDate, expirationTs: opt.expirationDate,
            // 相对现价的位置
            moneyness: spot ? (o.strike / spot - 1) * 100 : null
          };
        });
      }

      return {
        symbol: symbol.toUpperCase(),
        expiration: expDate, expirationTs: opt.expirationDate, dte: dte,
        spot: spot, calls: enrich(opt.calls, 'call'), puts: enrich(opt.puts, 'put'),
        source: res.proxy
      };
    });
  }

  /* ===========================================================================
   * 4. IV 历史：本地累积（免费获得真实 IV Rank 的方案）
   * ======================================================================== */
  var IV_STORE_KEY = 'optiondesk.ivhistory.v1';

  function loadIVHistory() {
    try {
      if (typeof localStorage === 'undefined') return {};
      return JSON.parse(localStorage.getItem(IV_STORE_KEY) || '{}');
    } catch (e) { return {}; }
  }
  /** 记录当日 IV 快照。每个 ticker 每天只保留一条。 */
  function recordIV(symbol, iv, meta) {
    if (!E.finite(iv) || typeof localStorage === 'undefined') return false;
    try {
      var all = loadIVHistory();
      var key = String(symbol).toUpperCase();
      var today = new Date().toISOString().slice(0, 10);
      all[key] = all[key] || [];
      var exists = all[key].filter(function (x) { return x.date === today; })[0];
      if (exists) { exists.iv = iv; if (meta) Object.assign(exists, meta); }
      else all[key].push(Object.assign({ date: today, iv: iv }, meta || {}));
      all[key] = all[key].slice(-780);   // 保留约 3 年
      localStorage.setItem(IV_STORE_KEY, JSON.stringify(all));
      return true;
    } catch (e) { return false; }
  }
  function getIVSeries(symbol) {
    var all = loadIVHistory();
    return all[String(symbol).toUpperCase()] || [];
  }
  /**
   * 综合 IV 位置评估。
   * 优先用本地累积的真实 IV 历史；不足时退化为「用 HV 序列做代理」
   * （IV 与实现波动率高度相关，是免费条件下的合理近似），并明确标注来源。
   */
  function ivPosition(symbol, currentIV, hist) {
    var series = getIVSeries(symbol).map(function (x) { return x.iv; });
    var source = series.length >= 30 ? 'local_iv' : (hist ? 'hv_proxy' : null);
    var used = series;
    if (series.length < 30 && hist && hist.closes) {
      // 用滚动 30 日 HV 序列作为 IV 的代理
      used = [];
      var c = hist.closes;
      for (var i = 30; i <= c.length; i++) {
        var h = E.hvCloseToClose(c.slice(0, i), 30);
        if (E.finite(h)) used.push(h);
      }
      used = used.slice(-252);
    }
    if (!used.length || !E.finite(currentIV)) return null;
    return {
      ivRank: E.ivRank(currentIV, used),
      ivPercentile: E.ivPercentile(currentIV, used),
      samples: used.length,
      source: source,
      low: Math.min.apply(null, used),
      high: Math.max.apply(null, used),
      avg: used.reduce(function (a, b) { return a + b; }, 0) / used.length,
      // HV 代理会系统性低估 IV（IV 通常高于 HV），给出提示
      caveat: source === 'hv_proxy' ? '样本不足，用历史实现波动率(HV)代理估算；IV 通常高于 HV，实际 IV Rank 可能偏低' : null
    };
  }

  /* ===========================================================================
   * 5. 手动导入（CSV / JSON）—— 无网络时的可靠兜底
   * ======================================================================== */

  /**
   * 解析期权链 CSV。期望列：
   *   type,strike,bid,ask,last,iv,volume,openInterest
   * 也容忍常见变体（kind/side、mid、mark、oi）。
   */
  function parseChainCSV(text, defaults) {
    defaults = defaults || {};
    var lines = String(text).trim().split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (lines.length < 2) throw new Error('CSV 内容不足');
    var sep = (lines[0].split('\t').length > lines[0].split(',').length) ? '\t' : ',';
    var head = lines[0].split(sep).map(function (h) { return h.trim().toLowerCase().replace(/["\s_]/g, ''); });
    function col(row, names) {
      for (var i = 0; i < names.length; i++) {
        var idx = head.indexOf(names[i]);
        if (idx >= 0 && row[idx] !== undefined) return row[idx];
      }
      return null;
    }
    var calls = [], puts = [];
    for (var i = 1; i < lines.length; i++) {
      var row = lines[i].split(sep).map(function (c) { return c.trim().replace(/^"|"$/g, ''); });
      var typeRaw = (col(row, ['type', 'kind', 'optiontype']) || '').toLowerCase();
      var strike = parseFloat(col(row, ['strike', 'k', 'strikeprice']));
      if (!E.finite(strike)) continue;
      var bid = parseFloat(col(row, ['bid'])), ask = parseFloat(col(row, ['ask']));
      var last = parseFloat(col(row, ['last', 'lastprice', 'mark', 'price', 'mid']));
      var ivRaw = parseFloat(col(row, ['iv', 'impliedvolatility', 'impliedvol', 'vol']));
      var iv = E.finite(ivRaw) ? (ivRaw > 3 ? ivRaw / 100 : ivRaw) : null;  // 自动识别 34.8 与 0.348
      var mid = (E.finite(bid) && E.finite(ask) && (bid + ask) > 0) ? (bid + ask) / 2 : (E.finite(last) ? last : null);
      var o = {
        kind: /put|p/.test(typeRaw) ? 'put' : 'call',
        strike: strike, bid: E.num(bid), ask: E.num(ask), last: E.num(last), mid: mid,
        iv: iv, volume: E.num(parseFloat(col(row, ['volume', 'vol']))),
        openInterest: E.num(parseFloat(col(row, ['openinterest', 'oi']))),
        contractSymbol: col(row, ['contractsymbol', 'symbol', 'contract']),
        inTheMoney: null, spreadPct: null, greeks: null,
        dte: E.finite(defaults.dte) ? defaults.dte : 30,
        expiration: defaults.expiration || null
      };
      (o.kind === 'put' ? puts : calls).push(o);
    }
    if (!calls.length && !puts.length) throw new Error('未识别到有效合约行');
    return { calls: calls, puts: puts, source: 'csv' };
  }

  /** 用引擎补全导入合约的 Greeks 与衍生字段 */
  function enrichImported(chain, spot, opts) {
    opts = opts || {};
    var rate = E.finite(opts.rate) ? opts.rate : 0.043;
    var div = E.finite(opts.dividend) ? opts.dividend : 0;
    ['calls', 'puts'].forEach(function (key) {
      var kind = key === 'calls' ? 'call' : 'put';
      (chain[key] || []).forEach(function (o) {
        var T = (o.dte || 30) / 365;
        if (o.iv === null && E.finite(o.mid) && o.mid > 0 && spot && T > 0) {
          var s = E.impliedVolEx(kind, o.mid, spot, o.strike, T, rate, div, true);
          if (s.identifiable) o.iv = s.iv;
        }
        if (E.finite(o.iv) && o.iv > 0 && spot && T > 0) {
          o.greeks = E.greeks(kind, spot, o.strike, T, o.iv, rate, div);
        }
        if (E.finite(o.bid) && E.finite(o.ask) && (o.bid + o.ask) > 0) {
          o.spreadPct = (o.ask - o.bid) / ((o.ask + o.bid) / 2) * 100;
        }
        o.inTheMoney = kind === 'call' ? (spot > o.strike) : (spot < o.strike);
        o.moneyness = spot ? (o.strike / spot - 1) * 100 : null;
      });
    });
    chain.spot = spot;
    return chain;
  }

  /* ===========================================================================
   * 6. 演示数据（无网络时的完整体验）
   *    数值取自 AVGO 的真实市场快照（IV30≈34.8、HV20≈32.6、HV252≈45.2）
   * ======================================================================== */
  /** 合成一段几何布朗运动历史，并按末端价格缩放（确定性，每次一致） */
  function synthHistory(endPrice, vol, days, seed) {
    var st = seed || 20240922, closes = [], highs = [], lows = [], opens = [], s = 100;
    function rnd() { st = (st * 1103515245 + 12345) & 0x7fffffff; return st / 0x7fffffff; }
    var dt = 1 / 252, sd = vol * Math.sqrt(dt);
    for (var i = 0; i < days; i++) {
      var u1 = rnd() || 1e-9, u2 = rnd();
      var z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      var o = s;
      s = s * Math.exp((-0.5 * vol * vol) * dt + sd * z);
      var c = s;
      var h = Math.max(o, c) * (1 + rnd() * 0.012);
      var l = Math.min(o, c) * (1 - rnd() * 0.012);
      opens.push(o); closes.push(c); highs.push(h); lows.push(l);
    }
    var scale = endPrice / closes[closes.length - 1];
    var dates = [];
    var startMs = Date.now() - days * 86400000;
    for (var d = 0; d < days; d++) {
      dates.push(new Date(startMs + d * 86400000).toISOString().slice(0, 10));
      closes[d] *= scale; highs[d] *= scale; lows[d] *= scale; opens[d] *= scale;
    }
    return { closes: closes, highs: highs, lows: lows, opens: opens, dates: dates };
  }

  /** 合成一段 IV 历史（均值回归形态，末值等于当前 IV） */
  function synthIVHistory(currentIV, days) {
    var out = [], st = 77771;
    function rnd() { st = (st * 1103515245 + 12345) & 0x7fffffff; return st / 0x7fffffff; }
    for (var i = 0; i < days; i++) {
      var base = 48.4 + 12 * Math.sin(i / 26) + 4.5 * Math.sin(i / 6.5);
      var noise = (rnd() - 0.5) * 7;
      out.push({ iv: E.clamp(base + noise, 33.3, 66.1) / 100 });
    }
    out[out.length - 1] = { iv: currentIV };
    var startMs = Date.now() - days * 86400000;
    out.forEach(function (o, i) {
      o.date = new Date(startMs + i * 86400000).toISOString().slice(0, 10);
    });
    return out;
  }

  function demoSnapshot(symbol) {
    symbol = (symbol || 'AVGO').toUpperCase();
    var spot = 357.61, iv = 0.348, rate = 0.043, div = 0.007;
    var history = synthHistory(spot, 0.45, 420, 20240922);
    var ivHistory = synthIVHistory(iv, 252);
    var expirations = [7, 30, 60, 120, 240, 550];
    var chains = {};
    expirations.forEach(function (dte) {
      var strikes = [];
      var step = spot >= 200 ? 10 : 5;
      var base = Math.round(spot / step) * step;
      for (var i = -8; i <= 8; i++) strikes.push(base + i * step);
      var T = dte / 365;
      // 期限结构：近月略低于远月（contango 常态）
      var tsAdj = 1 + (dte - 60) / 600;
      function mk(kind) {
        return strikes.map(function (K) {
          // IV 微笑：OTM 侧 IV 更高（股票期权的典型右偏/左偏形态）
          var m = Math.log(K / spot);
          var skew = 0.055 * m * m / 0.02 + (kind === 'put' ? -0.04 * Math.max(0, -m) / 0.2 : 0.02 * Math.max(0, m) / 0.2);
          var ivK = E.clamp(iv * tsAdj + skew, 0.08, 1.5);
          var px = E.bsPrice(kind, spot, K, T, ivK, rate, div);
          var spread = Math.max(0.01, px * 0.03);
          var bid = Math.max(0.01, px - spread / 2), ask = px + spread / 2;
          var g = E.greeks(kind, spot, K, T, ivK, rate, div);
          var oi = Math.round(200 + 4000 * Math.exp(-Math.pow((K - spot) / (spot * 0.12), 2)) + (900 - dte) * 2);
          return {
            kind: kind, strike: K, bid: +bid.toFixed(2), ask: +ask.toFixed(2),
            mid: +px.toFixed(2), last: +px.toFixed(2), iv: ivK,
            volume: Math.max(0, Math.round(oi * 0.08)), openInterest: Math.max(0, oi),
            inTheMoney: kind === 'call' ? spot > K : spot < K,
            spreadPct: px > 0 ? (ask - bid) / px * 100 : null,
            greeks: g, dte: dte, moneyness: (K / spot - 1) * 100,
            contractSymbol: null, expiration: null
          };
        });
      }
      chains[dte] = { calls: mk('call'), puts: mk('put'), dte: dte, spot: spot };
    });
    return {
      symbol: symbol, name: 'Broadcom Inc.（演示数据）', price: spot,
      previousClose: 351.20, change: 6.41, changePct: 1.83,
      iv: iv, rate: rate, dividend: div,
      history: history,
      ivHistory: ivHistory,
      realized: computeRealizedVol(history),
      ivPosition: (function () {
        var series = ivHistory.map(function (x) { return x.iv; });
        return {
          ivRank: E.ivRank(iv, series),
          ivPercentile: E.ivPercentile(iv, series),
          low: Math.min.apply(null, series), high: Math.max.apply(null, series),
          avg: series.reduce(function (a, b) { return a + b; }, 0) / series.length,
          samples: series.length, source: 'demo'
        };
      })(),
      expirations: expirations.map(function (d) {
        var dt = new Date(Date.now() + d * 86400000);
        return { dte: d, date: dt.toISOString().slice(0, 10) };
      }),
      chains: chains,
      isDemo: true
    };
  }

  /* ===========================================================================
   * 7. 一键拉取：报价 + 历史 + 到期日 + 首条链
   * ======================================================================== */
  function loadAll(symbol, opts) {
    opts = opts || {};
    var out = { symbol: String(symbol || '').toUpperCase(), errors: [], stages: [] };
    function stage(name, p) {
      return p.then(function (v) { out.stages.push({ name: name, ok: true }); return v; })
        .catch(function (e) { out.stages.push({ name: name, ok: false, err: e.message }); out.errors.push(name + '：' + e.message); return null; });
    }
    var progress = opts.onProgress || function () { };
    progress('报价', 'pending');
    return stage('报价', fetchQuote(symbol, opts)).then(function (quote) {
      out.quote = quote; progress('报价', quote ? 'ok' : 'fail');
      progress('历史波动率', 'pending');
      return stage('历史波动率', fetchHistory(symbol, '1y', opts));
    }).then(function (hist) {
      out.history = hist;
      out.realized = hist ? computeRealizedVol(hist) : null;
      progress('历史波动率', hist ? 'ok' : 'fail');
      progress('期权到期日', 'pending');
      return stage('期权到期日', fetchExpirations(symbol, opts));
    }).then(function (exp) {
      out.expirations = exp; progress('期权到期日', exp ? 'ok' : 'fail');
      var target = null;
      if (exp && exp.expirations && exp.expirations.length) {
        // 默认选 30–60 天之间最接近 45 天的到期日（theta/gamma 平衡区）
        var now = Date.now() / 1000;
        var best = null, bestScore = Infinity;
        exp.expirations.forEach(function (e) {
          var d = (e.ts - now) / 86400;
          var score = Math.abs(d - 45);
          if (score < bestScore) { bestScore = score; best = e; }
        });
        target = best;
      }
      if (!target) return null;
      progress('期权链', 'pending');
      return stage('期权链', fetchChain(symbol, target.ts, Object.assign({ spot: out.quote ? out.quote.price : null }, opts)));
    }).then(function (chain) {
      out.chain = chain; progress('期权链', chain ? 'ok' : 'fail');
      out.spot = (out.quote && out.quote.price) || (chain && chain.spot) || null;
      // IV 位置
      if (out.spot && chain && chain.calls && chain.calls.length) {
        var atm = nearestATM(chain, out.spot);
        out.atmIV = atm ? atm.iv : null;
        out.ivPosition = ivPosition(symbol, out.atmIV, out.history);
        if (out.atmIV) recordIV(symbol, out.atmIV, { dte: chain.dte });
      }
      return out;
    });
  }

  /* ===========================================================================
   * 6b. 由 Python 抓取器（fetch.py）產生嘅 Nasdaq 快照還原成內部格式
   *     呢個係「烤入 HTML」模式嘅核心：打開就有真實數據，完全唔使網絡。
   * ======================================================================== */

  /**
   * @param {Object} raw  fetch.py 輸出嘅 {symbol, quote, history, chains, meta}
   * @param {Object} opts {rate, dividend}
   */
  function fromNasdaq(raw, opts) {
    opts = opts || {};
    if (!raw || !raw.quote || !raw.history) return null;
    var rate = E.finite(opts.rate) ? opts.rate : 0.04;
    var div = E.finite(opts.dividend) ? opts.dividend : (raw.quote.yield || 0);
    var spot = raw.quote.price;
    if (!E.finite(spot) || spot <= 0) return null;

    function round2(v) { return Math.round(v * 100) / 100; }

    // ---- 歷史 → {opens,highs,lows,closes,dates}
    var hist = { opens: [], highs: [], lows: [], closes: [], dates: [], volumes: [] };
    raw.history.forEach(function (r) {
      if (!E.finite(r.close) || r.close <= 0) return;
      hist.closes.push(r.close);
      hist.highs.push(E.finite(r.high) ? r.high : r.close);
      hist.lows.push(E.finite(r.low) ? r.low : r.close);
      hist.opens.push(E.finite(r.open) ? r.open : r.close);
      hist.dates.push(r.date);
      hist.volumes.push(r.volume || 0);
    });
    if (hist.closes.length < 3) return null;
    var realized = computeRealizedVol(hist);

    // ---- 到期日 / 選擇權鏈
    var nowMs = Date.now();
    var expirations = [], chains = {};
    var qTotal = 0, qSkipNoQuote = 0, qSkipNoIV = 0;

    (raw.chains || []).forEach(function (c) {
      var expMs = Date.parse(c.expiry + 'T20:00:00Z');
      if (!isFinite(expMs)) return;
      var dteFloat = (expMs - nowMs) / 86400000;
      if (dteFloat < 0) return;                       // 已過期
      var dte = Math.max(0, Math.round(dteFloat));
      var T = Math.max(dteFloat, 2 / 24) / 365;       // 最少 2 小時，避免 T=0
      expirations.push({ dte: dte, date: c.expiry, ts: Math.round(expMs / 1000) });

      var calls = [], puts = [];
      ['calls', 'puts'].forEach(function (side) {
        var kind = side === 'calls' ? 'call' : 'put';
        var outArr = side === 'calls' ? calls : puts;
        (c[side] || []).forEach(function (o) {
          qTotal++;
          var K = o.strike;
          if (!E.finite(K) || K <= 0) return;
          var bid = E.finite(o.bid) ? o.bid : null;
          var ask = E.finite(o.ask) ? o.ask : null;
          var last = E.finite(o.last) ? o.last : null;
          var mid = (bid != null && ask != null && ask >= bid) ? (bid + ask) / 2
            : (last != null ? last : (bid != null ? bid : ask));
          if (!(mid > 0)) { qSkipNoQuote++; return; }

          // 美式契約（美股），IV 反解失敗 / 不可辨識就剔走，
          // 避免深度價內低時間值合約污染 IV 曲面
          var ex = E.impliedVolEx(kind, mid, spot, K, T, rate, div, true);
          if (!(ex && E.finite(ex.iv) && ex.identifiable)) { qSkipNoIV++; return; }
          var iv = ex.iv;

          var g = E.greeks(kind, spot, K, T, iv, rate, div);
          var theo = E.bsPrice(kind, spot, K, T, iv, rate, div);
          outArr.push({
            kind: kind, strike: K,
            bid: bid != null ? round2(bid) : null,
            ask: ask != null ? round2(ask) : null,
            last: last != null ? round2(last) : null,
            mid: round2(mid), iv: iv, theo: round2(theo),
            volume: o.volume || 0, openInterest: o.openInterest || 0,
            inTheMoney: kind === 'call' ? spot > K : spot < K,
            spreadPct: (bid != null && ask != null && mid > 0) ? round2((ask - bid) / mid * 100) : null,
            greeks: g, dte: dte, moneyness: round2((K / spot - 1) * 100),
            contractSymbol: null, expiration: c.expiry
          });
        });
      });

      calls.sort(function (a, b) { return a.strike - b.strike; });
      puts.sort(function (a, b) { return a.strike - b.strike; });
      if (!calls.length && !puts.length) return;
      chains[dte] = { calls: calls, puts: puts, dte: dte, spot: spot, expiration: c.expiry };
    });

    expirations.sort(function (a, b) { return a.dte - b.dte; });
    if (!Object.keys(chains).length) return null;

    // ---- ATM IV：取 30–60 天最接近 45 天嘅到期日（theta/gamma 平衡區）
    var picked = null, bestScore = Infinity;
    Object.keys(chains).forEach(function (k) {
      var score = Math.abs(+k - 45);
      if (score < bestScore) { bestScore = score; picked = chains[k]; }
    });
    var atmIV = null;
    var atmObj = picked ? nearestATM(picked, spot) : null;
    if (atmObj && E.finite(atmObj.iv)) atmIV = atmObj.iv;

    // ---- IV 歷史代理：滾動 30 日 HV（誠實標註，唔係真 IV 序列）
    var ivHistory = [];
    for (var j = 30; j < hist.closes.length; j++) {
      var hh = E.hvCloseToClose(hist.closes.slice(0, j + 1), 30);
      if (E.finite(hh)) ivHistory.push({ date: hist.dates[j], iv: hh });
    }
    ivHistory.push({ date: hist.dates[hist.dates.length - 1], iv: atmIV });
    if (!E.finite(atmIV)) ivHistory.pop();

    return {
      symbol: raw.symbol,
      name: raw.quote.name,
      price: spot,
      iv: atmIV,
      atmIV: atmIV,
      previousClose: raw.quote.previousClose,
      change: raw.quote.change,
      changePct: raw.quote.changePct,
      bid: raw.quote.bid, ask: raw.quote.ask,
      quoteSource: raw.source,
      fetchedAt: raw.fetchedAt,
      rate: rate, dividend: div,
      fiftyTwoHigh: raw.quote.fiftyTwoHigh, fiftyTwoLow: raw.quote.fiftyTwoLow,
      marketCap: raw.quote.marketCap, sector: raw.quote.sector, industry: raw.quote.industry,
      history: hist,
      realized: realized,
      ivHistory: ivHistory,
      expirations: expirations,
      chains: chains,
      defaultDte: picked ? picked.dte : null,
      atmIV: atmIV,
      ivPosition: ivPosition(raw.symbol, atmIV, hist),
      isDemo: false,
      isSnapshot: true,
      quality: { total: qTotal, noQuote: qSkipNoQuote, noIV: qSkipNoIV, kept: qTotal - qSkipNoQuote - qSkipNoIV }
    };
  }

  /** 找最接近 ATM 的合约（按 |moneyness| 最小） */
  function nearestATM(chain, spot) {
    var pool = (chain.calls || []).concat(chain.puts || []);
    if (!pool.length || !spot) return null;
    var best = null, bd = Infinity;
    pool.forEach(function (o) {
      if (!E.finite(o.strike) || !E.finite(o.iv)) return;
      var d = Math.abs(o.strike - spot);
      if (d < bd) { bd = d; best = o; }
    });
    return best;
  }

  /** 期限结构：取各到期日 ATM 合约的 IV */
  function buildTermStructure(chainsByDte, spot) {
    var pts = [];
    Object.keys(chainsByDte || {}).forEach(function (k) {
      var c = chainsByDte[k];
      var atm = nearestATM(c, spot || c.spot);
      if (atm && E.finite(atm.iv)) {
        pts.push({ dte: c.dte, iv: atm.iv * 100, strike: atm.strike });
      }
    });
    return pts.sort(function (a, b) { return a.dte - b.dte; });
  }

  /* ===========================================================================
   * 6c. 即時模式：直接由 Nasdaq 官方 API 拉（需 proxy.py 或任何 CORS 代理）
   *     形狀同 fetch.py 嘅輸出，可以直接餵畀 fromNasdaq()。
   * ======================================================================== */
  var NASDAQ_BASE = 'https://api.nasdaq.com/api/quote';

  function nnum(s) {
    if (s == null) return null;
    var t = String(s).replace(/[$,%\s]/g, '').replace(/,/g, '');
    if (t === '' || t === '--' || t === 'N/A' || t === '—') return null;
    var v = parseFloat(t);
    return isFinite(v) ? v : null;
  }

  function nasdaqPath(path, opts) {
    return fetchThroughProxies(path, opts).then(function (res) {
      try { return JSON.parse(res.body); } catch (e) { throw new Error('Nasdaq 回應無法解析'); }
    });
  }

  /** 報價 —— 對應 fetch.py 的 fetch_quote + fetch_summary */
  function nasdaqQuote(symbol, opts) {
    var p = NASDAQ_BASE + '/' + encodeURIComponent(symbol) + '/info?assetclass=stocks';
    return nasdaqPath(p, opts).then(function (j) {
      var d = (j && j.data) || null;
      if (!d) throw new Error('搵唔到報價（代碼可能有錯）');
      var pr = d.primaryData || {}, se = d.secondaryData || {};
      return {
        symbol: d.symbol || String(symbol).toUpperCase(),
        name: d.companyName,
        exchange: d.exchange,
        price: nnum(pr.lastSalePrice) || nnum(se.lastSalePrice),
        change: nnum(pr.netChange),
        changePct: nnum(pr.percentageChange),
        bid: nnum(pr.bidPrice) || nnum(se.bidPrice),
        ask: nnum(pr.askPrice) || nnum(se.askPrice),
        volume: nnum(pr.volume),
        isRealTime: pr.isRealTime,
        asOf: pr.lastTradeTimestamp
      };
    });
  }

  /** 摘要（失敗唔致命 —— 52 週高低會由歷史日線推算） */
  function nasdaqSummary(symbol, opts) {
    var p = NASDAQ_BASE + '/' + encodeURIComponent(symbol) + '/summary?assetclass=stocks';
    return nasdaqPath(p, opts).then(function (j) {
      var sd = ((j && j.data) || {}).summaryData || {};
      var out = {};
      function v(k) { return sd[k] ? sd[k].value : null; }
      var hl = v('FiftTwoWeekHighLow') || v('FiftTwoWkHighLow');
      if (hl && String(hl).indexOf('-') > 0) {
        var parts = String(hl).split('-');
        out.fiftyTwoHigh = nnum(parts[0]); out.fiftyTwoLow = nnum(parts[1]);
      }
      out.marketCap = nnum(v('MarketCap'));
      out.yield = (function (y) { var x = nnum(y); return x == null ? null : x / 100; })(v('Yield'));
      out.sector = v('Sector'); out.industry = v('Industry');
      out.oneYrTarget = nnum(v('OneYrTarget'));
      out.averageVolume = nnum(v('AverageVolume'));
      out.previousClose = nnum(v('PreviousClose'));
      return out;
    }).catch(function () { return {}; });
  }

  /** 歷史日線 —— 對應 fetch_history */
  function nasdaqHistory(symbol, opts) {
    opts = opts || {};
    var years = opts.years || 1.2;
    var end = new Date(), start = new Date(end.getTime() - 365 * years * 86400000);
    function iso(d) { return d.toISOString().slice(0, 10); }
    var p = NASDAQ_BASE + '/' + encodeURIComponent(symbol) + '/historical?assetclass=stocks'
      + '&fromdate=' + iso(start) + '&todate=' + iso(end) + '&limit=9999';
    return nasdaqPath(p, opts).then(function (j) {
      var rows = (((j && j.data) || {}).tradesTable || {}).rows || [];
      var out = [];
      rows.forEach(function (r) {
        if (!r.date) return;
        // Nasdaq 用 MM/DD/YYYY
        var m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(r.date);
        var close = nnum(r.close);
        if (!m || !(close > 0)) return;
        out.push({
          date: m[3] + '-' + m[1] + '-' + m[2],
          open: nnum(r.open), high: nnum(r.high), low: nnum(r.low),
          close: close, volume: nnum(r.volume)
        });
      });
      out.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      if (out.length < 3) throw new Error('歷史數據不足');
      return out;
    });
  }

  /** 完整選擇權鏈 —— 對應 fetch_chain */
  function nasdaqChain(symbol, opts) {
    opts = opts || {};
    // 24 個月：涵蓋到 LEAPS 長倉（之前只攞 4 個月，用戶反映唔夠遠期到期日）
    var months = opts.months || 24;
    var today = new Date(), end = new Date(today.getTime() + 30.4 * months * 86400000);
    function iso(d) { return d.toISOString().slice(0, 10); }
    var p = NASDAQ_BASE + '/' + encodeURIComponent(symbol) + '/option-chain?assetclass=stocks'
      + '&fromdate=' + iso(today) + '&todate=' + iso(end) + '&limit=99999';
    return nasdaqPath(p, Object.assign({}, opts, { timeout: (opts.timeout || 10000) + 15000 }))
      .then(function (j) {
        var data = (j && j.data) || null;
        var rows = ((data && data.table) || {}).rows || [];
        if (!rows.length) throw new Error('冇選擇權鏈（可能代碼唔支援期權）');
        var chains = [], cur = null;
        rows.forEach(function (r) {
          if (r.expirygroup) {
            var m = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(r.expirygroup);
            if (!m) return;
            var mon = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
              'august', 'september', 'october', 'november', 'december']
              .indexOf(m[1].toLowerCase()) + 1;
            if (!mon) return;
            var dd = ('0' + m[2]).slice(-2), mm = ('0' + mon).slice(-2);
            cur = { expiry: m[3] + '-' + mm + '-' + dd, raw: r.expirygroup, calls: [], puts: [] };
            chains.push(cur);
            return;
          }
          if (!cur) return;
          var K = parseFloat(r.strike);
          if (!isFinite(K)) return;
          [['calls', 'c_'], ['puts', 'p_']].forEach(function (pair) {
            var bid = nnum(r[pair[1] + 'Bid']), ask = nnum(r[pair[1] + 'Ask']), last = nnum(r[pair[1] + 'Last']);
            if (bid == null && ask == null && last == null) return;
            cur[pair[0]].push({
              strike: K, bid: bid, ask: ask, last: last,
              volume: parseInt(r[pair[1] + 'Volume'] || 0, 10) || 0,
              openInterest: parseInt(r[pair[1] + 'Openinterest'] || 0, 10) || 0
            });
          });
        });
        chains = chains.filter(function (c) { return c.calls.length || c.puts.length; });
        if (!chains.length) throw new Error('選擇權鏈為空');
        return chains;
      });
  }

  /**
   * 一鍵：Nasdaq 報價 + 摘要 + 歷史 + 鏈，直接還原成内部快照。
   * 失敗時向外拋，畀上層決定 fallback。
   */
  function loadNasdaq(symbol, opts) {
    opts = opts || {};
    var raw = { symbol: String(symbol).toUpperCase(), quote: null, history: null, chains: null };
    var progress = opts.onProgress || function () { };
    progress('Nasdaq 報價', 'pending');
    return nasdaqQuote(symbol, opts).then(function (q) {
      raw.quote = q;
      progress('Nasdaq 報價', 'ok');
      progress('Nasdaq 摘要', 'pending');
      return nasdaqSummary(symbol, opts);
    }).then(function (s) {
      Object.assign(raw.quote, s);
      progress('Nasdaq 摘要', 'ok');
      progress('歷史波動率', 'pending');
      return nasdaqHistory(symbol, opts);
    }).then(function (h) {
      raw.history = h;
      raw.source = 'Nasdaq public API (api.nasdaq.com) — free, no key';
      raw.fetchedAt = new Date().toLocaleString('zh-CN', { hour12: false });
      progress('歷史波動率', 'ok');
      progress('期權鏈', 'pending');
      return nasdaqChain(symbol, opts);
    }).then(function (c) {
      raw.chains = c;
      progress('期權鏈', 'ok');
      var snap = fromNasdaq(raw, { rate: opts.rate, dividend: opts.dividend });
      if (!snap) throw new Error('快照還原失敗');
      return snap;
    });
  }

  /* ===========================================================================
   * 6c. 由烤入嘅掃描數據（window.__DESK_SCAN__）即時還原 IV 指標 + 報價。
   *     掃描過嘅 150 隻股零網絡即時可得——GitHub Pages 線上版嘅主力路徑。
   *     注意：掃描數據只含單一近月到期日摘要，無完整期權鏈，
   *           so 期權鏈仍需即時代理（自訂 Worker）或首選股快照。
   * ======================================================================== */
  function loadFromScan(symbol) {
    var scan = (typeof window !== 'undefined') && window.__DESK_SCAN__;
    if (!scan || !scan.results || !scan.results.length) return null;
    var r = null;
    for (var i = 0; i < scan.results.length; i++) {
      if (String(scan.results[i].symbol || '').toUpperCase() === String(symbol).toUpperCase()) { r = scan.results[i]; break; }
    }
    if (!r) return null;
    if (!E.finite(r.price) || r.price <= 0) return null;
    return {
      symbol: String(symbol).toUpperCase(),
      price: r.price,
      change: E.finite(r.change) ? r.change : null,
      changePct: E.finite(r.changePct) ? r.changePct : null,
      iv: E.finite(r.iv30) ? r.iv30 : null,
      realized: {
        hv10: E.finite(r.hv10) ? r.hv10 : null, hv20: E.finite(r.hv20) ? r.hv20 : null,
        hv60: E.finite(r.hv60) ? r.hv60 : null, hv252: E.finite(r.hv252) ? r.hv252 : null,
        hvBlend: E.finite(r.hvBlend) ? r.hvBlend : null
      },
      ivPosition: {
        ivRank: E.finite(r.ivRank) ? r.ivRank : null,
        vr: E.finite(r.vr) ? r.vr : null,
        ts: E.finite(r.ts) ? r.ts : null,
        skew25: E.finite(r.skew25) ? r.skew25 : null
      },
      isFromScan: true,
      isDemo: false
    };
  }

  return {
    PROXIES: PROXIES, NASDAQ_BASE: NASDAQ_BASE,
    fetchThroughProxies: fetchThroughProxies,
    fetchQuote: fetchQuote, fetchHistory: fetchHistory,
    fetchExpirations: fetchExpirations, fetchChain: fetchChain,
    computeRealizedVol: computeRealizedVol,
    loadAll: loadAll, nearestATM: nearestATM, buildTermStructure: buildTermStructure,
    ivPosition: ivPosition, recordIV: recordIV, getIVSeries: getIVSeries, loadIVHistory: loadIVHistory,
    parseChainCSV: parseChainCSV, enrichImported: enrichImported,
    demoSnapshot: demoSnapshot, fromNasdaq: fromNasdaq, loadNasdaq: loadNasdaq, loadFromScan: loadFromScan,
    nasdaqQuote: nasdaqQuote, nasdaqHistory: nasdaqHistory, nasdaqChain: nasdaqChain
  };
});
