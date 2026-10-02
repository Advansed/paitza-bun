import { GoogleGenerativeAI } from "@google/generative-ai";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

function model() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY не настроен");
  return new GoogleGenerativeAI(apiKey).getGenerativeModel({
    model: MODEL,
    generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
  });
}

function normalize(image: string, mimeType = "image/jpeg") {
  let data = image.trim();
  let type = mimeType;
  const match = data.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
  if (match) {
    type = match[1] ?? type;
    data = match[2] ?? "";
  } else if (data.includes(",")) {
    data = data.split(",").pop() ?? "";
  }
  data = data.replace(/\s/g, "");
  if (!data) throw new Error("Пустые данные изображения");
  return { data, mimeType: type };
}

function parseJson(text: string) {
  const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("Не удалось разобрать JSON ответа Gemini");
  }
}

async function generate(prompt: string, image: string, mimeType?: string) {
  const normalized = normalize(image, mimeType);
  const result = await model().generateContent([
    { text: prompt },
    { inlineData: { mimeType: normalized.mimeType, data: normalized.data } },
  ]);
  return parseJson(result.response.text());
}

const PHOTO_PROMPT = `Ты — сервис KYC. На изображении — разворот российского паспорта РФ с фотографией владельца (страницы 2–3).
Верни ТОЛЬКО JSON: {"success":true|false,"is_passport_photo_page":true|false,"readable":true|false,"confidence":0,"fields":{"series":null,"number":null,"last_name":null,"first_name":null,"patronymic":null,"gender":null,"birth_date":null,"birth_place":null,"issued_by":null,"issue_date":null,"department_code":null},"has_photo":true|false,"issues":[],"summary":""}`;

const REG_PROMPT = `Ты — сервис KYC. На изображении — страница российского паспорта РФ с регистрацией по месту жительства.
Верни ТОЛЬКО JSON: {"success":true|false,"is_registration_page":true|false,"readable":true|false,"confidence":0,"fields":{"registration_type":null,"registration_date":null,"region":null,"city":null,"street":null,"house":null,"building":null,"apartment":null,"full_address":null,"authority":null},"stamps_count":0,"issues":[],"summary":""}`;

export async function verifyPassportPhoto(image: string, options: { mimeType?: string; expected?: unknown } = {}) {
  try {
    const hint = options.expected ? `\nОжидаемые данные: ${JSON.stringify(options.expected)}` : "";
    const data = await generate(PHOTO_PROMPT + hint, image, options.mimeType);
    return { success: Boolean(data.success), type: "passport_photo", ...data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, type: "passport_photo", message, issues: [message] };
  }
}

export async function verifyPassportRegistration(image: string, options: { mimeType?: string; expected?: unknown } = {}) {
  try {
    const hint = options.expected ? `\nОжидаемые данные прописки: ${JSON.stringify(options.expected)}` : "";
    const data = await generate(REG_PROMPT + hint, image, options.mimeType);
    return { success: Boolean(data.success), type: "passport_registration", ...data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, type: "passport_registration", message, issues: [message] };
  }
}
