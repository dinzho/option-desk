const { chromium } = require('playwright-core');
const URL = process.argv[2] || 'https://6ad86737d0750031480aa963--tranquil-kashata-30dac0.netlify.app';

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  const r = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.scan-card')];
    const data = window.__DESK_SCAN__;
    const empty = cards.filter(c => c.querySelector('.sc-struct') && !c.querySelector('.leg'));
    return {
      tabActive: (document.querySelector('.tab.is-active') || {}).textContent.trim(),
      cardCount: cards.length,
      expectCount: data.results.length,
      scatterDots: document.querySelectorAll('.sc-svg circle').length,
      emptyStructBox: empty.length,
      verdict: (document.querySelector('.scan-verdict') || {}).textContent.trim().slice(0, 80),
      sample: cards.slice(0, 3).map(c => ({
        sym: (c.querySelector('.sc-sym') || {}).textContent.replace(/\s.*/, ''),
        exp: (c.querySelector('.sc-expiry') || {}).textContent.trim(),
        legs: [...c.querySelectorAll('.leg')].map(l => l.textContent.trim()),
        be: (c.querySelector('.scs-be') || {}).textContent.trim()
      }))
    };
  });
  console.log(JSON.stringify(r, null, 2));
  console.log('JS errors:', errors.length ? errors : 'none');
  await browser.close();
})();
