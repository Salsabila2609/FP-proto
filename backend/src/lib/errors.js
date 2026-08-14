export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new AppError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'Perlu login.') => new AppError(401, 'unauthorized', msg);
export const forbidden = (msg = 'Akses ditolak.') => new AppError(403, 'forbidden', msg);
export const notFound = (msg = 'Tidak ditemukan.') => new AppError(404, 'not_found', msg);
export const conflict = (msg) => new AppError(409, 'conflict', msg);
export const upstream = (msg, details) => new AppError(502, 'upstream_error', msg, details);
