import { type KitchenApi, RequestError } from './contracts';
import { demoApi } from './demo-api';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    signal: AbortSignal.timeout(8000),
    ...options,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new RequestError(response.status, typeof body?.detail === 'string'
      ? body.detail
      : 'The kitchen server could not complete the request.');
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}

export const publicDemo = import.meta.env.MODE === 'demo';

const httpApi: KitchenApi = {
  menu: () => request('/menu'),
  board: (view, signal) => request(`/boards/${view}`, { signal }),
  submit: (key, items) => request('/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ items }),
  }),
  complete: (station, itemId) => request(`/stations/${station}/items/${itemId}/done`, { method: 'PUT' }),
  handoff: (id) => request(`/tickets/${id}/handoff`, { method: 'PUT' }),
};

export const api = publicDemo ? demoApi : httpApi;
