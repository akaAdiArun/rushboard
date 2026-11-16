export type Station = 'grill' | 'fryer';
export type View = 'cashier' | Station | 'handoff';
export type MenuCode = 'burger' | 'fries';
export type Cart = Record<MenuCode, number>;

export interface MenuItem {
  code: MenuCode;
  name: string;
  station: Station;
}

export interface Receipt {
  id: number;
  created_at: string;
}

export interface TicketItem {
  id: number;
  name: string;
  station: Station;
  quantity: number;
  done: boolean;
}

export interface Ticket extends Receipt {
  ready: boolean;
  items: TicketItem[];
}

export class RequestError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
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
