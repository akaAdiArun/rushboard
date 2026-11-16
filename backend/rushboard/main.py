import os
from collections.abc import Iterator
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID

import psycopg
from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field

Station = Literal['grill', 'fryer']
MenuCode = Literal['burger', 'fries']
View = Literal['cashier', 'grill', 'fryer', 'handoff']
Quantity = Annotated[int, Field(strict=True, ge=1, le=9)]
Identifier = Annotated[int, Field(ge=1, le=2_147_483_647)]


class Order(BaseModel):
    model_config = ConfigDict(extra='forbid')

    items: Annotated[dict[MenuCode, Quantity], Field(min_length=1)]


class MenuItem(BaseModel):
    code: MenuCode
    name: str
    station: Station


class Receipt(BaseModel):
    id: int
    created_at: datetime


class TicketItem(BaseModel):
    id: int
    name: str
    station: Station
    quantity: int
    done: bool


class Ticket(Receipt):
    ready: bool
    items: list[TicketItem]


def create_app(database_url: str, frontend: Path | None = None) -> FastAPI:
    def connection() -> Iterator[psycopg.Connection]:
        with psycopg.connect(database_url, row_factory=dict_row, connect_timeout=5) as conn:
            yield conn

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        schema = Path(__file__).with_name('schema.sql').read_text(encoding='utf-8')
        with psycopg.connect(database_url, connect_timeout=5) as conn:
            conn.execute('SELECT pg_advisory_xact_lock(629710)')
            conn.execute(schema)
        yield

    app = FastAPI(title='RushBoard', lifespan=lifespan)
    Database = Annotated[psycopg.Connection, Depends(connection, scope='function')]

    @app.get('/api/health')
    def health(conn: Database) -> dict[str, str]:
        conn.execute('SELECT 1')
        return {'status': 'ok'}

    @app.get('/api/menu')
    def menu(conn: Database) -> list[MenuItem]:
        return conn.execute('SELECT code, name, station FROM menu_items ORDER BY code').fetchall()

    @app.post('/api/tickets', status_code=201, responses={200: {'model': Receipt}, 409: {'description': 'Key already used for another order'}})
    def submit_ticket(
        order: Order,
        response: Response,
        conn: Database,
        key: Annotated[UUID, Header(alias='Idempotency-Key')],
    ) -> Receipt:
        ticket = conn.execute(
            '''
            INSERT INTO tickets (idempotency_key, order_payload)
            VALUES (%s, %s)
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING id, created_at
            ''',
            (key, Jsonb(order.items)),
        ).fetchone()
        if ticket is None:
            # This statement gets a fresh snapshot after the competing insert commits.
            existing = conn.execute(
                'SELECT id, created_at, order_payload FROM tickets WHERE idempotency_key = %s',
                (key,),
            ).fetchone()
            if existing['order_payload'] != order.items:
                raise HTTPException(409, 'This key belongs to a different order.')
            response.status_code = 200
            return Receipt.model_validate(existing)

        conn.execute(
            '''
            INSERT INTO ticket_items (ticket_id, menu_code, station, quantity)
            SELECT %s, m.code, m.station, entry.quantity_text::integer
            FROM jsonb_each_text(%s) AS entry(code, quantity_text)
            JOIN menu_items m ON m.code = entry.code
            ''',
            (ticket['id'], Jsonb(order.items)),
        )
        return Receipt.model_validate(ticket)

    @app.get('/api/boards/{view}')
    def board(view: View, conn: Database, response: Response) -> list[Ticket]:
        response.headers['Cache-Control'] = 'no-store'
        station = view if view in ('grill', 'fryer') else None
        return conn.execute(
            '''
            SELECT t.id, t.created_at, bool_and(i.completed_at IS NOT NULL) AS ready,
                jsonb_agg(jsonb_build_object(
                    'id', i.id, 'name', m.name, 'station', i.station,
                    'quantity', i.quantity, 'done', i.completed_at IS NOT NULL
                ) ORDER BY m.code) AS items
            FROM tickets t
            JOIN ticket_items i ON i.ticket_id = t.id
            JOIN menu_items m ON m.code = i.menu_code
            WHERE t.handed_off_at IS NULL
              AND (%(station)s::text IS NULL OR (i.station = %(station)s AND i.completed_at IS NULL))
            GROUP BY t.id
            ORDER BY t.id
            ''',
            {'station': station},
        ).fetchall()

    @app.put('/api/stations/{station}/items/{item_id}/done', status_code=204)
    def complete_item(station: Station, item_id: Identifier, conn: Database) -> None:
        changed = conn.execute(
            '''
            UPDATE ticket_items SET completed_at = COALESCE(completed_at, now())
            WHERE id = %s AND station = %s
            RETURNING id
            ''',
            (item_id, station),
        ).fetchone()
        if changed is None:
            raise HTTPException(404, 'Item not found at this station.')

    @app.put('/api/tickets/{ticket_id}/handoff', status_code=204)
    def handoff_ticket(ticket_id: Identifier, conn: Database) -> None:
        changed = conn.execute(
            '''
            UPDATE tickets SET handed_off_at = COALESCE(handed_off_at, now())
            WHERE id = %s AND NOT EXISTS (
                SELECT 1 FROM ticket_items WHERE ticket_id = tickets.id AND completed_at IS NULL
            )
            RETURNING id
            ''',
            (ticket_id,),
        ).fetchone()
        if changed is None:
            exists = conn.execute('SELECT 1 FROM tickets WHERE id = %s', (ticket_id,)).fetchone()
            if exists is None:
                raise HTTPException(404, 'Ticket not found.')
            raise HTTPException(409, 'Some items on this ticket are still cooking.')

    if frontend is not None:
        app.mount('/assets', StaticFiles(directory=frontend / 'assets'), name='assets')

        @app.get('/', include_in_schema=False)
        @app.get('/{view}', include_in_schema=False)
        def screen(view: View = 'cashier') -> FileResponse:
            return FileResponse(frontend / 'index.html')

    return app


def app_factory() -> FastAPI:
    frontend = os.getenv('FRONTEND_DIR')
    return create_app(os.environ['DATABASE_URL'], Path(frontend) if frontend else None)
