import os
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg import sql
from psycopg.conninfo import make_conninfo

from rushboard.main import create_app


@pytest.fixture
def database():
    base = os.environ.get('TEST_DATABASE_URL')
    if not base:
        pytest.fail('Set TEST_DATABASE_URL to a PostgreSQL test database.')
    schema = f'test_{uuid4().hex}'
    with psycopg.connect(base, autocommit=True) as admin:
        admin.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
        try:
            yield make_conninfo(base, options=f'-c search_path={schema}')
        finally:
            admin.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))


@pytest.fixture
def client(database):
    with TestClient(create_app(database)) as test_client:
        yield test_client


def submit(client, key=None, **items):
    return client.post(
        '/api/tickets',
        headers={'Idempotency-Key': str(key or uuid4())},
        json={'items': items or {'burger': 1, 'fries': 1}},
    )


def board(client, view):
    response = client.get(f'/api/boards/{view}')
    assert response.status_code == 200
    return response.json()


def complete(client, station, item_id):
    return client.put(f'/api/stations/{station}/items/{item_id}/done')


def test_items_are_routed_to_their_own_stations(client):
    receipt = submit(client, burger=2, fries=1)
    assert receipt.status_code == 201
    grill, = board(client, 'grill')
    fryer, = board(client, 'fryer')
    burger, = grill['items']
    fries, = fryer['items']
    assert grill['id'] == fryer['id'] == receipt.json()['id']
    assert (burger['name'], burger['station'], burger['quantity']) == ('Smash Burger', 'grill', 2)
    assert (fries['name'], fries['station'], fries['quantity']) == ('Sea Salt Fries', 'fryer', 1)
    assert complete(client, 'fryer', burger['id']).status_code == 404
    assert not board(client, 'grill')[0]['items'][0]['done']


@pytest.mark.parametrize('first,second', [('grill', 'fryer'), ('fryer', 'grill')])
def test_handoff_requires_every_item_and_updates_are_repeatable(client, first, second):
    ticket_id = submit(client).json()['id']
    handoff = f'/api/tickets/{ticket_id}/handoff'
    item_id = board(client, first)[0]['items'][0]['id']
    assert not board(client, 'handoff')[0]['ready']
    assert client.put(handoff).status_code == 409
    assert complete(client, first, item_id).status_code == 204
    assert complete(client, first, item_id).status_code == 204
    assert board(client, first) == []
    cooking, = board(client, 'handoff')
    assert not cooking['ready']
    assert {item['station']: item['done'] for item in cooking['items']} == {first: True, second: False}
    assert client.put(handoff).status_code == 409
    assert complete(client, second, board(client, second)[0]['items'][0]['id']).status_code == 204
    assert board(client, 'handoff')[0]['ready']
    assert client.put(handoff).status_code == 204
    assert client.put(handoff).status_code == 204
    assert board(client, 'handoff') == []


def test_retry_returns_original_receipt_and_rejects_a_changed_order(client):
    key = uuid4()
    original = submit(client, key, burger=1, fries=1)
    retry = submit(client, key, fries=1, burger=1)
    assert original.status_code == 201
    assert retry.status_code == 200
    assert original.json() == retry.json()
    assert submit(client, key, burger=2, fries=1).status_code == 409
    assert len(board(client, 'cashier')) == 1


def test_simultaneous_retries_create_one_ticket_in_postgresql(client, database):
    key = uuid4()
    start = Barrier(8, timeout=10)

    def send(_index):
        start.wait()
        return submit(client, key)

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(send, range(8)))

    assert sorted(response.status_code for response in results) == [200] * 7 + [201]
    assert all(response.json() == results[0].json() for response in results)
    with psycopg.connect(database) as conn:
        assert conn.execute('SELECT count(*) FROM tickets').fetchone() == (1,)
        assert conn.execute('SELECT count(*) FROM ticket_items').fetchone() == (2,)


@pytest.mark.parametrize('items', [{}, {'burger': 0}, {'fries': '1'}, {'pizza': 1}])
def test_invalid_orders_create_no_tickets(client, items):
    response = client.post('/api/tickets', headers={'Idempotency-Key': str(uuid4())}, json={'items': items})
    assert response.status_code == 422
    assert board(client, 'handoff') == []
