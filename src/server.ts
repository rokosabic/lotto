import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { auth, requiresAuth } from 'express-openid-connect';
import { auth as jwtAuth, requiredScopes } from 'express-oauth2-jwt-bearer';
import { pool } from './db/client';
import QRCode from 'qrcode';

dotenv.config();

const app = express();
app.use(express.json());

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const externalUrl = process.env.RENDER_EXTERNAL_URL;
const port = externalUrl && process.env.PORT ? parseInt(process.env.PORT, 10) : 4080;
const baseURL = externalUrl || `http://localhost:${port}`;

// Auth0 browser session (OIDC) for users
const authConfig = {
  authRequired: false,
  auth0Logout: true,
  secret: process.env.AUTH0_SECRET,
  baseURL,
  clientID: process.env.AUTH0_CLIENT_ID,
  issuerBaseURL: process.env.AUTH0_DOMAIN ? `https://${process.env.AUTH0_DOMAIN}` : undefined,
};
app.use(auth(authConfig));

// Auth0 M2M JWT protection for admin endpoints
const apiJwt = jwtAuth({
  audience: process.env.AUTH0_AUDIENCE,
  issuerBaseURL: process.env.AUTH0_DOMAIN ? `https://${process.env.AUTH0_DOMAIN}` : undefined,
});

app.get('/', async (_req, res) => {
  // Show counts and current round data
  const currentRound = await pool.query('SELECT id, is_active, drawn_numbers FROM rounds WHERE is_active = true ORDER BY id DESC LIMIT 1');
  let ticketsCount: number | null = null;
  let drawnNumbers: number[] | null = null;
  let isPaymentsActive = false;
  if (currentRound.rows.length > 0) {
    const r = currentRound.rows[0];
    isPaymentsActive = !!r.is_active;
    drawnNumbers = r.drawn_numbers || null;
    const c = await pool.query('SELECT COUNT(*)::int AS c FROM tickets WHERE round_id = $1', [r.id]);
    ticketsCount = c.rows[0].c as number;
  }

  res.render('index', {
    user: (res as any).req.oidc?.user || null,
    ticketsInCurrentRound: ticketsCount,
    drawnNumbers,
    isPaymentsActive,
    isAuthenticated: (res as any).req.oidc?.isAuthenticated() ?? false,
  });
});

// Create ticket: accepts JSON { nationalId: string, numbers: string }
// numbers: comma-separated "1,2,3,4,5,6" (6-10 unique in 1..45)
app.post('/tickets', requiresAuth(), async (req, res) => {
  const { nationalId, numbers } = req.body as { nationalId?: string; numbers?: string };
  if (!nationalId || nationalId.length === 0 || nationalId.length > 20) {
    return res.status(400).json({ error: 'Invalid nationalId' });
  }
  if (!numbers) {
    return res.status(400).json({ error: 'numbers required' });
  }
  const parsed = numbers.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n));
  const uniq = Array.from(new Set(parsed));
  const inRange = uniq.every((n) => n >= 1 && n <= 45);
  if (uniq.length < 6 || uniq.length > 10 || uniq.length !== parsed.length || !inRange) {
    return res.status(400).json({ error: 'Invalid numbers' });
  }

  const roundRes = await pool.query('SELECT id FROM rounds WHERE is_active = true ORDER BY id DESC LIMIT 1');
  if (roundRes.rows.length === 0) {
    return res.status(400).json({ error: 'No active round' });
  }
  const roundId = roundRes.rows[0].id as number;

  const insert = await pool.query(
    'INSERT INTO tickets(round_id, national_id, numbers) VALUES($1, $2, $3) RETURNING id',
    [roundId, nationalId, uniq]
  );
  const ticketId: string = insert.rows[0].id;

  const ticketUrl = `${baseURL}/ticket/${ticketId}`;
  res.setHeader('Content-Type', 'image/png');
  res.send(await QRCode.toBuffer(ticketUrl));
});

// Public ticket page
app.get('/ticket/:id', async (req, res) => {
  const { id } = req.params;
  const t = await pool.query('SELECT t.id, t.national_id, t.numbers, r.drawn_numbers FROM tickets t JOIN rounds r ON r.id = t.round_id WHERE t.id = $1', [id]);
  if (t.rows.length === 0) return res.status(404).send('Not found');
  const row = t.rows[0];
  res.json({ id: row.id, nationalId: row.national_id, numbers: row.numbers, drawnNumbers: row.drawn_numbers });
});

// Admin endpoints (M2M JWT required)
app.post('/new-round', apiJwt, requiredScopes('rounds:write'), async (_req, res) => {
  const active = await pool.query('SELECT id FROM rounds WHERE is_active = true LIMIT 1');
  if (active.rows.length === 0) {
    await pool.query('INSERT INTO rounds(is_active) VALUES(true)');
  }
  return res.sendStatus(204);
});

app.post('/close', apiJwt, requiredScopes('rounds:write'), async (_req, res) => {
  const active = await pool.query('SELECT id FROM rounds WHERE is_active = true LIMIT 1');
  if (active.rows.length > 0) {
    await pool.query('UPDATE rounds SET is_active = false, closed_at = NOW() WHERE id = $1', [active.rows[0].id]);
  }
  return res.sendStatus(204);
});

app.post('/store-results', apiJwt, requiredScopes('results:write'), async (req, res) => {
  const { numbers } = req.body as { numbers?: number[] };
  if (!Array.isArray(numbers)) return res.status(400).json({ error: 'numbers must be an array' });
  const round = await pool.query('SELECT id, is_active, drawn_numbers FROM rounds ORDER BY id DESC LIMIT 1');
  if (round.rows.length === 0) return res.status(400).json({ error: 'no round' });
  const r = round.rows[0];
  if (r.is_active) return res.status(400).json({ error: 'round is active' });
  if (r.drawn_numbers && r.drawn_numbers.length > 0) return res.status(400).json({ error: 'already drawn' });
  await pool.query('UPDATE rounds SET drawn_numbers = $1 WHERE id = $2', [numbers, r.id]);
  return res.sendStatus(204);
});

if (externalUrl) {
  const hostname = '0.0.0.0';
  app.listen(port, hostname, () => {
    // eslint-disable-next-line no-console
    console.log(`Server locally running at http://${hostname}:${port}/ and from outside on ${externalUrl}`);
  });
} else {
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Server running at http://localhost:${port}/`);
  });
}
