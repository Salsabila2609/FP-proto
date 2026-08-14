const base = '/api';

async function request(path, { method = 'GET', body, isForm } = {}) {
  const res = await fetch(base + path, {
    method,
    credentials: 'include',
    headers: isForm ? undefined : body ? { 'content-type': 'application/json' } : undefined,
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.error?.message ?? `Permintaan gagal (${res.status})`);
    err.code = data?.error?.code;
    err.details = data?.error?.details;
    throw err;
  }
  return data;
}

export const api = {
  meta: () => request('/meta'),
  me: () => request('/auth/me'),
  login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password } }),
  logout: () => request('/auth/logout', { method: 'POST' }),

  tables: () => request('/data/tables'),
  gaps: (key, from, to) => request(`/data/tables/${key}/gaps?from=${from}&to=${to}`),
  runs: () => request('/data/runs'),
  syncNow: () => request('/data/sync', { method: 'POST' }),
  backfill: (payload) => request('/data/backfill', { method: 'POST', body: payload }),
  jobs: () => request('/data/jobs'),
  job: (id) => request(`/data/jobs/${id}`),

  upload: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return request('/uploads', { method: 'POST', body: fd, isForm: true });
  },
  reprofile: (id, payload) => request(`/uploads/${id}/profile`, { method: 'POST', body: payload }),
  suggestMapping: (id, payload) => request(`/uploads/${id}/suggest-mapping`, { method: 'POST', body: payload }),
  previewMapping: (id, mapping) => request(`/uploads/${id}/preview`, { method: 'POST', body: { mapping } }),
  commitUpload: (id, payload) => request(`/uploads/${id}/commit`, { method: 'POST', body: payload }),

  programs: () => request('/programs'),
  discover: () => request('/programs/discover'),
  baseTables: () => request('/programs/base-tables'),
  baseTableValues: (table, column) => request(`/programs/base-tables/${table}/values?column=${encodeURIComponent(column)}`),
  previewPopulation: (payload) => request('/programs/population/preview', { method: 'POST', body: payload }),
  createPopulationProgram: (payload) => request('/programs/population', { method: 'POST', body: payload }),
  importDiscovered: (payload) => request('/programs/discover/import', { method: 'POST', body: payload }),
  refreshFiles: (key) => request('/data/files/refresh', { method: 'POST', body: key ? { key } : {} }),
  program: (id) => request(`/programs/${id}`),
  recipes: () => request('/programs/recipes'),
  ranking: (params = '') => request(`/programs/ranking${params}`),
  evaluate: (id) => request(`/programs/${id}/evaluate`, { method: 'POST' }),
  narrate: (id, force = false) => request(`/programs/${id}/narrate`, { method: 'POST', body: { force } }),
};