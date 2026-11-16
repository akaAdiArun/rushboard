CREATE TABLE IF NOT EXISTS menu_items (
    code text PRIMARY KEY,
    name text NOT NULL,
    station text NOT NULL CHECK (station IN ('grill', 'fryer'))
);

INSERT INTO menu_items (code, name, station) VALUES
    ('burger', 'Smash Burger', 'grill'),
    ('fries', 'Sea Salt Fries', 'fryer')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS tickets (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    idempotency_key uuid NOT NULL UNIQUE,
    order_payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    handed_off_at timestamptz
);

CREATE TABLE IF NOT EXISTS ticket_items (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id integer NOT NULL REFERENCES tickets (id),
    menu_code text NOT NULL REFERENCES menu_items (code),
    station text NOT NULL CHECK (station IN ('grill', 'fryer')),
    quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 9),
    completed_at timestamptz,
    UNIQUE (ticket_id, menu_code)
);

CREATE INDEX IF NOT EXISTS active_tickets ON tickets (id) WHERE handed_off_at IS NULL;
