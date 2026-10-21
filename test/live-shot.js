const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  await page.goto('https://option-desk.netlify.app/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3500);
  const mstr = await page.$('.scan-section.is-act .scan-card[data-sym="MSTR"]');
  if (mstr) await mstr.screenshot({ path: 'test/live-mstr-order.png' });
  await browser.close();
  console.log('shot done');
})();
