const { chromium } = require('playwright-core');
const URL = process.argv[2] || 'https://tranquil-kashata-30dac0.netlify.app/';

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  const r = await page.evaluate(() => {
    const data = window.__DESK_SCAN__;
    const res = data.results;
    const isAct = x => (x.score || 0) >= 65 && x.multiTrigger;
    const actN = res.filter(isAct).length;
    const cards = [...document.querySelectorAll('.scan-card')];
    const empty = cards.filter(c => c.querySelector('.sc-struct') && !c.querySelector('.leg'));
    const actSection = document.querySelector('.scan-section.is-act');
    const watchSection = document.querySelector('.scan-section.is-watch');
    return {
      survived: res.length,
      actionableExpected: actN,
      hasActSection: !!actSection,
      actSectionCount: actSection ? (actSection.querySelector('.ss-count') || {}).textContent : null,
      actCardsInSection: actSection ? actSection.querySelectorAll('.scan-card').length : 0,
      watchCardsInSection: watchSection ? watchSection.querySelectorAll('.scan-card').length : 0,
      ribbonCount: document.querySelectorAll('.sc-act-ribbon').length,
      emptyStructBox: empty.length,
      scatterDots: document.querySelectorAll('.sc-svg circle').length,
      verdict: (document.querySelector('.scan-verdict') || {}).textContent.trim().slice(0, 60),
      actSample: actSection ? [...actSection.querySelectorAll('.scan-card')].slice(0, 3).map(c => ({
        sym: (c.querySelector('.sc-sym b') || {}).textContent,
        tag: (c.querySelector('.scan-tag') || {}).textContent,
        exp: (c.querySelector('.sc-expiry') || {}).textContent.trim(),
        be: (c.querySelector('.scs-be') || {}).textContent.trim()
      })) : []
    };
  });
  console.log(JSON.stringify(r, null, 2));
  console.log('JS errors:', errors.length ? errors : 'none');
  await browser.close();
})();
