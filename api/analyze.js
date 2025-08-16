// api/analyze.js — Serverless (Node.js) runtime
// RAW numbers + 5-band tolerance aware analysis
// Output style: NO preamble, Persian, compact. Score 0..100 + redStrong list with suggestions.

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
    s = s.replace(/[%٪]/g, "");               // فقط حذف %
    s = s.replace(/[,\u066C\u200F\u200E]/g, "");
    s = s.replace(/[٫،]/g, ".");              // اعشار عربی/فارسی → .
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

  // outliers
  if (clone?.outliers) {
    for (const k of ["underperform", "overperform", "borderline"]) {
      if (Array.isArray(clone.outliers[k])) {
        clone.outliers[k] = clone.outliers[k].slice(0, 50).map((it) => {
          const out = { ...it };
          for (const fld of ["ctr", "min", "max"]) {
            if (out[fld] != null) {
              const n = normalizeRawNumber(out[fld]);
              if (n != null) out[fld] = roundIfNeeded(n);
            }
          }
          if (typeof out.url === "string" && out.url.length > 160) {
            out.url = out.url.slice(0, 157) + "…";
          }
          return out;
        });
      }
    }
  }

  // summary.byPos
  if (Array.isArray(clone?.summary?.byPos)) {
    clone.summary.byPos = clone.summary.byPos.slice(0, 30).map((r) => {
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

  // settings: tolerance (0..0.5), colors (max 5)
  if (clone?.settings) {
    if (clone.settings.tolerance != null) {
      const n = normalizeRawNumber(clone.settings.tolerance);
      if (n != null) clone.settings.tolerance = roundIfNeeded(n);
    }
    if (Array.isArray(clone.settings.colors)) {
      clone.settings.colors = clone.settings.colors.slice(0, 5);
    }
  }

  // meta
  if (clone?.meta?.rows != null) {
    const n = normalizeRawNumber(clone.meta.rows);
    if (n != null) clone.meta.rows = Math.max(0, Math.floor(n));
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

  // ===== Prompt: minimal, scoring + redStrong list with tactical suggestions =====
  const sys = `
شما دستیار تحلیل سئو هستید. فقط با اعداد خام کار کنید (بدون تبدیل درصد و بدون نماد %).
قواعد نمایش: عدد صحیح بدون اعشار؛ اعشاری حداکثر تا دو رقم اعشار.
خروجی حتماً کوتاه، تمیز و بدون هرگونه مقدمه یا شرح داده‌ها باشد.`;

  // امتیازدهی صریح و قابل‌محاسبه از روی outliers و meta:
  // - قرمز پررنگ: آیتم‌های underperform که ctr < min*(1 - tolerance)
  // - قرمز کم‌رنگ: underperform که min*(1 - tolerance) <= ctr < min
  // - سبز کم‌رنگ: overperform که max < ctr <= max*(1 + tolerance)
  // - سبز پررنگ: overperform که ctr > max*(1 + tolerance)
  // - خاکستری: بقیه (تخمینی = rows - (قرمزها + سبزها) اگر rows موجود بود)
  //
  // نمره 0..100:
  // score_raw = (2*GS + 1*GL + 0.5*Gray) - (1*RL + 2*RS)   [بر حسب نسبت به کل]
  // score = round( clamp( 50 + 100 * score_raw, 0, 100 ) )
  // اگر meta.rows موجود نباشد از جمع شمارش‌های موجود استفاده کن.
  //
  // سپس فقط صفحات «قرمز پررنگ» را لیست کن (حداکثر 15 مورد) با:
  // - Page (url/title کوتاه)
  // - Pos (همان raw)
  // - CTR vs Min: ctr / min  و فاصله = (min - ctr)
  // - 1–2 پیشنهاد کوتاه:
  //     • تیتر پیشنهادی یا بهبود تیتر (الهام از الگوهای سبزها: overperform)
  //     • ایده آپدیت محتوا/CTA/ریچ‌اسنیپت
  //
  // ممنوع: هرگونه مقدمه، خلاصه دیتاست، تکرار مقادیر payload، توضیحات طولانی.
  // بخش‌بندی ثابت با همین ترتیب و عناوین باشد.

  const usr = `
داده‌های پاک‌سازی‌شده و خلاصه‌شده برای تحلیل:
${JSON.stringify(slim)}

خروجی مطلوب (فقط همین ساختار و به فارسی):
امتیاز کل: <X>/100
صفحات بحرانی (قرمز پررنگ):
1) <Page> — Pos: <pos> — CTR/Min: <ctr>/<min> — Gap: <gap>
   - تیتر پیشنهادی: <یک پیشنهاد خیلی کوتاه>
   - اقدام سریع: <آپدیت یا CTA خیلی کوتاه>
2) ...
(حداکثر 15 مورد)

یادآورها برای محاسبه داخلی (نمایش نده):
- tolerance = settings.tolerance (اگر نبود 0.10 در نظر بگیر).
- قرمز پررنگ: ctr < min*(1 - tolerance)
- سبز پررنگ: ctr > max*(1 + tolerance)
- سبز کم‌رنگ: max < ctr <= max*(1 + tolerance)
- قرمز کم‌رنگ: min*(1 - tolerance) <= ctr < min
- خاکستری: باقی موارد (اگر rows در meta بود، با تفریق تخمین بزن).
- نمره را طبق فرمول توضیح‌داده‌شده محاسبه کن و به نزدیک‌ترین عدد صحیح گرد کن.
- در نمایش اعداد: صحیح بدون اعشار، اعشاری تا دو رقم. از نماد % استفاده نکن.`;

  const body = {
    model: MODEL,
    input: [
      { role: "system", content: sys },
      { role: "user", content: usr },
    ],
    max_output_tokens: MAX_OUTPUT_TOKENS,
    temperature: 0.2, // تحلیل پایدارتر و کم‌پراکندگی
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
