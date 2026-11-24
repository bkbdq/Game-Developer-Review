export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

const DEFAULT_BASE = '/api/admin';

export function createApi(token, base = DEFAULT_BASE) {
  if (!token) throw new Error('缺少登录凭证');

  async function request(path, { method = 'GET', body } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { message: text }; }
    }
    if (!response.ok) {
      throw new ApiError(data?.message || `HTTP ${response.status}`, response.status, data);
    }
    return data;
  }

  return {
    me: () => request('/me'),
    summary: () => request('/summary'),
    listPending: (limit = 50, offset = 0) => request(
      `/submissions?status=pending&limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`,
    ),
    approve: (id, payload) => request(`/submissions/${encodeURIComponent(id)}`, {
      method: 'POST', body: { action: 'approve', ...payload },
    }),
    reject: (id, payload) => request(`/submissions/${encodeURIComponent(id)}`, {
      method: 'POST', body: { action: 'reject', ...payload },
    }),
    listRequests: (status = 'received', type = '') => request(
      `/requests?status=${encodeURIComponent(status)}${type ? `&type=${encodeURIComponent(type)}` : ''}`,
    ),
    processRequest: (id, payload) => request(`/requests/${encodeURIComponent(id)}`, {
      method: 'POST', body: payload,
    }),
    listContacts: (status = 'received') => request(`/contacts?status=${encodeURIComponent(status)}`),
    handleContact: (id, payload = {}) => request(`/contacts/${encodeURIComponent(id)}`, {
      method: 'POST', body: { action: 'handle', ...payload },
    }),
  };
}
