import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const FOTOS_BUCKET = "kz-files";

function client() {
  return new S3Client({
    region: process.env.S3_REGION || "eu-central-1",
    endpoint: process.env.S3_ENDPOINT || "https://object.pscloud.io",
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.KZ_ACCESS_KEY ?? "",
      secretAccessKey: process.env.KZ_SECRET_KEY ?? "",
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

export function s3() {
  return client();
}

function normalizeKey(key: string) {
  if (!key) throw new Error("filename (key) обязателен");
  return key.replace(/^\/+/, "");
}

function assertCredentials() {
  if (!process.env.KZ_ACCESS_KEY || !process.env.KZ_SECRET_KEY) {
    throw new Error("KZ_ACCESS_KEY / KZ_SECRET_KEY не настроены");
  }
}

export async function uploadFotos(key: string, body: Uint8Array, contentType?: string) {
  const filePath = normalizeKey(key);
  assertCredentials();
  await client().send(new PutObjectCommand({
    Bucket: FOTOS_BUCKET,
    Key: filePath,
    Body: body,
    ContentType: contentType || "application/octet-stream",
  }));
  return { filePath, signed_url: await presignGet(FOTOS_BUCKET, filePath) };
}

export async function getFotosBuffer(key: string) {
  const filePath = normalizeKey(key);
  assertCredentials();
  try {
    const result = await client().send(new GetObjectCommand({ Bucket: FOTOS_BUCKET, Key: filePath }));
    const bytes = await result.Body?.transformToByteArray();
    if (!bytes) throw new Error("Пустой файл");
    return {
      filePath,
      buffer: Buffer.from(bytes),
      contentType: result.ContentType || "application/octet-stream",
      contentLength: result.ContentLength,
    };
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number }; name?: string }).$metadata?.httpStatusCode;
    const name = (error as { name?: string }).name;
    if (name === "NoSuchKey" || status === 404) {
      const notFound = new Error("Файл не найден") as Error & { status?: number };
      notFound.status = 404;
      throw notFound;
    }
    throw error;
  }
}

export async function resolveImageInput(input: Record<string, unknown> = {}) {
  const s3Key = (input.filename || input.key || input.filePath) as string | undefined;
  if (s3Key) {
    const loaded = await getFotosBuffer(s3Key);
    const type = loaded.contentType || "image/jpeg";
    return {
      image: `data:${type};base64,${loaded.buffer.toString("base64")}`,
      mimeType: type,
      filePath: loaded.filePath,
    };
  }
  const raw = (input.image || input.photo || input.file) as string | undefined;
  if (!raw) {
    const err = new Error("Укажите filename/key (ключ в S3) или image (base64)") as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  return {
    image: raw,
    mimeType: (input.mimeType || input.mime_type || "image/jpeg") as string,
  };
}

export function decodeBase64File(input: string, fallbackMime = "application/octet-stream") {
  if (!input) throw new Error("image/file обязателен (base64 или data URL)");
  let data = input.trim();
  let mimeType = fallbackMime;
  const match = data.match(/^data:([^;]+);base64,(.+)$/s);
  if (match) {
    mimeType = match[1] || fallbackMime;
    data = match[2] ?? "";
  } else if (data.includes(",")) {
    data = data.split(",").pop() ?? "";
  }
  data = data.replace(/\s/g, "");
  const buffer = Buffer.from(data, "base64");
  if (!buffer.length) throw new Error("Пустые данные файла после декодирования base64");
  return { buffer, mimeType };
}

export async function presignPut(bucket: string, key: string, expiresIn = 60) {
  assertCredentials();
  const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: "" });
  return getSignedUrl(client(), command, {
    expiresIn,
    signableHeaders: new Set(["host"]),
  });
}

export async function presignGet(bucket: string, key: string, expiresIn = 60) {
  assertCredentials();
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(client(), command, { expiresIn, signableHeaders: new Set(["host"]) });
}

export async function fileAccess(bucket: string, key: string) {
  const filePath = normalizeKey(key);
  const [upload_url, signed_url] = await Promise.all([
    presignPut(bucket, filePath),
    presignGet(bucket, filePath),
  ]);
  return { filePath, upload_url, signed_url };
}
