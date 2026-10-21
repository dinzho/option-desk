const { chromium } = require('playwright-core');
const path = require('path');
const FILE = 'file://' + path.resolve(__dirname, '..', 'OptionDesk.html');

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  await page.goto(FILE, { waitUntil: 'load' });
  await page.waitForTimeout(1500);

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
      tabActive: (document.querySelector('.tab.is-active') || {}).textContent.trim(),
      total: res.length,
      actionableExpected: actN,
      // 專區
      hasActSection: !!actSection,
      hasWatchSection: !!watchSection,
      actSectionTitle: actSection ? (actSection.querySelector('.ss-title') || {}).textContent : null,
      actSectionCount: actSection ? (actSection.querySelector('.ss-count') || {}).textContent : null,
      actCardsInSection: actSection ? actSection.querySelectorAll('.scan-card').length : 0,
      watchCardsInSection: watchSection ? watchSection.querySelectorAll('.scan-card').length : 0,
      // 可出手卡角標 / class
      ribbonCount: document.querySelectorAll('.sc-act-ribbon').length,
      isActCards: document.querySelectorAll('.scan-card.is-act').length,
      // 質素
      emptyStructBox: empty.length,
      scatterDots: document.querySelectorAll('.sc-svg circle').length,
      sample: actSection ? [...actSection.querySelectorAll('.scan-card')].slice(0, 3).map(c => ({
        sym: (c.querySelector('.sc-sym b') || {}).textContent,
        exp: (c.querySelector('.sc-expiry') || {}).textContent.trim(),
        be: (c.querySelector('.scs-be') || {}).textContent.trim()
      })) : []
    };
  });
  console.log(JSON.stringify(r, null, 2));
  console.log('JS errors:', errors.length ? errors : 'none');
  await browser.close();
})();
