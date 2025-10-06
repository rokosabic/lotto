import fs from 'fs';
import path from 'path';
import { pool } from './client';

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id SERIAL PRIMARY KEY,
    filename TEXT UNIQUE NOT NULL,
    applied_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`);
}

async function getApplied(): Promise<Set<string>> {
  const res = await pool.query('SELECT filename FROM schema_migrations');
  return new Set(res.rows.map((r) => r.filename as string));
}

async function applyMigration(filePath: string, filename: string): Promise<void> {
  const sql = fs.readFileSync(filePath, 'utf8');
  await pool.query('BEGIN');
  try {
    await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations(filename) VALUES($1) ON CONFLICT DO NOTHING', [filename]);
    await pool.query('COMMIT');
    // eslint-disable-next-line no-console
    console.log(`Applied: ${filename}`);
  } catch (err) {
    await pool.query('ROLLBACK');
    // eslint-disable-next-line no-console
    console.error(`Failed: ${filename}`, err);
    throw err;
  }
}

async function main() {
  const migrationsDir = path.join(__dirname, '../../db/migrations');
  await ensureMigrationsTable();
  const applied = await getApplied();
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const filename of files) {
    if (!applied.has(filename)) {
      const filePath = path.join(migrationsDir, filename);
      await applyMigration(filePath, filename);
    }
  }
  await pool.end();
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
