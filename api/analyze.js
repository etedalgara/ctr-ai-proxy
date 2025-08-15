// api/analyze.js
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "OPENAI_API_KEY is missing" });
    }

    const payload = req.body;
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ error: "Bad JSON body" });
    }

    // --- اینجا هر خلاصه‌سازی/پرامپت دلخواهت ---
    const system = "You are an SEO analyst. Return a concise Farsi analysis.";
    const user = `Summarize this CTR dataset:\n${JSON.stringify(payload).slice(0, 6000)}`;

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        temperature: 0.2
      })
    });

    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return res.status(r.status).json({ error: `OpenAI HTTP ${r.status}`, detail: text });
    }

    const data = await r.json();
    const summaryText = data?.choices?.[0]?.message?.content || "";
    return res.status(200).json({ ok: true, summaryText });
  } catch (e) {
    return res.status(500).json({ error: "proxy-failed", detail: String(e) });
  }
}
