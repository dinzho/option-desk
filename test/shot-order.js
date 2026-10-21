const { chromium } = require('playwright-core');
const path = require('path');
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  await page.goto('file://' + path.resolve(__dirname, '..', 'OptionDesk.html'), { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  // 截 MSTR 卡（今日可出手專區第一張）
  const mstr = await page.$('.scan-section.is-act .scan-card[data-sym="MSTR"]');
  if (mstr) await mstr.screenshot({ path: 'test/shot-mstr-order.png' });
  const tsla = await page.$('.scan-card[data-sym="TSLA"]');
  if (tsla) await tsla.screenshot({ path: 'test/shot-tsla-order.png' });
  await browser.close();
  console.log('done');
})();
