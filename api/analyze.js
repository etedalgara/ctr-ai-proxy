// api/analyze.js — Serverless (Node.js) runtime (RAW numbers, 2 decimals only if fractional)

export const config = {
  runtime: "nodejs",
  regions: ["fra1"], // optional
};
export const maxDuration = 60;

const OPENAI_URL = "https://api.openai.com/v1/responses";
const MODEL = "gpt-4o-mini";
const MAX_OUTPUT_TOKENS = 600;

// --------- helpers: number normalization (no percent semantics) ----------
function toLatinDigits(s) {
  if (typeof s !== "string") return s;
  const map = {
    "۰":"0","۱":"1","۲":"2","۳":"3","۴":"4","۵":"5","۶":"6","۷":"7","۸":"8","۹":"9",
    "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9",
  };
  return s.replace(/[۰-۹٠-٩]/g, (d) => map[d] ?? d);
}

function normalizeRawNumber(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    let s = toLatinDigits(v).trim();
    // remove percent symbols ONLY (no scaling)
    s = s.replace(/[%٪]/g, "");
    // remove thousand separators / LRM/RLM, unify decimal
    s = s.replace(/[,\u066C\u200F\u200E]/g, "");
    s = s.replace(/[٫،]/g, "."); // Persian/Arabic decimal → dot
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// round to 2 decimals only if fractional; keep integers as-is
function roundIfNeeded(num) {
  if (!Number.isFinite(num)) return num;
  return Number.isInteger(num) ? num : parseFloat(num.toFixed(2));
}

// --------- payload slimming + coercion ----------
function slimPayload(p) {
  const clone = JSON.parse(JSON.stringify(p || {}));

  // outliers
  if (clone?.outliers) {
    for (const k of ["underperform", "overperform", "borderline"]) {
      if (Array.isArray(clone.outliers[k])) {
        clone.outliers[k] = clone.outliers[k]
          .slice(0, 10)
          .map((it) => {
            const out = { ...it };
            if (out.ctr != null) {
              const n = normalizeRawNumber(out.ctr);
              if (n != null) out.ctr = roundIfNeeded(n);
            }
            if (out.min != null) {
              const n = normalizeRawNumber(out.min);
              if (n != null) out.min = roundIfNeeded(n);
            }
            if (out.max != null) {
              const n = normalizeRawNumber(out.max);
              if (n != null) out.max = roundIfNeeded(n);
            }
            // shorten long URLs just to save tokens
            if (typeof out.url === "string" && out.url.length > 120) {
              out.url = out.url.slice(0, 117) + "…";
            }
            return out;
          });
      }
    }
  }

  // summary.byPos
  if (Array.isArray(clone?.summary?.byPos)) {
    clone.summary.byPos = clone.summary.byPos
      .slice(0, 20)
      .map((r) => {
        const pos = r.pos;
        const avgNum = normalizeRawNumber(r.avg);
        const n = r.n;
        return {
          pos,
          avg: avgNum != null ? roundIfNeeded(avgNum) : r.avg,
          n,
        };
      });
  }

  // benchmarks
  if (Array.isArray(clone?.benchmarks)) {
    clone.benchmarks = clone.benchmarks.map((b) => {
      const out = { ...b };
      if (out.from != null) {
        const n = normalizeRawNumber(out.from);
        if (n != null) out.from = roundIfNeeded(n);
      }
      if (out.to != null) {
        const n = normalizeRawNumber(out.to);
        if (n != null) out.to = roundIfNeeded(n);
      }
      if (out.min != null) {
        const n = normalizeRawNumber(out.min);
        if (n != null) out.min = roundIfNeeded(n);
      }
      if (out.max != null) {
        const n = normalizeRawNumber(out.max);
        if (n != null) out.max = roundIfNeeded(n);
      }
      return out;
    });
  }

  return clone;
}

// --------- OpenAI call with tiny retry/backoff ----------
async function callOpenAI(body, key, controller, maxAttempts = 3) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.status === 200) return await res.json();

      if (res.status === 429 || res.status >= 500) {
        lastErr = { status: res.status, body: await res.text() };
        await new Promise((r) => setTimeout(r, 700 * attempt));
        continue;
      }
      return { error: `OpenAI HTTP ${res.status}`, detail: await res.text() };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return { error: "OpenAI request failed after retries", detail: lastErr };
}

// --------- main handler ----------
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Only POST");

  let payload;
  try {
    payload = req.body ?? (await new Promise((r) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => r(JSON.parse(data || "{}")));
    }));
  } catch {
    return res.status(400).json({ error: "Bad JSON body" });
  }

  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(500).json({ error: "OPENAI_API_KEY missing" });

  const slim = slimPayload(payload);

  const sys = `شما یک تحلیلگر سئو هستید. فقط با «اعداد خام» کار کنید.
هیچ تبدیل درصدی انجام ندهید، از علامت % استفاده نکنید، و اعداد را همان‌طور که هستند تفسیر کنید.
اگر عدد صحیح است بدون اعشار بماند؛ اگر اعشاری بود حداکثر تا دو رقم اعشار.
خروجی را فارسی روان و رسمی بنویسید، حداکثر ~${MAX_OUTPUT_TOKENS} توکن، با تیترهای واضح.`;

  const usr = `داده‌ها (پاک‌سازی‌شده، با قانون نمایش: صحیح بدون اعشار / اعشاری تا دو رقم):
${JSON.stringify(slim)}
دستورالعمل:
- هیچ مقیاس/تبدیلی روی اعداد انجام نده.
- از نماد % استفاده نکن.
- برای هر بخش 1–2 اقدام سریع پیشنهاد بده (عملی و کوتاه).`;

  const body = {
    model: MODEL,
    input: [
      { role: "system", content: sys },
      { role: "user", content: usr },
    ],
    max_output_tokens: MAX_OUTPUT_TOKENS,
    temperature: 0.3,
  };

  const controller = new AbortController();
  const overallTimeout = setTimeout(() => controller.abort(), 18000);

  const result = await callOpenAI(body, key, controller);
  clearTimeout(overallTimeout);

  if (result?.error) {
    return res.status(504).json({
      summaryText: `AI error: ${result.error}${
        result.detail ? " • " + JSON.stringify(result.detail) : ""
      }`,
    });
  }

  const text =
    result?.output?.[0]?.content?.map?.((p) => p?.text)?.join("") ||
    result?.output_text ||
    "";

  return res.status(200).json({ summaryText: text });
}
