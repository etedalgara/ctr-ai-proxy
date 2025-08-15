// api/analyze.js
export const config = { runtime: 'edge' }; // Edge = استارت سریع

export default async function handler(req) {
  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405, headers: { 'content-type': 'application/json' }
      });
    }

    const body = await req.json().catch(() => ({}));
    const { meta, benchmarks, summary, outliers } = body || {};

    // پرامپت کوتاه و نتیجه جمع‌وجور تا سریع پاسخ بده
    const prompt = [
      'خلاصه تشخیصی سئو از CTR بر اساس داده‌ها. خروجی را فهرست شماره‌دار فارسی بده:',
      'هر مورد: یک عنوان کوتاه در خط اول و 2–4 جمله در خطوط بعد.',
      'بدون **…**. مختصر و اجرایی.',
      `meta: ${JSON.stringify(meta || {})}`,
      `benchmarks: ${JSON.stringify(benchmarks || [])}`,
      `summary: ${JSON.stringify(summary || {})}`,
      `outliers: ${JSON.stringify(outliers || {})}`
    ].join('\n');

    // فراخوانی OpenAI
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      return new Response(JSON.stringify({ error: 'OPENAI_API_KEY missing' }), {
        status: 500, headers: { 'content-type': 'application/json' }
      });
    }

    // محدودیت‌ها برای سرعت/هزینه
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 40000); // 40s سقف پاسخ از OpenAI
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${key}`,
        'content-type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'gpt-4o-mini',          // سریع/ارزان
        max_tokens: 600,               // خروجی کوتاه
        temperature: 0.3,
        messages: [
          { role: 'system', content: 'You are an SEO analyst. Respond in Persian (fa-IR).' },
          { role: 'user', content: prompt }
        ]
      })
    }).catch(e => ({ ok: false, status: 499, json: async () => ({ error: String(e) }) }));
    clearTimeout(t);

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      // همیشه JSON استاندارد برگردون تا اپ تایم‌اوت نشه
      return new Response(JSON.stringify({
        error: 'openai_error',
        status: resp.status,
        detail: data
      }), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }

    const text = data?.choices?.[0]?.message?.content?.trim?.() || '۱. داده برای تحلیل کافی نبود.';

    return new Response(JSON.stringify({ summaryText: text }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });

  } catch (e) {
    // هر خطایی رخ بده، JSON بده
    return new Response(JSON.stringify({ error: 'server_error', detail: String(e) }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  }
}
