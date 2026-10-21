const { chromium } = require('playwright-core');
const URL = 'https://tranquil-kashata-30dac0.netlify.app/';

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);

  // 直接測數據層：loadNasdaq 經 Netlify Function 讀真實數據
  const r = await page.evaluate(async () => {
    try {
      const snap = await window.OptionData.loadNasdaq('MSFT', { months: 2 });
      return {
        ok: true,
        symbol: snap.symbol,
        name: snap.name,
        price: snap.price,
        atmIV: snap.atmIV != null ? +(snap.atmIV * 100).toFixed(1) + '%' : null,
        expirations: (snap.expirations || []).length,
        isDemo: !!snap.isDemo,
        chains: Object.keys(snap.chains || {}).length
      };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  });
  console.log('loadNasdaq(MSFT) 結果:', JSON.stringify(r, null, 2));
  console.log('JS errors:', errors.length ? errors : 'none');
  await browser.close();
})();
