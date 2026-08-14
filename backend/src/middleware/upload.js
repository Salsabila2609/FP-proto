import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, readSync, closeSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import multer from 'multer';
import { config } from '../config/index.js';
import { badRequest } from '../lib/errors.js';

const ALLOWED_EXT = new Set(['.xlsx', '.xlsm', '.csv']);
const UPLOAD_ROOT = resolve(config.UPLOAD_DIR);
mkdirSync(UPLOAD_ROOT, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_ROOT),
  // Nama file dari user tidak pernah dipakai di disk: mencegah path traversal
  // dan tabrakan nama. Nama aslinya disimpan di database saja.
  filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`),
});

export const uploadExcel = multer({
  storage,
  limits: { fileSize: config.UPLOAD_MAX_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) return cb(badRequest(`Format ${ext || 'ini'} tidak didukung. Pakai .xlsx, .xlsm, atau .csv.`));
    cb(null, true);
  },
}).single('file');

/** Ekstensi bisa dipalsukan, jadi isi file ikut diperiksa. */
export function verifyFileSignature(path, originalName) {
  const ext = extname(originalName).toLowerCase();
  if (ext === '.csv') return;
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(4);
    readSync(fd, buf, 0, 4, 0);
    // xlsx/xlsm adalah arsip ZIP -> 'PK\x03\x04'
    if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
      throw badRequest('Isi file tidak cocok dengan ekstensinya.');
    }
  } finally {
    closeSync(fd);
  }
}

export function resolveUploadPath(storedName) {
  const full = resolve(UPLOAD_ROOT, storedName);
  if (!full.startsWith(UPLOAD_ROOT + '/')) throw badRequest('Jalur file tidak valid.');
  return full;
}
