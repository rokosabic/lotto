import dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config();

const sslEnabledEnv = process.env.DB_SSL?.toLowerCase() ?? 'true';
const sslEnabled = sslEnabledEnv === 'true' || sslEnabledEnv === '1' || sslEnabledEnv === 'yes';

export const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
  ssl: sslEnabled,
});

export async function getComments(): Promise<string[]> {
  const comments: string[] = [];
  const results = await pool.query('SELECT id, comment FROM comments');
  results.rows.forEach((row) => {
    comments.push(row['comment']);
  });
  return comments;
}
