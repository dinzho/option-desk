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
    const cards = [...document.querySelectorAll('.scan-card')];
    const data = window.__DESK_SCAN__;
    const res = data.results;
    const opp = res.filter(x => x.structure && x.structure.legs && x.structure.legs.length);
    // 有結構盒但零腿 = 交白卷，一定要 0
    const emptyBox = cards.filter(c => c.querySelector('.sc-struct') && !c.querySelector('.leg'));
    return {
      tabActive: (document.querySelector('.tab.is-active') || {}).textContent.trim(),
      cardCount: cards.length,
      expectCount: res.length,
      scatterDots: document.querySelectorAll('.sc-svg circle').length,
      emptyStructBox: emptyBox.length,
      emptyBoxSyms: emptyBox.map(c => (c.querySelector('.sc-sym') || {}).textContent),
      // 每个有结构的标题都应有到期日 + 损平
      structNoExpiry: cards.filter(c => c.querySelector('.sc-struct') && !c.querySelector('.sc-expiry')).length,
      structNoBE: cards.filter(c => c.querySelector('.sc-struct') && !c.querySelector('.scs-be')).length,
      metricsOk: cards.filter(c => c.querySelectorAll('.scm').length === 8).length,
      legsZero: opp.filter(x => x.structure.legs.length === 0).length,
      oppTotal: opp.length,
      beCount: opp.filter(x => x.structure.breakEven).length,
      sample: cards.slice(0, 3).map(c => ({
        sym: (c.querySelector('.sc-sym') || {}).textContent.replace(/\s.*/, ''),
        exp: (c.querySelector('.sc-expiry') || {}).textContent.trim(),
        legs: [...c.querySelectorAll('.leg')].map(l => l.textContent.trim()),
        be: (c.querySelector('.scs-be') || {}).textContent.trim()
      }))
    };
  });
  console.log(JSON.stringify(r, null, 2));
  console.log('\nJS errors:', errors.length ? errors : 'none');
  await browser.close();
})();
