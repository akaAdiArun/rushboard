export type Station = 'grill' | 'fryer';
export type View = 'cashier' | Station | 'handoff';
export type MenuCode = 'burger' | 'fries';
export type Cart = Record<MenuCode, number>;
export type OrderItems = Partial<Cart>;

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

export interface KitchenApi {
  menu(): Promise<MenuItem[]>;
  board(view: View, signal: AbortSignal): Promise<Ticket[]>;
  submit(key: string, items: OrderItems): Promise<Receipt>;
  complete(station: Station, itemId: number): Promise<void>;
  handoff(ticketId: number): Promise<void>;
}
