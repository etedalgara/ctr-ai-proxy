// Vercel Serverless Function: POST /api/analyze
// پاسخ: تحلیل فارسی بر اساس داده‌های CTR/Position/Benchmarks

import OpenAI from "openai";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    const { meta = {}, benchmarks = [], summary = {}, outliers = {} } = body;

    // ضد سوءاستفاده: محدودسازی اندازه ورودی
    if (benchmarks.length > 300) {
      return res.status(413).json({ error: "Too many benchmarks" });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const prompt =
`تو یک تحلیلگر سئو هستی و باید بر اساس نرخ کلیک (CTR) و جایگاه صفحات در گوگل، یک تحلیل فارسیِ خلاصه و قابل‌اقدام ارائه بدهی.
خروجی را با لحن روشن و سرراست بده؛ شامل:
- ۵ بینش کلیدی کوتاه
- ۵ اقدام اولویت‌دار (۱ تا ۵)
- ۳ تست A/B پیشنهادی برای بهبود CTR

مشخصات دیتاست: ${meta?.datasetName ?? "n/a"} | تعداد ردیف: ${meta?.rows ?? 0}
Benchmarks: ${JSON.stringify(benchmarks)}
میانگین CTR به تفکیک جایگاه: ${JSON.stringify(summary?.byPos ?? [])}
نمونه‌های زیرِ معیار: ${JSON.stringify((outliers.underperform ?? []).slice(0, 25))}
نمونه‌های بالای معیار: ${JSON.stringify((outliers.overperform ?? []).slice(0, 25))}
نمونه‌های نزدیک مرز: ${JSON.stringify((outliers.borderline ?? []).slice(0, 25))}

قواعد:
- اگر داده‌ای ناکامل است، فرضیه‌سازی نکن؛ اشاره کن که نیاز به داده بیشتر است.
- از اعداد تقریبی (٪) برای رساندن پیام استفاده کن.
- کاملاً فارسی پاسخ بده.`;

    const resp = await client.responses.create({
      model: "gpt-4o-mini",
      input: prompt,
    });

    const text = resp.output_text ?? "خطا در دریافت پاسخ از مدل.";

    return res.status(200).json({
      summaryText: text,
      topActions: []
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message ?? "Server error" });
  }
}
