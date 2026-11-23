// Apply migrations 001-047 on a throwaway local Postgres and run the
// payment SQL cases. The URL is parsed here and never given to psql.
// psql receives -h, -p, -U and -d only. pg_cron and pg_net are stubbed;
// the migration files themselves are not edited.
//
//   PAYMENT_SQL_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres npm run test:sql
//   node scripts/test-payment-sql.mjs --check-guard
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
const ciUrl = 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';

const localHosts = new Set(['127.0.0.1', '::1', 'localhost']);
const targetParams = new Set(['host', 'hostaddr', 'port', 'dbname', 'service']);
const refusedUrls = [
  'postgresql://127.0.0.1?x=@203.0.113.9/postgres',
  'postgresql://127.0.0.1#@203.0.113.9/postgres',
  'postgresql://localhost?@203.0.113.9:5432/postgres',
  'postgresql://u@127.0.0.1/postgres?host=203.0.113.9',
  'postgresql://u@127.0.0.1/postgres?hostaddr=203.0.113.9',
];

function parseConnection(connection) {
  if (typeof connection !== 'string' || connection.includes('#')) {
    throw new Error('Refusing a Postgres URL that contains "#".');
  }
  let url;
  try {
    url = new URL(connection);
  } catch {
    throw new Error('PAYMENT_SQL_DATABASE_URL must be a postgres URL.');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('PAYMENT_SQL_DATABASE_URL must be a postgres URL.');
  }
  if (url.search.includes('@') || url.hash.includes('@')) {
    throw new Error('Refusing a Postgres URL with "@" in the query or fragment.');
  }
  if (/supabase\.(co|com)|pooler\.supabase/i.test(connection) || /supabase\.(co|com)|pooler\.supabase/i.test(url.hostname)) {
    throw new Error('Refusing to run the SQL test against Supabase.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!localHosts.has(host)) {
    throw new Error(`Refusing non-local Postgres host "${host || '(missing)'}".`);
  }
  for (const key of url.searchParams.keys()) {
    if (targetParams.has(key.toLowerCase())) {
      throw new Error(`Refusing connection parameter "${key}".`);
    }
  }
  const username = url.username;
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const port = url.port || '5432';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(username)) {
    throw new Error('Refusing a username that is not a plain identifier.');
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(database)) {
    throw new Error('Refusing a database name that is not a plain identifier.');
  }
  if (!/^[0-9]+$/.test(port)) {
    throw new Error(`Refusing a non-numeric port "${port}".`);
  }
  return {
    host,
    port,
    username,
    database,
    password: url.password,
  };
}

function psqlArgs(conn) {
  const args = [
    '-h', conn.host,
    '-p', conn.port,
    '-U', conn.username,
    '-d', conn.database,
    '-v', 'ON_ERROR_STOP=1',
    '-X',
    '-q',
  ];
  if (args.some((arg) => arg.includes('://') || arg.includes('@') || arg.includes('#'))) {
    throw new Error('psql arguments must not contain a URL.');
  }
  return args;
}

function psqlEnv(password) {
  const env = { ...process.env };
  delete env.PGHOST;
  delete env.PGHOSTADDR;
  delete env.PGSERVICE;
  delete env.PGSERVICEFILE;
  delete env.PGDATABASE;
  delete env.PGPORT;
  if (password) env.PGPASSWORD = password;
  else delete env.PGPASSWORD;
  return env;
}

function psql(conn, { file, sql } = {}) {
  if (typeof conn !== 'object' || conn === null || typeof conn.host !== 'string') {
    throw new Error('psql refuses a URL. Pass the parsed connection.');
  }
  const args = psqlArgs(conn);
  if (file) args.push('-f', file);
  const result = spawnSync('psql', args, {
    input: file ? undefined : sql,
    encoding: 'utf8',
    env: psqlEnv(conn.password),
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

function checkGuard() {
  const lines = [];
  for (const url of refusedUrls) {
    try {
      parseConnection(url);
    } catch {
      lines.push(`guard refused: ${url}`);
      continue;
    }
    throw new Error(`guard accepted ${url}`);
  }
  const conn = parseConnection(ciUrl);
  const args = psqlArgs(conn);
  const expected = ['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', 'postgres'];
  if (expected.some((part, index) => args[index] !== part)) {
    throw new Error(`CI URL was parsed as ${args.join(' ')}`);
  }
  if (conn.password !== 'postgres') {
    throw new Error('CI URL password was not kept for PGPASSWORD.');
  }
  lines.push(`guard accepted: ${ciUrl} -> ${expected.join(' ')}`);
  return lines;
}

function main() {
  checkGuard();
  const maintenance = parseConnection(maintenanceUrl);
  const dbName = `subup_payment_sql_${randomBytes(4).toString('hex')}`;
  if (!/^[a-z0-9_]+$/.test(dbName)) {
    throw new Error('Refusing the generated database name.');
  }
  const testConn = { ...maintenance, database: dbName };
  const scratch = mkdtempSync(join(tmpdir(), 'subup-payment-sql-'));
  let created = false;
  try {
    psql(maintenance, { sql: `create database ${dbName};` });
    created = true;
    psql(testConn, { file: join(root, 'supabase/tests/payment-sql-stubs.sql') });

    const migrationsDir = join(root, 'supabase/migrations');
    const migrations = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
    for (const name of migrations) {
      const out = join(scratch, name);
      writeFileSync(out, migrationSql(join(migrationsDir, name)));
      psql(testConn, { file: out });
    }
    // 042 and 047 must apply cleanly a second time.
    for (const name of ['042_payment_107.sql', '047_drop_released_leave.sql']) {
      psql(testConn, { file: join(scratch, name) });
    }

    const output = psql(testConn, { file: join(root, 'supabase/tests/payment-sql-cases.sql') });
    const passed = [...output.matchAll(/case ok: .+/g)].map((found) => found[0]);
    if (passed.length !== 6) {
      throw new Error(`Expected 6 SQL cases, saw ${passed.length}.\n${output}`);
    }
    console.log(`payment sql: ${passed.length} passed`);
    for (const line of passed) console.log(`  ${line}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    if (created) {
      try {
        psql(maintenance, { sql: `drop database if exists ${dbName} with (force);` });
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
      }
    }
  }
}

try {
  if (process.argv.includes('--check-guard')) {
    for (const line of checkGuard()) console.log(line);
  } else {
    main();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
