const { chromium } = require('playwright-core');
const path = require('path');
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.goto('file://' + path.resolve(__dirname, '..', 'OptionDesk.html'), { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const r = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.scan-card')];
    const withOrder = cards.filter(c => c.querySelector('.scs-order'));
    return {
      totalCards: cards.length,
      cardsWithOrderBlock: withOrder.length,
      samples: withOrder.slice(0, 4).map(c => {
        const o = c.querySelector('.scs-order');
        return {
          sym: c.querySelector('.sc-sym b').textContent,
          legs: [...o.querySelectorAll('.ord-leg')].map(l => l.textContent.trim()),
          hint: (o.querySelector('.ord-hint') || {}).textContent.trim()
        };
      })
    };
  });
  console.log(JSON.stringify(r, null, 2));
  console.log('JS errors:', errors.length ? errors : 'none');
  await browser.close();
})();
