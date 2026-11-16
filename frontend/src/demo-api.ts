import { type KitchenApi, type MenuItem, type OrderItems, type Receipt, RequestError, type TicketItem } from './contracts';

const menu: MenuItem[] = [
  { code: 'burger', name: 'Smash Burger', station: 'grill' },
  { code: 'fries', name: 'Sea Salt Fries', station: 'fryer' },
];

interface DemoTicket extends Receipt {
  key: string;
  order: OrderItems;
  items: TicketItem[];
  handedOff: boolean;
}

interface KitchenState {
  nextTicket: number;
  nextItem: number;
  tickets: DemoTicket[];
}

let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('rushboard-pages', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('kitchen');
    request.onsuccess = () => {
      const connection = request.result;
      connection.onversionchange = () => {
        connection.close();
        database = undefined;
      };
      resolve(connection);
    };
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    database = undefined;
    throw error;
  });
  return database;
}

async function withKitchen<T>(mode: IDBTransactionMode, change: (state: KitchenState) => T): Promise<T> {
  const connection = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    // A read-write transaction keeps ticket creation and retry checks atomic across tabs.
    const transaction = connection.transaction('kitchen', mode);
    const store = transaction.objectStore('kitchen');
    const request = store.get('board');
    let value: T;
    let failure: unknown;
    request.onsuccess = () => {
      const state: KitchenState = request.result ?? { nextTicket: 1, nextItem: 1, tickets: [] };
      try {
        value = change(state);
        if (mode === 'readwrite') store.put(state, 'board');
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    transaction.oncomplete = () => resolve(value);
    transaction.onabort = () => reject(failure ?? transaction.error);
  });
}

const ready = (ticket: DemoTicket) => ticket.items.every((item) => item.done);

export const demoApi: KitchenApi = {
  menu: async () => menu,
  board: async (view, signal) => {
    signal.throwIfAborted();
    const station = view === 'grill' || view === 'fryer' ? view : undefined;
    return withKitchen('readonly', ({ tickets }) => tickets.filter((ticket) => !ticket.handedOff).flatMap((ticket) => {
      const items = station ? ticket.items.filter((item) => item.station === station && !item.done) : ticket.items;
      return items.length ? [{ id: ticket.id, created_at: ticket.created_at, ready: ready(ticket), items }] : [];
    }));
  },
  submit: (key, order) => withKitchen('readwrite', (state) => {
    const ticket = state.tickets.find((candidate) => candidate.key === key);
    if (ticket) {
      if (menu.some(({ code }) => ticket.order[code] !== order[code])) {
        throw new RequestError(409, 'This key belongs to a different order.');
      }
      return { id: ticket.id, created_at: ticket.created_at };
    }
    const items = menu.flatMap(({ code, name, station }) => {
      const quantity = order[code];
      return quantity ? [{ id: state.nextItem++, name, station, quantity, done: false }] : [];
    });
    if (!items.length) throw new RequestError(422, 'Add an item to start a ticket.');
    const receipt = { id: state.nextTicket++, created_at: new Date().toISOString() };
    state.tickets.push({ ...receipt, key, order, items, handedOff: false });
    return receipt;
  }),
  complete: (station, id) => withKitchen('readwrite', ({ tickets }) => {
    const item = tickets.flatMap((ticket) => ticket.items).find((item) => item.id === id && item.station === station);
    if (!item) throw new RequestError(404, 'Item not found at this station.');
    item.done = true;
  }),
  handoff: (id) => withKitchen('readwrite', ({ tickets }) => {
    const ticket = tickets.find((ticket) => ticket.id === id);
    if (!ticket) throw new RequestError(404, 'Ticket not found.');
    if (!ready(ticket)) throw new RequestError(409, 'Some items on this ticket are still cooking.');
    ticket.handedOff = true;
  }),
};
