import formidable from "formidable";
import * as XLSX from "xlsx";
import OpenAI from "openai";

// برای اینکه Vercel فایل آپلود رو درست بخونه
export const config = {
  api: {
    bodyParser: false,
  },
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// تابع برای خواندن فایل اکسل
const readExcelFile = async (filePath) => {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(worksheet);
};

// فرمت‌دهی خروجی AI به صورت راست‌چین و با ایموجی
const formatAIResponse = (rawText) => {
  const sections = rawText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line);

  return sections
    .map((line) => {
      if (line.startsWith("بینش‌های کلیدی")) return "🟦 **بینش‌های کلیدی:**";
      if (line.startsWith("پیشنهادات")) return "🟩 **پیشنهادات:**";
      if (line.startsWith("خلاصه کلی")) return "🟨 **خلاصه کلی:**";
      return line;
    })
    .join("\n\n");
};

// پردازش اکسل و آماده‌سازی داده‌ها
const processExcelData = (data) => {
  return data.map((row) => {
    return {
      campaign: row["Campaign"] || row["کمپین"] || "",
      impressions: row["Impressions"] || row["نمایش"] || 0,
      clicks: row["Clicks"] || row["کلیک"] || 0,
      ctr: row["CTR"] || row["ctr"] || row["Ctr"] || 0, // بدون درصدسازی
      cost: row["Cost"] || row["هزینه"] || 0,
    };
  });
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const form = new formidable.IncomingForm();

  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(500).json({ error: "File parsing failed" });

    try {
      // ۱- خواندن فایل اکسل
      const filePath = files.file.filepath;
      const rawData = await readExcelFile(filePath);
      const processedData = processExcelData(rawData);

      // ۲- ساخت متن برای AI
      const aiPrompt = `
        این داده‌های کمپین تبلیغاتی هستند:
        ${JSON.stringify(processedData, null, 2)}
        
        لطفا تحلیل را در سه بخش ارائه کن:
        1. بینش‌های کلیدی
        2. پیشنهادات
        3. خلاصه کلی

        همه متن باید فارسی و راست‌چین باشد.
        هر بخش را با تیتر مشخص کن.
      `;

      // ۳- درخواست به OpenAI
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: aiPrompt }],
      });

      const aiText = completion.choices[0].message.content;
      const formattedAI = formatAIResponse(aiText);

      return res.status(200).json({
        data: processedData,
        ai_analysis: formattedAI,
      });
    } catch (error) {
      console.error("AI Analysis Error:", error);
      return res.status(500).json({ error: "AI Analysis Failed" });
    }
  });
}
