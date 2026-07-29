import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

// docs/schema.sql is the design document and migration 0001 is its verbatim
// copy. This test is what enforces that they never diverge: change the schema
// via a NEW migration, and only touch docs/schema.sql if a decision in
// docs/architecture-decisions.md says so.
test('migration 0001 is a verbatim copy of docs/schema.sql', () => {
  const docs = read(path.resolve(here, '../../../docs/schema.sql'));
  const migration = read(path.resolve(here, '../migrations/0001_init.sql'));
  expect(migration).toBe(docs);
});
