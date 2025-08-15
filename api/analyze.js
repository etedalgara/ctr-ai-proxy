// api/analyze.js — Serverless (Node.js) runtime (correct value is "nodejs")

export const config = {
  runtime: "nodejs",     // ✅ مقدار درست
  regions: ["fra1"],     // می‌تونی حذفش هم بکنی؛ اختیاری
};
export const maxDuration = 60;

const OPENAI_URL = "https://api.openai.com/v1/responses";
const MODEL = "gpt-4o-mini";
const MAX_OUTPUT_TOKENS = 400;

function slimPayload(p) {
  const clone = JSON.parse(JSON.stringify(p || {}));
  if (clone?.outliers) {
    for (const k of ["underperform", "overperform", "borderline"]) {
      if (Array.isArray(clone.outliers[k])) {
        clone.outliers[k] = clone.outliers[k].slice(0, 10);
      }
    }
  }
  const short = (s) =>
    typeof s === "string" && s.length > 120 ? s.slice(0, 117) + "…" : s;

  for (const k of ["underperform", "overperform", "borderline"]) {
    (clone?.outliers?.[k] || []).forEach((it) => {
      if (typeof it.ctr === "number") it.ctr = +it.ctr.toFixed(4);
      if (typeof it.min === "number") it.min = +it.min.toFixed(4);
      if (typeof it.max === "number") it.max = +it.max.toFixed(4);
      if (it.url) it.url = short(it.url);
    });
  }

  if (Array.isArray(clone?.summary?.byPos)) {
    clone.summary.byPos = clone.summary.byPos
      .map((r) => ({
        pos: r.pos,
        avg: typeof r.avg === "number" ? +r.avg.toFixed(4) : r.avg,
        n: r.n,
      }))
      .slice(0, 20);
  }
  return clone;
}

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

  const sys = `شما یک تحلیلگر سئو هستید. با فارسی روان و رسمی، نتیجه CTR را خلاصه و توصیه‌های عملی بده.
خروجی 3 تا 6 بخش کوتاه با تیتر واضح؛ حداکثر ~400 توکن.`;

  const usr = `دیتای خلاصه‌شده:
${JSON.stringify(slim)}
راهنما: نقاط ضعف/قوت و برای هر مورد 1-2 اقدام سریع بده.`;

  const body = {
    model: MODEL,
    input: [
      { role: "system", content: sys },
      { role: "user", content: usr },
    ],
    max_output_tokens: MAX_OUTPUT_TOKENS,
    temperature: 0.3,
  };

  // time budget برای تماس با OpenAI
  const controller = new AbortController();
  const overallTimeout = setTimeout(() => controller.abort(), 18000);

  const result = await callOpenAI(body, key, controller);
  clearTimeout(overallTimeout);

  if (result?.error) {
    return res
      .status(504)
      .json({
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
