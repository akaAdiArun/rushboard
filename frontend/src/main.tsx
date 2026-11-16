import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowRight, BellRing, Check, CheckCircle2, Circle, CircleAlert, Clock3, CookingPot,
  Flame, HandPlatter, Hamburger, Minus, Plus, ReceiptText, Send, ShoppingBag, Timer,
} from 'lucide-react';
import '@fontsource-variable/inter';
import '@fontsource/barlow-condensed/latin-700.css';
import '@fontsource/barlow-condensed/latin-800.css';
import { request, RequestError, type Cart, type MenuItem, type Receipt, type Station, type Ticket, type TicketItem, type View } from './api';
import './style.css';

const screens = {
  cashier: { label: 'Cashier', icon: ReceiptText, title: 'New ticket', description: 'Build an order and send it straight to the kitchen.' },
  grill: { label: 'Grill', icon: Flame, title: 'Grill station', description: 'Work the grill queue from oldest ticket to newest.' },
  fryer: { label: 'Fryer', icon: CookingPot, title: 'Fryer station', description: 'Work the fryer queue from oldest ticket to newest.' },
  handoff: { label: 'Handoff', icon: HandPlatter, title: 'Handoff board', description: 'Call a ticket when every item on the order is done.' },
} as const;

const menuNotes = { burger: 'Griddled patty, pickles & house sauce', fries: 'Crisp golden fries, tossed in sea salt' };
const initialCart: Cart = { burger: 1, fries: 1 };
const pendingKey = 'rushboard.pending-order';
const formatTicket = (id: number) => `#${String(id).padStart(3, '0')}`;
const formatTime = (created_at: string) => new Date(created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function useBoard(view: View) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'offline'>('connecting');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const data = await request<Ticket[]>(`/boards/${view}`, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        });
        if (controller.signal.aborted) return;
        setTickets(data);
        setConnection('live');
      } catch {
        if (controller.signal.aborted) return;
        setConnection('offline');
      }
      timer = setTimeout(poll, 1500);
    }

    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [view, refresh]);

  return { tickets, connection, sync: () => setRefresh((value) => value + 1) };
}

function App() {
  const path = location.pathname.slice(1);
  const view: View = Object.hasOwn(screens, path) ? path as View : 'cashier';
  const { label, title, description, icon: ScreenIcon } = screens[view];
  const { tickets, connection, sync } = useBoard(view);
  const readyCount = tickets.filter((ticket) => ticket.ready).length;
  const isStation = view === 'grill' || view === 'fryer';

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="topbar">
        <div className="topbar-inner">
          <a href="/" className="brand" aria-label="RushBoard cashier home">
            <span className="brand-mark"><Flame size={22} fill="currentColor" /></span>
            <span>RushBoard</span>
          </a>
          <nav aria-label="Kitchen screens">
            {(Object.keys(screens) as View[]).map((screen) => {
              const { label, icon: Icon } = screens[screen];
              return <a key={screen} href={`/${screen}`} aria-current={screen === view ? 'page' : undefined}>
                <Icon size={17} /> {label}
              </a>;
            })}
          </nav>
          <span className={`connection ${connection}`} role="status">
            <i />{connection === 'live' ? 'Live sync' : connection === 'connecting' ? 'Connecting' : 'Reconnecting'}
          </span>
        </div>
      </header>
      <main id="main" className="workspace" tabIndex={-1}>
        <section className="hero" aria-labelledby="title">
          <div className="hero-intro">
            <div className="eyebrow"><ScreenIcon size={15} /> Service Lane Diner <span>/</span> {label}</div>
            <h1 id="title">{title}</h1>
            <p>{description}</p>
          </div>
          <div className="hero-counts" aria-label="Ticket counts">
            <div><strong>{connection === 'connecting' ? '–' : tickets.length - readyCount}</strong><span>{isStation ? 'In queue' : 'Cooking'}</span></div>
            {!isStation && <div><strong>{connection === 'connecting' ? '–' : readyCount}</strong><span>Ready</span></div>}
          </div>
        </section>
        {connection === 'offline' && <p className="sync-warning" role="status"><CircleAlert size={17} /> Kitchen connection interrupted. The board will retry automatically.</p>}
        {view === 'cashier' && <Cashier sync={sync} />}
        {isStation && <StationBoard station={view} tickets={tickets} sync={sync} loading={connection === 'connecting'} />}
        {view === 'handoff' && <Handoff tickets={tickets} sync={sync} loading={connection === 'connecting'} />}
      </main>
      <footer className="footer"><span>Service Lane Diner</span><span>RushBoard kitchen display</span></footer>
    </>
  );
}

interface PendingOrder { key: string; cart: Cart }

function readPending(): PendingOrder | null {
  try {
    const raw = sessionStorage.getItem(pendingKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function Cashier({ sync }: { sync: () => void }) {
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [menuError, setMenuError] = useState(false);
  const [menuAttempt, setMenuAttempt] = useState(0);
  const [pending, setPending] = useState(readPending);
  const [cart, setCart] = useState(() => pending?.cart ?? initialCart);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    request<MenuItem[]>('/menu').then((items) => { if (active) setMenu(items); })
      .catch(() => { if (active) setMenuError(true); });
    return () => { active = false; };
  }, [menuAttempt]);

  const total = cart.burger + cart.fries;
  function changeQuantity(code: MenuItem['code'], delta: number) {
    setCart((current) => ({ ...current, [code]: Math.min(9, Math.max(0, current[code] + delta)) }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending || total === 0 || !menu.length) return;
    setSending(true);
    setError('');
    setReceipt(null);
    try {
      const order = pending ?? { key: crypto.randomUUID(), cart };
      const items = Object.fromEntries(Object.entries(order.cart).filter(([, quantity]) => quantity > 0));
      sessionStorage.setItem(pendingKey, JSON.stringify(order));
      setPending(order);
      const result = await request<Receipt>('/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': order.key },
        body: JSON.stringify({ items }),
      });
      sessionStorage.removeItem(pendingKey);
      setPending(null);
      setReceipt(result);
      setCart(initialCart);
      sync();
    } catch (failure) {
      if (failure instanceof RequestError && [409, 422].includes(failure.status)) {
        sessionStorage.removeItem(pendingKey);
        setPending(null);
        setError(failure.message);
      } else {
        setError('The ticket could not be confirmed. Use Retry ticket to recover the original order.');
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="cashier-grid" onSubmit={submit}>
      <section aria-labelledby="menu-title">
        <div className="section-title"><h2 id="menu-title">Menu</h2><span>Service Lane counter</span></div>
        {menuError && <div className="empty"><p>Could not load the menu.</p><button type="button" className="outline" onClick={() => { setMenuError(false); setMenuAttempt((attempt) => attempt + 1); }}>Reload menu</button></div>}
        {!menuError && !menu.length && <p className="empty">Loading menu…</p>}
        <div className="menu-list">
          {menu.map((item) => {
            const Food = item.code === 'burger' ? Hamburger : ShoppingBag;
            const StationIcon = screens[item.station].icon;
            return <article className="menu-item" key={item.code}>
              <div className={`food-icon ${item.station}`}><Food size={29} strokeWidth={1.7} /></div>
              <div className="menu-description"><h3>{item.name}</h3><p>{menuNotes[item.code]}</p><span className={`station-tag ${item.station}`}><StationIcon size={13} /> {screens[item.station].label}</span></div>
              <div className="stepper" role="group" aria-label={`${item.name} quantity`}>
                <button type="button" aria-label={`Remove ${item.name}`} disabled={cart[item.code] === 0 || !!pending || sending} onClick={() => changeQuantity(item.code, -1)}><Minus size={16} /></button>
                <output aria-label={`${item.name} count`}>{cart[item.code]}</output>
                <button type="button" aria-label={`Add ${item.name}`} disabled={cart[item.code] === 9 || !!pending || sending} onClick={() => changeQuantity(item.code, 1)}><Plus size={16} /></button>
              </div>
            </article>;
          })}
        </div>
      </section>
      <section className="order-sheet" aria-labelledby="order-title">
        <div className="order-heading"><div className="order-icon"><ReceiptText size={22} /></div><div><h2 id="order-title">Current order</h2><p>Counter service</p></div></div>
        <ul className="order-items">
          {menu.filter((item) => cart[item.code] > 0).map((item) => <li key={item.code}><span>{item.name}</span><b>×{cart[item.code]}</b></li>)}
          {total === 0 && <li className="order-empty">Add an item to start a ticket.</li>}
        </ul>
        {pending && !sending && !error && <p className="action-error" role="status">There’s an unconfirmed order. Retry to recover its ticket.</p>}
        {error && <p className="action-error" role="alert">{error}</p>}
        <button className="primary send" disabled={sending || total === 0 || !menu.length} type="submit"><Send size={17} /> {sending ? 'Sending…' : pending ? 'Retry ticket' : 'Send to kitchen'} <ArrowRight size={17} /></button>
        {receipt && <p className="receipt-message" role="status"><CheckCircle2 size={19} /> Ticket {formatTicket(receipt.id)} sent to the kitchen.</p>}
      </section>
    </form>
  );
}

function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <div className="empty"><span><ReceiptText size={22} /></span><strong>{title}</strong><p>{children}</p></div>;
}

function TicketHeader({ ticket, showState = true }: { ticket: Ticket; showState?: boolean }) {
  return <header className="ticket-header">
    <div><span className="ticket-label">Ticket</span><h3>{formatTicket(ticket.id)}</h3></div>
    <div className="ticket-meta">
      <time dateTime={ticket.created_at}><Clock3 size={13} /> {formatTime(ticket.created_at)}</time>
      {showState && <span className={`state ${ticket.ready ? 'ready' : 'cooking'}`}>
        {ticket.ready ? <Check size={14} /> : <Timer size={14} />} {ticket.ready ? 'Ready' : 'Cooking'}
      </span>}
    </div>
  </header>;
}

function ActionButton({ path, children, className, sync }: { path: string; children: ReactNode; className: string; sync: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setSaving(true);
    setError('');
    try {
      await request<void>(path, { method: 'PUT' });
      sync();
    } catch (failure) {
      setError(failure instanceof RequestError ? failure.message : 'Update could not be confirmed. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return <div className="ticket-action">
    <button type="button" className={className} disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : children}</button>
    {error && <p className="action-error" role="alert">{error}</p>}
  </div>;
}

interface BoardProps { tickets: Ticket[]; sync: () => void; loading: boolean }

function StationBoard({ station, tickets, sync, loading }: BoardProps & { station: Station }) {
  return <section aria-labelledby="queue-title">
    <div className="section-title"><h2 id="queue-title">Station queue</h2><span>Oldest first</span></div>
    {loading ? <p className="empty">Loading tickets…</p> : tickets.length === 0 && <Empty title="Queue clear">New items will appear here as the cashier sends tickets.</Empty>}
    <div className="station-grid">
      {tickets.map((ticket) => <article className="ticket station-ticket" key={ticket.id} aria-label={`Ticket ${formatTicket(ticket.id)}`}>
        <TicketHeader ticket={ticket} showState={false} />
        {ticket.items.map((item) => <div className="station-item" key={item.id}>
          <div className="station-line"><span>×{item.quantity}</span><strong>{item.name}</strong></div>
          <ActionButton className="primary" path={`/stations/${station}/items/${item.id}/done`} sync={sync}><Check size={18} /> Mark done</ActionButton>
        </div>)}
      </article>)}
    </div>
  </section>;
}

function HandoffItem({ item }: { item: TicketItem }) {
  return <li className={item.done ? 'item-done' : ''}>
    {item.done ? <CheckCircle2 size={17} /> : <Circle size={17} />}
    <span className="item-name">{item.quantity}× {item.name}</span>
    <span className="item-state">{screens[item.station].label} · {item.done ? 'Done' : 'Pending'}</span>
  </li>;
}

function Handoff({ tickets, sync, loading }: BoardProps) {
  return <div className="board-grid">
    {[false, true].map((ready) => {
      const column = tickets.filter((ticket) => ticket.ready === ready);
      const Icon = ready ? BellRing : Timer;
      const heading = ready ? 'ready-column' : 'cooking-column';
      return <section key={heading} className={`board-column ${ready ? 'ready-column' : 'cooking-column'}`} aria-labelledby={heading}>
        <div className="column-heading"><span className="column-icon"><Icon size={19} /></span><h2 id={heading}>{ready ? 'Ready for pickup' : 'In the kitchen'}</h2><span className="column-count">{column.length}</span></div>
        {loading ? <p className="empty">Loading tickets…</p> : column.length === 0 && <Empty title={ready ? 'No tickets ready' : 'No tickets cooking'}>{ready ? 'Tickets move here when every station is done.' : 'New orders from the cashier appear here.'}</Empty>}
        <div className="column-tickets">
          {column.map((ticket) => <article className={`ticket ${ticket.ready ? 'ready-ticket' : ''}`} aria-label={`Ticket ${formatTicket(ticket.id)}`} key={ticket.id}>
            <TicketHeader ticket={ticket} />
            <ul className="ticket-items">{ticket.items.map((item) => <HandoffItem item={item} key={item.id} />)}</ul>
            {ticket.ready && <ActionButton path={`/tickets/${ticket.id}/handoff`} className="handoff-button" sync={sync}><Check size={17} /> Mark handed off</ActionButton>}
          </article>)}
        </div>
      </section>;
    })}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
