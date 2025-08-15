// api/analyze.js
export const config = { runtime: "edge" };

const OPENAI_URL = "https://api.openai.com/v1/responses";
const MODEL = "gpt-4o-mini"; // سبک و ارزان
const MAX_OUTPUT_TOKENS = 400;

// کم کردن حجم ورودی برای کاهش TPM
function slimPayload(p) {
  const clone = JSON.parse(JSON.stringify(p || {}));
  // فقط 10 آیتم از هر دسته
  if (clone?.outliers) {
    for (const k of ["underperform", "overperform", "borderline"]) {
      if (Array.isArray(clone.outliers[k])) {
        clone.outliers[k] = clone.outliers[k].slice(0, 10);
      }
    }
  }
  // گرد کردن اعداد و کوتاه کردن URLها برای صرفه‌جویی توکن
  const shorten = (s) => (typeof s === "string" && s.length > 120 ? s.slice(0, 117) + "…" : s);
  for (const k of ["underperform", "overperform", "borderline"]) {
    (clone?.outliers?.[k] || []).forEach((it) => {
      if (typeof it.ctr === "number") it.ctr = +it.ctr.toFixed(4);
      if (typeof it.min === "number") it.min = +it.min.toFixed(4);
      if (typeof it.max === "number") it.max = +it.max.toFixed(4);
      if (it.url) it.url = shorten(it.url);
    });
  }
  if (Array.isArray(clone?.summary?.byPos)) {
    clone.summary.byPos = clone.summary.byPos.map((r) => ({
      pos: r.pos,
      avg: typeof r.avg === "number" ? +r.avg.toFixed(4) : r.avg,
      n: r.n,
    })).slice(0, 20);
  }
  return clone;
}

// backoff کم‌خطا با احترام به Retry-After
async function callOpenAIWithRetry(body, key, maxAttempts = 6) {
  let attempt = 0;
  let lastErr;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const res = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (res.status === 200) return await res.json();

      // اگر 429/5xx: backoff
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = res.headers.get("retry-after");
        let waitMs = retryAfter ? Number(retryAfter) * 1000 : 0;
        if (!waitMs || Number.isNaN(waitMs)) {
          // exponential backoff + jitter
          const base = Math.pow(1.8, attempt) * 800; // ~0.8s,1.4s,2.6s,…
          waitMs = base + Math.floor(Math.random() * 400);
        }
        lastErr = { status: res.status, body: await res.text() };
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      // خطاهای دیگر را مستقیم بازگردان
      const text = await res.text();
      return { error: `OpenAI HTTP ${res.status}`, detail: text };

    } catch (e) {
      lastErr = e;
      // وقفه‌ی کوتاه و دوباره
      await new Promise((r) => setTimeout(r, 600 + Math.random() * 400));
    }
  }
  return { error: "OpenAI 429/5xx after retries", detail: lastErr };
}

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response("Only POST", { status: 405 });
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Bad JSON body" }), { status: 400 });
  }

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return new Response(JSON.stringify({ error: "OPENAI_API_KEY missing" }), { status: 500 });
  }

  const slim = slimPayload(payload);

  const sys = `
شما یک تحلیلگر سئو هستید. با فارسی رسمی و روان، نتایج CTR را خلاصه و توصیه‌های عملی بده.
خروجی را در 3 تا 6 بخش کوتاه با تیتر واضح بده. از خط‌های کوتاه استفاده کن.`;

  const user = `
دیتا (خلاصه‌شده):
${JSON.stringify(slim, null, 0)}
راهنما:
- نقاط ضعف/قوت را با دلیل بگو.
- برای هر سناریوی اصلی ۱-۲ اقدام سریع پیشنهاد بده.
- حداکثر 400 توکن خروجی بده.
`;

  const body = {
    model: MODEL,
    input: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    max_output_tokens: MAX_OUTPUT_TOKENS,
    temperature: 0.3,
  };

  const result = await callOpenAIWithRetry(body, key);

  if (result?.error) {
    // پیام خوانا برای اپ
    return new Response(
      JSON.stringify({ summaryText: `AI service error: ${typeof result.error === "string" ? result.error : JSON.stringify(result)}` }),
      { status: 429, headers: { "content-type": "application/json; charset=utf-8" } }
    );
  }

  // پاسخ Responses API
  const text =
    result?.output?.[0]?.content?.map?.((p) => p?.text)?.join("") ||
    result?.output_text ||
    "";

  return new Response(JSON.stringify({ summaryText: text }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
