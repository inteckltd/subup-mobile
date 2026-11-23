// Apply migrations 001-047 on a throwaway local Postgres and run the
// payment SQL cases. Refuses any host that is not loopback, and never
// talks to Supabase. pg_cron and pg_net are stubbed; the migration files
// themselves are not edited.
//
//   PAYMENT_SQL_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres npm run test:sql
//
// The URL is only the maintenance database. This script creates and drops
// its own database on that server.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const maintenanceUrl = process.env.PAYMENT_SQL_DATABASE_URL
  ?? 'postgresql://postgres@127.0.0.1:5432/postgres';

function connectionHost(connection) {
  const match = connection.match(/^[a-z+]+:\/\/(?:[^@/]+@)?(\[[^\]]+\]|[^:/?#]+)/i);
  return match ? match[1].replace(/^\[|\]$/g, '') : '';
}

function assertLocal(connection) {
  if (/supabase\.(co|com)|pooler\.supabase/i.test(connection)) {
    throw new Error('Refusing to run the SQL test against Supabase.');
  }
  const host = connectionHost(connection);
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(`Refusing non-local Postgres host "${host || '(missing)'}".`);
  }
}

function databaseUrl(base, name) {
  const match = base.match(/^([a-z+]+:\/\/[^/]+\/)([^/?]*)(.*)$/i);
  if (!match) throw new Error('PAYMENT_SQL_DATABASE_URL must be a postgres URL.');
  return `${match[1]}${name}${match[3] ?? ''}`;
}

function psql(connection, { file, sql } = {}) {
  const args = [connection, '-v', 'ON_ERROR_STOP=1', '-X', '-q'];
  if (file) args.push('-f', file);
  const result = spawnSync('psql', args, {
    input: file ? undefined : sql,
    encoding: 'utf8',
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  if (result.error) {
    throw new Error('psql is not installed. Install postgresql-client and point PAYMENT_SQL_DATABASE_URL at a local Postgres.');
  }
  if (result.status !== 0) {
    throw new Error(output || `psql exited ${result.status}`);
  }
  return output;
}

function migrationSql(path) {
  return readFileSync(path, 'utf8')
    .replaceAll(
      'create extension if not exists pg_cron with schema extensions;',
      '-- pg_cron is stubbed by supabase/tests/payment-sql-stubs.sql',
    )
    .replaceAll(
      'create extension if not exists pg_net with schema extensions;',
      '-- pg_net is stubbed by supabase/tests/payment-sql-stubs.sql',
    );
}

function main() {
  assertLocal(maintenanceUrl);
  const dbName = `subup_payment_sql_${randomBytes(4).toString('hex')}`;
  const testUrl = databaseUrl(maintenanceUrl, dbName);
  assertLocal(testUrl);
  const scratch = mkdtempSync(join(tmpdir(), 'subup-payment-sql-'));
  let created = false;
  try {
    psql(maintenanceUrl, { sql: `create database ${dbName};` });
    created = true;
    psql(testUrl, { file: join(root, 'supabase/tests/payment-sql-stubs.sql') });

    const migrationsDir = join(root, 'supabase/migrations');
    const migrations = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
    for (const name of migrations) {
      const out = join(scratch, name);
      writeFileSync(out, migrationSql(join(migrationsDir, name)));
      psql(testUrl, { file: out });
    }
    // 042 and 047 must apply cleanly a second time.
    for (const name of ['042_payment_107.sql', '047_drop_released_leave.sql']) {
      psql(testUrl, { file: join(scratch, name) });
    }

    const output = psql(testUrl, { file: join(root, 'supabase/tests/payment-sql-cases.sql') });
    const passed = [...output.matchAll(/case ok: .+/g)].map((found) => found[0]);
    if (passed.length !== 5) {
      throw new Error(`Expected 5 SQL cases, saw ${passed.length}.\n${output}`);
    }
    console.log(`payment sql: ${passed.length} passed`);
    for (const line of passed) console.log(`  ${line}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    if (created) {
      try {
        psql(maintenanceUrl, { sql: `drop database if exists ${dbName} with (force);` });
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
      }
    }
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
