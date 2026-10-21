const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.goto('https://option-desk.netlify.app/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3500);

  // 1. 線上 MSTR 卡「點樣落單」
  const order = await page.evaluate(() => {
    const c = document.querySelector('.scan-card[data-sym="MSTR"]');
    if (!c) return null;
    const o = c.querySelector('.scs-order');
    return o ? {
      legs: [...o.querySelectorAll('.ord-leg')].map(l => l.textContent.trim()),
      hint: (o.querySelector('.ord-hint') || {}).textContent.trim()
    } : null;
  });

  // 2. 左上角輸入股票 → 經 Netlify Function 載入真實數據
  const load = await page.evaluate(async () => {
    const mod = window.OptionData || {};
    const fn = mod.loadNasdaq;
    if (!fn) return { err: 'loadNasdaq not found' };
    try {
      const d = await fn('AAPL');
      return { sym: 'AAPL', price: d && (d.price || (d.quote && d.quote.price)), isDemo: d && d.isDemo, raw: JSON.stringify(d).slice(0, 120) };
    } catch (e) { return { err: String(e) }; }
  });

  console.log('線上 MSTR 落單指示:', JSON.stringify(order, null, 2));
  console.log('輸入股票載入:', JSON.stringify(load));
  console.log('JS errors:', errors.length ? errors : 'none');
  await browser.close();
})();
