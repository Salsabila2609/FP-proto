// Express 4 tidak menangkap rejection dari handler async, jadi semua route
// dibungkus ini supaya error selalu sampai ke errorHandler.
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
