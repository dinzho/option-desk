/**
 * OptionDesk · 即時數據代理 Worker（Cloudflare Workers）
 * ---------------------------------------------------------------------------
 * 用途：GitHub Pages 係純靜態、冇後台函數，瀏覽器唔可以直接打 api.nasdaq.com
 *       （無 CORS）。呢個 Worker 喺 Cloudflare 邊緣幫你 server-side 抓數據，
 *       再加返 CORS 頭返畀瀏覽器 —— 完全等同之前 Netlify Function 做嘅嘢。
 *
 * 部署（免費，約 2 分鐘）：
 *   1. 開 https://dash.cloudflare.com → 左側「Workers 與 Pages」→「建立」→「Worker」
 *   2. 改個名（例如 option-desk-proxy）→「部署」→「編輯代碼」
 *   3. 將本檔全部內容貼上去，覆蓋原本嘅 Hello World →「部署」
 *   4. 拎到網址：https://option-desk-proxy.<你嘅subdomain>.workers.dev
 *   5. 開 OptionDesk → 右上「数据源」→ 將上面個網址貼入「自訂 Worker 代理 URL」
 *      → 儲存。之後入任何股票都會經呢個 Worker 即時抓報價 + 期權鏈。
 *
 * 用家唔使改任何代碼——URL 只係存在你瀏覽器 localStorage。
 */
const ALLOWED = [
  'api.nasdaq.com',
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com'
];

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'no-store'
  };
}

addEventListener('fetch', function (event) {
  event.respondWith(handle(event.request));
});

async function handle(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  var url = new URL(request.url);
  var target = url.searchParams.get('url');
  if (!target) {
    return new Response(
      'Missing ?url= param.\nExample: ?url=https://api.nasdaq.com/api/quote/AAPL/info?assetclass=stocks',
      { status: 400, headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, corsHeaders()) }
    );
  }
  var t;
  try { t = new URL(target); } catch (e) {
    return new Response('Invalid url', { status: 400, headers: corsHeaders() });
  }
  if (ALLOWED.indexOf(t.hostname) < 0) {
    return new Response(
      'Host not allowed: ' + t.hostname + ' (allowlist: ' + ALLOWED.join(', ') + ')',
      { status: 403, headers: corsHeaders() }
    );
  }
  try {
    var upstream = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'Accept': 'application/json,text/plain,*/*',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      redirect: 'follow'
    });
    var body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: Object.assign(corsHeaders(), {
        'Content-Type': upstream.headers.get('Content-Type') || 'application/json'
      })
    });
  } catch (e) {
    return new Response('Upstream fetch failed: ' + e.message, { status: 502, headers: corsHeaders() });
  }
}
