// api/analyze.js  (Vercel Serverless Function)

import OpenAI from "openai";

// CORS helper
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    // --- read body robustly (works even if req.body is undefined) ---
    let raw = "";
    if (req.body) {
      raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    } else {
      raw = await new Promise((resolve, reject) => {
        let data = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data || "{}"));
        req.on("error", reject);
      });
    }

    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return res.status(400).json({ error: "Invalid JSON body" });
    }

    const { meta = {}, benchmarks = [], summary = {}, outliers = {} } = body;

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY is not set on server" });
    }
    if (!Array.isArray(benchmarks) || benchmarks.length === 0) {
      return res.status(400).json({ error: "benchmarks[] is required" });
    }

    // sanity limits to avoid huge payloads
    if (benchmarks.length > 300) {
      return res.status(413).json({ error: "Too many benchmarks" });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const prompt =
`تو یک تحلیلگر سئو هستی. بر اساس CTR و جایگاه‌ها تحلیل فارسی و قابل‌اقدام بده.
خروجی مطلوب:
- ۵ بینش کلیدی
- ۵ اقدام اولویت‌دار
- ۳ تست A/B پیشنهادی

داده:
meta=${JSON.stringify(meta)}
benchmarks=${JSON.stringify(benchmarks)}
byPos=${JSON.stringify(summary?.byPos ?? [])}
under=${JSON.stringify((outliers.underperform ?? []).slice(0, 25))}
over=${JSON.stringify((outliers.overperform ?? []).slice(0, 25))}
border=${JSON.stringify((outliers.borderline ?? []).slice(0, 25))}`;

    // timeout guard
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 45000);

    let text = "";
    try {
      const resp = await client.responses.create({
        model: "gpt-4o-mini",
        input: prompt,
        // signal: ac.signal,   // uncomment when SDK supports AbortController here
      });
      text = resp.output_text ?? "";
    } catch (e) {
      clearTimeout(t);
      // bubble up OpenAI error detail
      return res.status(502).json({
        error: "OpenAI request failed",
        detail: e?.message ?? String(e),
      });
    }
    clearTimeout(t);

    if (!text) {
      return res.status(500).json({ error: "Empty response from model" });
    }

    return res.status(200).json({ summaryText: text, topActions: [] });
  } catch (e) {
    return res.status(500).json({ error: e?.message ?? "Server error" });
  }
}
