// Cliente HTTP pro backend real (vod-api) — antes o painel inteiro rodava
// só com dados mockados no front-end (MOCK_STREAMS, saldo fixo, chaves
// fake). Configure VITE_VOD_API_URL no .env do painel em produção.
const BASE_URL = import.meta.env.VITE_VOD_API_URL || 'http://localhost:8790';

function getToken() {
  return localStorage.getItem('vagalun_token');
}

function setToken(token) {
  if (token) localStorage.setItem('vagalun_token', token);
  else localStorage.removeItem('vagalun_token');
}

async function request(path, { method = 'GET', body, isForm = false } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (!isForm && body) headers['Content-Type'] = 'application/json';

  const resp = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: isForm ? body : (body ? JSON.stringify(body) : undefined),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || json.ok === false) {
    throw new Error(json.error || `erro ${resp.status} em ${path}`);
  }
  return json;
}

export const api = {
  BASE_URL,
  getToken,
  setToken,
  register: (email, password) => request('/api/auth/register', { method: 'POST', body: { email, password } }),
  login: (email, password) => request('/api/auth/login', { method: 'POST', body: { email, password } }),
  me: () => request('/api/auth/me'),
  overview: () => request('/api/overview'),
  videos: () => request('/api/videos'),
  uploadVideos: (files, durationsSeconds) => {
    const form = new FormData();
    files.forEach((f) => form.append('video', f));
    form.append('durationsSeconds', JSON.stringify(durationsSeconds));
    return request('/api/videos/upload', { method: 'POST', body: form, isForm: true });
  },
  deleteVideo: (fileId) => request(`/api/videos/${encodeURIComponent(fileId)}`, { method: 'DELETE' }),
  billingBalance: () => request('/api/billing/balance'),
  billingHistory: () => request('/api/billing/history'),
  billingMethods: () => request('/api/billing/methods'),
  solanaRecharge: (amountUsd) => request('/api/billing/solana/recharge', { method: 'POST', body: { amountUsd } }),
  solanaPaymentStatus: (paymentId) => request(`/api/billing/solana/${paymentId}`),
  stripeCheckout: (amountUsd) => request('/api/billing/stripe/checkout', {
    method: 'POST',
    body: { amountUsd, successUrl: `${window.location.origin}/?billing=success`, cancelUrl: `${window.location.origin}/?billing=cancel` },
  }),
};
