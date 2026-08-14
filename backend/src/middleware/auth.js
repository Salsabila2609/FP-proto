import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { unauthorized, forbidden } from '../lib/errors.js';

const ROLE_RANK = { viewer: 0, analyst: 1, admin: 2 };

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, name: user.name },
    config.JWT_SECRET,
    { expiresIn: `${config.JWT_TTL_HOURS}h` },
  );
}

/** Token dibaca dari cookie httpOnly; header Bearer disediakan untuk klien non-browser. */
export function authenticate(req, _res, next) {
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;
  const token = req.cookies?.token ?? bearer;
  if (!token) return next(unauthorized());
  try {
    req.user = jwt.verify(token, config.JWT_SECRET);
    next();
  } catch {
    next(unauthorized('Sesi tidak valid atau sudah lewat. Login lagi.'));
  }
}

export const requireRole = (role) => (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if ((ROLE_RANK[req.user.role] ?? -1) < ROLE_RANK[role]) {
    return next(forbidden(`Butuh peran ${role} untuk tindakan ini.`));
  }
  next();
};

export const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: config.isProd,
  maxAge: config.JWT_TTL_HOURS * 3600 * 1000,
  path: '/',
};
