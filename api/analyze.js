// api/analyze.js — Serverless (Node.js) runtime (RAW numbers, tolerance + color bands)

export const config = {
  runtime: "nodejs",
  regions: ["fra1"], // optional
};
export const maxDuration = 60;

const OPENAI_URL = "https://api.openai.com/v1/responses";
const MODEL = "gpt-4o-mini";
const MAX_OUTPUT_TOKENS = 700;

// --------- helpers ----------
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
    s = s.replace(/[%٪]/g, ""); // فقط حذف %
    s = s.replace(/[,\u066C\u200F\u200E]/g, "");
    s = s.replace(/[٫،]/g, ".");
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

// --------- payload slimming ----------
function slimPayload(p) {
  const clone = JSON.parse(JSON.stringify(p || {}));

  // handle outliers
  if (clone?.outliers) {
    for (const k of ["underperform", "overperform", "borderline"]) {
      if (Array.isArray(clone.outliers[k])) {
        clone.outliers[k] = clone.outliers[k].slice(0, 10).map((it) => {
          const out = { ...it };
          for (const fld of ["ctr", "min", "max"]) {
            if (out[fld] != null) {
              const n = normalizeRawNumber(out[fld]);
              if (n != null) out[fld] = roundIfNeeded(n);
            }
          }
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
    clone.summary.byPos = clone.summary.byPos.slice(0, 20).map((r) => {
      const avgNum = normalizeRawNumber(r.avg);
      return {
        pos: r.pos,
        avg: avgNum != null ? roundIfNeeded(avgNum) : r.avg,
        n: r.n,
      };
    });
  }

  // benchmarks
  if (Array.isArray(clone?.benchmarks)) {
    clone.benchmarks = clone.benchmarks.map((b) => {
      const out = { ...b };
      for (const fld of ["from", "to", "min", "max"]) {
        if (out[fld] != null) {
          const n = normalizeRawNumber(out[fld]);
          if (n != null) out[fld] = roundIfNeeded(n);
        }
      }
      return out;
    });
  }

  // tolerance + colors
  if (clone?.settings) {
    if (clone.settings.tolerance != null) {
      clone.settings.tolerance = roundIfNeeded(
        normalizeRawNumber(clone.settings.tolerance)
      );
    }
    if (Array.isArray(clone.settings.colors)) {
      clone.settings.colors = clone.settings.colors.slice(0, 5);
    }
  }

  return clone;
}

// --------- OpenAI call ----------
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
    payload =
      req.body ??
      (await new Promise((r) => {
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

  const sys = `شما یک تحلیلگر سئو هستید.
با داده‌های خام (بدون تبدیل درصد یا مقیاس‌دهی) کار کنید.
- هیچ نماد % استفاده نشود.
- اعداد صحیح بدون اعشار بمانند.
- اعداد اعشاری حداکثر تا دو رقم اعشار باشند.
- اگر تلورانس و رنگ‌ها وجود داشتند، تحلیل خود را بر اساس آن‌ها هم اضافه کنید.
خروجی فارسی، روان و رسمی با تیترهای شفاف، حداکثر ~${MAX_OUTPUT_TOKENS} توکن.`;

  const usr = `داده‌ها (پاک‌سازی‌شده):
${JSON.stringify(slim)}
دستورالعمل:
- هیچ مقیاس یا تبدیل روی اعداد نده.
- برای هر بخش ۱–۲ اقدام سریع و عملی پیشنهاد بده.
- اگر colors و tolerance موجود بود، آن‌ها را در تحلیل دخیل کن.`;

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
