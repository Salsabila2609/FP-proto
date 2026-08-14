import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { queryOne } from '../db/duckdb.js';
import { signToken, cookieOptions, authenticate } from '../middleware/auth.js';
import { loginLimiter } from '../middleware/rateLimit.js';
import { wrap } from '../lib/asyncHandler.js';
import { unauthorized } from '../lib/errors.js';

const router = Router();
const credentials = z.object({ email: z.string().email(), password: z.string().min(1) });

router.post('/login', loginLimiter, wrap(async (req, res) => {
  const { email, password } = credentials.parse(req.body);
  const user = await queryOne('SELECT * FROM app_user WHERE email = ? AND is_active', [email.toLowerCase()]);
  // Hash dummy dijalankan walau user tidak ada, supaya waktu respons tidak
  // membocorkan email mana yang terdaftar.
  const hash = user?.password_hash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu';
  const ok = await bcrypt.compare(password, hash);
  if (!user || !ok) throw unauthorized('Email atau kata sandi salah.');

  res.cookie('token', signToken(user), cookieOptions);
  res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
}));

router.post('/logout', (_req, res) => {
  res.clearCookie('token', { ...cookieOptions, maxAge: undefined });
  res.json({ ok: true });
});

router.get('/me', authenticate, (req, res) => {
  res.json({ user: { id: req.user.sub, email: req.user.email, name: req.user.name, role: req.user.role } });
});

export default router;
