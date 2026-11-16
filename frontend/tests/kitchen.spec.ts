import { expect, test, type Page } from '@playwright/test';

const ticketCard = (page: Page, number: string) => page.getByRole('article', { name: `Ticket ${number}` });
const publicDemo = process.env.RUSHBOARD_DEMO === '1';

async function sentTicket(cashier: Page) {
  const receipt = cashier.getByText(/Ticket #\d+ sent to the kitchen/);
  await expect(receipt).toBeVisible();
  const text = await receipt.textContent();
  const number = text?.match(/#\d+/)?.[0];
  if (!number) throw new Error('The cashier did not show a ticket number.');
  return number;
}

test('four screens route and complete an order without refreshing', async ({ page: cashier, context }) => {
  const [grill, fryer, handoff] = await Promise.all([context.newPage(), context.newPage(), context.newPage()]);
  await Promise.all([cashier, grill, fryer, handoff].map((page) => page.goto('./')));
  await Promise.all([
    grill.getByRole('link', { name: 'Grill', exact: true }).click(),
    fryer.getByRole('link', { name: 'Fryer', exact: true }).click(),
    handoff.getByRole('link', { name: 'Handoff', exact: true }).click(),
  ]);
  await expect(cashier.getByRole('heading', { name: 'New ticket' })).toBeVisible();
  await expect(grill.getByRole('heading', { name: 'Grill station' })).toBeVisible();
  await expect(fryer.getByRole('heading', { name: 'Fryer station' })).toBeVisible();
  await expect(handoff.getByRole('heading', { name: 'Handoff board' })).toBeVisible();

  await cashier.getByRole('button', { name: 'Send to kitchen' }).click();
  const number = await sentTicket(cashier);
  const grillCard = ticketCard(grill, number);
  const fryerCard = ticketCard(fryer, number);
  const cooking = handoff.getByRole('region', { name: 'In the kitchen' });
  const ready = handoff.getByRole('region', { name: 'Ready for pickup' });
  const cookingCard = cooking.getByRole('article', { name: `Ticket ${number}` });
  const readyCard = ready.getByRole('article', { name: `Ticket ${number}` });

  await expect(grillCard).toContainText('Smash Burger');
  await expect(grillCard).not.toContainText('Sea Salt Fries');
  await expect(fryerCard).toContainText('Sea Salt Fries');
  await expect(fryerCard).not.toContainText('Smash Burger');
  await expect(cookingCard).toContainText('Grill · Pending');
  await expect(cookingCard).toContainText('Fryer · Pending');
  await expect(readyCard).toHaveCount(0);

  await grillCard.getByRole('button', { name: 'Mark done' }).click();
  await expect(grillCard).toHaveCount(0);
  await expect(cookingCard).toContainText('Grill · Done');
  await expect(cookingCard).toContainText('Fryer · Pending');
  await expect(readyCard).toHaveCount(0);

  await fryerCard.getByRole('button', { name: 'Mark done' }).click();
  await expect(fryerCard).toHaveCount(0);
  await expect(readyCard).toContainText('Grill · Done');
  await expect(readyCard).toContainText('Fryer · Done');
  await expect(cookingCard).toHaveCount(0);

  if (process.env.RUSHBOARD_SCREENSHOT) {
    await cashier.getByRole('button', { name: 'Send to kitchen' }).click();
    const second = await sentTicket(cashier);
    const secondGrill = ticketCard(grill, second);
    const secondFryer = ticketCard(fryer, second);
    await secondGrill.getByRole('button', { name: 'Mark done' }).click();
    await expect(cooking.getByRole('article', { name: `Ticket ${second}` })).toContainText('Grill · Done');
    await handoff.screenshot({ path: process.env.RUSHBOARD_SCREENSHOT });
    await secondFryer.getByRole('button', { name: 'Mark done' }).click();
    await ticketCard(handoff, second).getByRole('button', { name: 'Mark handed off' }).click();
  }

  await readyCard.getByRole('button', { name: 'Mark handed off' }).click();
  await expect(ticketCard(handoff, number)).toHaveCount(0);
});

test('a lost response and cashier reload recover the same ticket', async ({ page: cashier, context }) => {
  test.skip(publicDemo, 'This scenario intercepts the FastAPI network response.');
  const handoff = await context.newPage();
  await Promise.all([cashier.goto('/cashier'), handoff.goto('/handoff')]);
  let originalNumber = '';
  let originalKey: string | undefined;

  await cashier.route('**/api/tickets', async (route) => {
    originalKey = route.request().headers()['idempotency-key'];
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    const { id } = await response.json();
    originalNumber = `#${String(id).padStart(3, '0')}`;
    await route.abort('connectionreset');
  }, { times: 1 });

  await cashier.getByRole('button', { name: 'Send to kitchen' }).click();
  await expect(cashier.getByRole('alert')).toContainText('could not be confirmed');
  await expect(ticketCard(handoff, originalNumber)).toBeVisible();

  await cashier.reload();
  const replayPromise = cashier.waitForResponse((response) => response.url().endsWith('/api/tickets'));
  await cashier.getByRole('button', { name: 'Retry ticket' }).click();
  const replay = await replayPromise;
  expect(replay.status()).toBe(200);
  expect(originalKey).toBeTruthy();
  expect(replay.request().headers()['idempotency-key']).toBe(originalKey);
  expect(await sentTicket(cashier)).toBe(originalNumber);
  const [{ items }] = (await (await cashier.request.get('/api/boards/handoff')).json())
    .filter((ticket: { id: number }) => ticket.id === Number(originalNumber.slice(1)));
  for (const item of items) {
    expect((await cashier.request.put(`/api/stations/${item.station}/items/${item.id}/done`)).status()).toBe(204);
  }
  expect((await cashier.request.put(`/api/tickets/${Number(originalNumber.slice(1))}/handoff`)).status()).toBe(204);
});

test('the public demo recovers one ticket when two tabs retry together', async ({ page: cashier, context }) => {
  test.skip(!publicDemo, 'This scenario exercises the browser demo storage.');
  const retry = await context.newPage();
  const handoff = await context.newPage();
  await Promise.all([cashier.goto('./cashier/'), retry.goto('./cashier/'), handoff.goto('./handoff/')]);
  const order = { key: '79d96564-6aeb-416a-9d9f-1884de51f550', cart: { burger: 1, fries: 1 } };
  await Promise.all([cashier, retry].map(async (page) => {
    await page.evaluate((pending) => sessionStorage.setItem('rushboard.pending-order', JSON.stringify(pending)), order);
    await page.reload();
  }));
  await Promise.all([cashier, retry].map((page) => page.getByRole('button', { name: 'Retry ticket' }).click()));
  const [originalNumber, retryNumber] = await Promise.all([sentTicket(cashier), sentTicket(retry)]);
  expect(retryNumber).toBe(originalNumber);
  await expect(ticketCard(handoff, originalNumber)).toContainText('1× Smash Burger');
  await expect(handoff.getByRole('article')).toHaveCount(1);
});
