import { createHash } from 'node:crypto';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { llmCache } from '../lib/cache.js';
import { AppError, upstream } from '../lib/errors.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

// Free tier Gemini punya kuota per menit yang ketat. Token bucket ini menahan
// permintaan di sisi kita supaya tidak memicu 429 beruntun.
const bucket = { tokens: config.GEMINI_RPM, updatedAt: Date.now() };

async function takeToken() {
  for (;;) {
    const now = Date.now();
    bucket.tokens = Math.min(config.GEMINI_RPM, bucket.tokens + ((now - bucket.updatedAt) / 60000) * config.GEMINI_RPM);
    bucket.updatedAt = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }
    await new Promise((r) => setTimeout(r, Math.ceil((60000 / config.GEMINI_RPM) * (1 - bucket.tokens))));
  }
}

/**
 * Panggil Gemini dan minta JSON terstruktur.
 *
 * Catatan keamanan: isi Excel dan nama kolom dari user masuk ke prompt, jadi
 * ini permukaan prompt injection. Tiga lapis pertahanan:
 *   1. data dibungkus penanda eksplisit dan model diperintahkan memperlakukan
 *      isinya sebagai data, bukan instruksi;
 *   2. output dipaksa mengikuti responseSchema, jadi bentuknya tidak bisa
 *      dibelokkan jadi teks bebas;
 *   3. hasilnya divalidasi zod di pemanggil dan tidak pernah dieksekusi
 *      sebagai SQL atau kode.
 */
export async function generateJson({ system, user, schema, cacheKey, temperature = 0.2 }) {
  if (!config.geminiEnabled) {
    throw new AppError(503, 'llm_disabled', 'GEMINI_API_KEY belum diisi, fitur AI nonaktif.');
  }

  const key = cacheKey ?? createHash('sha256').update(system + '\u0000' + user).digest('hex');
  const cached = llmCache.get(key);
  if (cached) return cached;

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      temperature,
      responseMimeType: 'application/json',
      ...(schema ? { responseSchema: schema } : {}),
    },
    safetySettings: [],
  };

  const text = await callWithRetry(body);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw upstream('Gemini mengembalikan JSON yang tidak bisa diparse.');
  }
  llmCache.set(key, parsed);
  return parsed;
}

export async function generateText({ system, user, temperature = 0.4, cacheKey }) {
  if (!config.geminiEnabled) {
    throw new AppError(503, 'llm_disabled', 'GEMINI_API_KEY belum diisi, fitur AI nonaktif.');
  }
  const key = cacheKey ?? createHash('sha256').update('t:' + system + '\u0000' + user).digest('hex');
  const cached = llmCache.get(key);
  if (cached) return cached;
  const text = await callWithRetry({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { temperature },
  });
  llmCache.set(key, text);
  return text;
}

async function callWithRetry(body, attempt = 0) {
  await takeToken();
  const url = `${ENDPOINT}/${config.GEMINI_MODEL}:generateContent`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.GEMINI_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.GEMINI_API_KEY },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 4) throw upstream(`Gemini ${res.status} setelah beberapa percobaan.`);
      const wait = Math.min(30000, 1000 * 2 ** attempt) + Math.random() * 500;
      logger.warn({ status: res.status, attempt, wait }, 'Gemini rate limit, menunggu');
      await new Promise((r) => setTimeout(r, wait));
      return callWithRetry(body, attempt + 1);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw upstream(`Gemini ${res.status}: ${detail.slice(0, 300)}`);
    }

    const json = await res.json();
    const parts = json?.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p.text ?? '').join('').trim();
    if (!text) throw upstream('Gemini tidak mengembalikan teks.');
    return text;
  } catch (err) {
    if (err.name === 'AbortError') throw upstream('Gemini timeout.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
