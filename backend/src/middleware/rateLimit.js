import rateLimit from 'express-rate-limit';

const make = (windowMs, max, message) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: 'rate_limited', message } },
  });

export const generalLimiter = make(60_000, 300, 'Terlalu banyak permintaan. Coba lagi sebentar.');
export const loginLimiter = make(15 * 60_000, 10, 'Terlalu banyak percobaan login. Tunggu 15 menit.');
// Panggilan LLM dan sync itu mahal, jadi batasnya jauh lebih ketat.
export const expensiveLimiter = make(60_000, 12, 'Batas permintaan berat tercapai. Tunggu sebentar.');
