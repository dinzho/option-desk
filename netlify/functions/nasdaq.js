/**
 * Netlify Function：Nasdaq API 伺服器端代理
 *
 * 存在意義：瀏覽器直接打 api.nasdaq.com 會被 CORS 擋；公共 CORS 代理
 * （allorigins / codetabs / corsproxy…）全部已經失效或極不穩定。
 * 呢個 function 跑喺 Netlify 伺服器上，服務端讀 Nasdaq（無 CORS），
 * 瀏覽器只需打 /.netlify/functions/nasdaq?url=<完整 Nasdaq URL>。
 *
 * 安全：只允許代理 https://api.nasdaq.com/ 開頭嘅 URL，
 * 唔會淪為開放代理（open proxy）俾人濫用。
 *
 * 用法：GET /.netlify/functions/nasdaq?url=https%3A%2F%2Fapi.nasdaq.com%2Fapi%2Fquote%2FAAPL%2Finfo%3Fassetclass%3Dstocks
 * 回傳：Nasdaq 嘅原始 JSON（原樣轉發，連 status code 一併轉發）
 */
exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const target = params.url;

  // 只接受 api.nasdaq.com，避免被當開放代理
  if (!target || !/^https:\/\/api\.nasdaq\.com\//.test(target)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'only api.nasdaq.com URLs are allowed' })
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000); // 留 1 秒畀 Netlify 10s 上限

  try {
    const upstream = await fetch(target, {
      signal: controller.signal,
      headers: {
        // Nasdaq 會擋無 UA 嘅請求；扮成一般瀏覽器
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.nasdaq.com/'
      }
    });
    clearTimeout(timer);

    const text = await upstream.text();
    return {
      statusCode: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
        'Access-Control-Allow-Origin': '*',
        // 短暫快取，減少 function 調用次數（報價類 30 秒夠新鮮）
        'Cache-Control': 'public, max-age=30'
      },
      body: text
    };
  } catch (e) {
    clearTimeout(timer);
    const aborted = e && (e.name === 'AbortError');
    return {
      statusCode: aborted ? 504 : 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: String((e && e.message) || e) })
    };
  }
};
