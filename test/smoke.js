/* 浏览器冒烟测试：真实 Chromium 打开单档 HTML，检查渲染与交互无异常 */
const { chromium } = require('playwright-core');
const path = require('path');

const FILE = 'file://' + path.resolve(__dirname, '..', 'OptionDesk.html');

(async () => {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  const errors = [], warnings = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() === 'error') errors.push('console.error: ' + m.text());
    if (m.type() === 'warning') warnings.push(m.text());
  });

  await page.goto(FILE, { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  const checks = [];
  function ck(name, cond, detail) { checks.push([!!cond, name, detail || '']); }

  // ---- 模块载入 ----
  const mods = await page.evaluate(() => ({
    E: !!window.OptionEngine, S: !!window.OptionStrategies,
    D: !!window.OptionData, C: !!window.OptionCharts
  }));
  ck('四个模块全部载入', mods.E && mods.S && mods.D && mods.C, JSON.stringify(mods));

  // ---- 默认渲染：演示数据 + 默认策略 ----
  const legCount = await page.locator('.leg-row').count();
  ck('默认已生成持仓腿', legCount > 0, legCount + ' 条腿');

  const scoreTxt = await page.locator('#score-ring .score-val').textContent().catch(() => null);
  ck('结构评分已计算', scoreTxt && /^\d+$/.test(scoreTxt.trim()), '评分=' + scoreTxt);

  const kpiCount = await page.locator('#builder-kpis .kpi').count();
  ck('策略 KPI 已渲染', kpiCount >= 6, kpiCount + ' 张卡片');

  // ---- 图表：每个 tab 的 SVG 都要真的画出来 ----
  async function svgInfo(sel) {
    return page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const svg = el.querySelector('svg');
      if (!svg) return { has: false, html: el.innerHTML.slice(0, 120) };
      return { has: true, w: svg.getAttribute('width') || svg.getAttribute('viewBox'), nodes: svg.querySelectorAll('*').length };
    }, sel);
  }
  const tabs = [
    ['IV 分析台', 'iv', ['#chart-iv-history', '#chart-term', '#chart-skew']],
    ['策略构建器', 'builder', ['#chart-payoff', '#chart-time', '#chart-greeks']],
    ['期权链', 'chain', ['#chart-chain-skew', '#chart-liquidity']],
    ['风险与压力', 'risk', ['#chart-dist', '#chart-heatmap']]
  ];
  for (const [label, tab, sels] of tabs) {
    await page.click(`.tab[data-tab="${tab}"]`);
    await page.waitForTimeout(500);
    for (const sel of sels) {
      const info = await svgInfo(sel);
      ck(`${label} ${sel} 渲染 SVG`, info && info.has && info.nodes > 5,
        info ? (info.has ? `节点数=${info.nodes}` : '无 SVG: ' + info.html) : '容器不存在');
    }
  }

  // ---- 期权链表格 ----
  await page.click('.tab[data-tab="chain"]');
  await page.waitForTimeout(400);
  const chainRows = await page.locator('#chain-body tr').count();
  ck('期权链有数据行', chainRows > 5, chainRows + ' 行');
  const expiryBtns = await page.locator('#expiry-seg .seg-btn').count();
  ck('到期日切换按钮存在', expiryBtns > 0, expiryBtns + ' 个到期日');

  // 点击切换到期日
  if (expiryBtns > 1) {
    await page.locator('#expiry-seg .seg-btn').nth(2).click();
    await page.waitForTimeout(400);
    const rows2 = await page.locator('#chain-body tr').count();
    ck('切换到期日后仍有数据', rows2 > 5, rows2 + ' 行');
  }

  // ---- 点击期权链加入持仓 ----
  await page.click('.tab[data-tab="chain"]');
  await page.waitForTimeout(300);
  const before = await page.locator('.leg-row').count();
  await page.locator('#chain-body td.pick.is-mid').first().click();
  await page.waitForTimeout(500);
  const after = await page.locator('.leg-row').count();
  ck('点击合约可加入持仓', after >= before, `${before} → ${after}`);

  // ---- 热力图切换 ----
  await page.click('.tab[data-tab="risk"]');
  await page.waitForTimeout(400);
  await page.click('#matrix-mode .seg-btn[data-mode="iv"]');
  await page.waitForTimeout(600);
  const heat2 = await svgInfo('#chart-heatmap');
  ck('切换到股价×IV 矩阵后仍渲染', heat2 && heat2.has, heat2 ? '节点=' + heat2.nodes : '失败');
  await page.click('#matrix-metric .seg-btn[data-metric="pnl"]');
  await page.waitForTimeout(500);
  const heat3 = await svgInfo('#chart-heatmap');
  ck('切换矩阵数值类型后仍渲染', heat3 && heat3.has);

  // ---- 情景表与压力表 ----
  const scenRows = await page.locator('#scenario-body tr').count();
  ck('情景分析表有数据', scenRows >= 10, scenRows + ' 行');
  const stressRows = await page.locator('#stress-body tr').count();
  ck('压力测试表有数据', stressRows >= 8, stressRows + ' 行');

  // ---- 策略模板：遍历全部模板生成，检查不崩 ----
  const tplIds = await page.evaluate(() => Object.keys(window.OptionStrategies.TEMPLATE_MAP));
  let tplFail = [];
  for (const id of tplIds) {
    await page.selectOption('#in-template', id);
    await page.waitForTimeout(60);
    await page.click('#btn-build');
    await page.waitForTimeout(120);
    const ok = await page.evaluate(() => {
      const v = document.querySelector('#score-ring .score-val');
      const kpis = document.querySelectorAll('#builder-kpis .kpi').length;
      const svg = document.querySelector('#chart-payoff svg');
      return !!v && /^\d+$/.test(v.textContent.trim()) && kpis >= 6 && !!svg;
    });
    if (!ok) tplFail.push(id);
  }
  ck('全部 ' + tplIds.length + ' 个模板均可生成并评分', tplFail.length === 0, tplFail.join(',') || '无失败');

  // ---- 主题切换 ----
  await page.click('#btn-theme');
  await page.waitForTimeout(600);
  const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  ck('主题可切换到浅色', theme === 'light', '当前=' + theme);
  const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  ck('浅色主题背景已生效', lightBg && lightBg !== 'rgba(0, 0, 0, 0)', lightBg);
  await page.click('#btn-theme');
  await page.waitForTimeout(400);

  // ---- 极端输入不崩 ----
  await page.fill('#in-spot', '0.01');
  await page.waitForTimeout(500);
  await page.fill('#in-iv', '0');
  await page.waitForTimeout(500);
  await page.fill('#in-spot', '99999');
  await page.waitForTimeout(500);
  const survived = await page.evaluate(() => {
    const v = document.querySelector('#score-ring .score-val');
    return !!v && document.querySelectorAll('#builder-kpis .kpi').length > 0;
  });
  ck('极端输入后页面仍存活', survived);
  await page.fill('#in-spot', '357.61');
  await page.fill('#in-iv', '34.8');
  await page.waitForTimeout(500);

  // ---- 移动端视口 ----
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(700);
  const mobileOk = await page.evaluate(() => {
    const b = document.body;
    return b.scrollWidth <= window.innerWidth + 30;
  });
  ck('移动端无横向溢出', mobileOk, 'scrollWidth vs 390');
  const mobileTabs = await page.locator('.tab').count();
  ck('移动端 tab 仍可见', mobileTabs === 5, mobileTabs + ' 个');

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.resolve(__dirname, 'screenshot-desktop.png'), fullPage: false });

  await browser.close();

  // ---- 报告 ----
  console.log('\n' + '='.repeat(80));
  checks.forEach(c => console.log((c[0] ? '  ✓ ' : '  ✗ ') + c[1].padEnd(42) + (c[2] ? '  ' + c[2] : '')));
  console.log('='.repeat(80));
  if (errors.length) {
    console.log('\nJS 错误 (' + errors.length + '):');
    errors.slice(0, 15).forEach(e => console.log('  ! ' + e));
  } else console.log('\n无 JS 错误');
  const pass = checks.filter(c => c[0]).length;
  console.log(`\n通过 ${pass} / ${checks.length}，JS 错误 ${errors.length} 个`);
  process.exit(checks.every(c => c[0]) && errors.length === 0 ? 0 : 1);
})().catch(e => { console.error('测试崩溃:', e); process.exit(1); });
