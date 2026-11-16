import { copyFile, mkdir } from 'node:fs/promises';

const output = new URL('../dist-demo/', import.meta.url);
const screens = ['cashier', 'grill', 'fryer', 'handoff'];

await Promise.all(screens.map(async (screen) => {
  const directory = new URL(`${screen}/`, output);
  await mkdir(directory, { recursive: true });
  await copyFile(new URL('index.html', output), new URL('index.html', directory));
}));
