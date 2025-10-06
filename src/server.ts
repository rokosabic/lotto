import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { auth, requiresAuth } from 'express-openid-connect';
import { auth as jwtAuth, requiredScopes } from 'express-oauth2-jwt-bearer';
import { pool } from './db/client';
import QRCode from 'qrcode';

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true }));
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

// Optional Auth0 M2M JWT protection for admin endpoints
const audience = process.env.AUTH0_AUDIENCE;
const issuer = process.env.AUTH0_DOMAIN ? `https://${process.env.AUTH0_DOMAIN}` : undefined;
let apiJwt: ReturnType<typeof jwtAuth> | null = null;
if (audience && issuer) {
  apiJwt = jwtAuth({ audience, issuerBaseURL: issuer });
}

app.get('/', async (req, res) => {
  // Use latest round as current (active or closed)
  const currentRound = await pool.query('SELECT id, is_active, drawn_numbers FROM rounds ORDER BY id DESC LIMIT 1');
  let ticketsCount: number | null = null;
  let drawnNumbers: number[] | null = null;
  let isPaymentsActive = false;
  let myTickets: Array<{ id: string; numbers: number[] }> = [];
  if (currentRound.rows.length > 0) {
    const r = currentRound.rows[0];
    isPaymentsActive = !!r.is_active;
    if (!r.is_active && r.drawn_numbers && r.drawn_numbers.length > 0) {
      drawnNumbers = r.drawn_numbers;
    } else {
      drawnNumbers = null;
    }
    const c = await pool.query('SELECT COUNT(*)::int AS c FROM tickets WHERE round_id = $1', [r.id]);
    ticketsCount = c.rows[0].c as number;

    // If user logged in, fetch their tickets in this round
    const sub = (req as any).oidc?.user?.sub as string | undefined;
    if (sub) {
      const mine = await pool.query('SELECT id, numbers FROM tickets WHERE round_id = $1 AND user_sub = $2 ORDER BY created_at DESC LIMIT 20', [r.id, sub]);
      myTickets = mine.rows.map((row: any) => ({ id: row.id as string, numbers: row.numbers as number[] }));
    }
  }

  res.render('index', {
    user: (res as any).req.oidc?.user || null,
    ticketsInCurrentRound: ticketsCount,
    drawnNumbers,
    isPaymentsActive,
    isAuthenticated: (res as any).req.oidc?.isAuthenticated() ?? false,
    myTickets,
  });
});

// Protected profile route shows the OIDC user profile
app.get('/profile', requiresAuth(), (req, res) => {
  res.json((req as any).oidc.user);
});

// Ticket purchase form
app.get('/tickets/new', requiresAuth(), async (req, res) => {
  const active = await pool.query('SELECT id FROM rounds WHERE is_active = true LIMIT 1');
  if (active.rows.length === 0) {
    return res.status(400).send('Uplate trenutno nisu aktivne.');
  }
  res.render('tickets_new', { message: null, error: null });
});

// Create ticket: supports form-urlencoded and JSON
app.post('/tickets', requiresAuth(), async (req, res) => {
  const nationalId = (req.body.nationalId as string | undefined)?.trim();
  const numbersField = (req.body.numbers as string | undefined)?.trim();

  if (!nationalId || nationalId.length === 0 || nationalId.length > 20) {
    if (req.headers['content-type']?.includes('application/json')) {
      return res.status(400).json({ error: 'Invalid nationalId' });
    }
    return res.status(400).render('tickets_new', { message: null, error: 'Invalid nationalId' });
  }
  if (!numbersField) {
    if (req.headers['content-type']?.includes('application/json')) {
      return res.status(400).json({ error: 'numbers required' });
    }
    return res.status(400).render('tickets_new', { message: null, error: 'numbers required' });
  }
  const parsed = numbersField.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n));
  const uniq = Array.from(new Set(parsed));
  const inRange = uniq.every((n) => n >= 1 && n <= 45);
  if (uniq.length < 6 || uniq.length > 10 || uniq.length !== parsed.length || !inRange) {
    if (req.headers['content-type']?.includes('application/json')) {
      return res.status(400).json({ error: 'Invalid numbers' });
    }
    return res.status(400).render('tickets_new', { message: null, error: 'Invalid numbers' });
  }

  const roundRes = await pool.query('SELECT id FROM rounds WHERE is_active = true ORDER BY id DESC LIMIT 1');
  if (roundRes.rows.length === 0) {
    if (req.headers['content-type']?.includes('application/json')) {
      return res.status(400).json({ error: 'No active round' });
    }
    return res.status(400).render('tickets_new', { message: null, error: 'No active round' });
  }
  const roundId = roundRes.rows[0].id as number;
  const userSub = (req as any).oidc?.user?.sub as string | undefined || null;

  const insert = await pool.query(
    'INSERT INTO tickets(round_id, national_id, numbers, user_sub) VALUES($1, $2, $3, $4) RETURNING id',
    [roundId, nationalId, uniq, userSub]
  );
  const ticketId: string = insert.rows[0].id;

  const ticketUrl = `${baseURL}/ticket/${ticketId}`;

  if (req.headers['content-type']?.includes('application/json')) {
    res.setHeader('Content-Type', 'image/png');
    return res.send(await QRCode.toBuffer(ticketUrl));
  }

  return res.status(200).send(`<!doctype html>
<html><body style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;">
  <div style="max-width:720px;margin:24px auto;">
    <h2 style="margin-top:0;">Ticket created</h2>
    <p><a href="/ticket/${ticketId}">Open ticket</a></p>
    <p class="muted">QR URL: ${ticketUrl}</p>
    <img alt="QR" src="data:image/png;base64,${(await QRCode.toBuffer(ticketUrl)).toString('base64')}" />
    <p style="margin-top:16px;"><a href="/">Back to home</a></p>
  </div>
</body></html>`);
});

// Public ticket page
app.get('/ticket/:id', async (req, res) => {
  const { id } = req.params;
  const t = await pool.query('SELECT t.id, t.national_id, t.numbers, r.drawn_numbers FROM tickets t JOIN rounds r ON r.id = t.round_id WHERE t.id = $1', [id]);
  if (t.rows.length === 0) return res.status(404).send('Not found');
  const row = t.rows[0];
  res.render('ticket', {
    ticket: {
      id: row.id,
      nationalId: row.national_id,
      numbers: row.numbers,
      drawnNumbers: row.drawn_numbers || null,
    }
  });
});

// Admin endpoints (M2M JWT required) only if configured
if (apiJwt) {
  app.post('/new-round', apiJwt, requiredScopes('rounds'), async (_req, res) => {
    const active = await pool.query('SELECT id FROM rounds WHERE is_active = true LIMIT 1');
    if (active.rows.length === 0) {
      await pool.query('INSERT INTO rounds(is_active) VALUES(true)');
    }
    return res.sendStatus(204);
  });

  app.post('/close', apiJwt, requiredScopes('rounds'), async (_req, res) => {
    const active = await pool.query('SELECT id FROM rounds WHERE is_active = true LIMIT 1');
    if (active.rows.length > 0) {
      await pool.query('UPDATE rounds SET is_active = false, closed_at = NOW() WHERE id = $1', [active.rows[0].id]);
    }
    return res.sendStatus(204);
  });

  app.post('/store-results', apiJwt, requiredScopes('results'), async (req, res) => {
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
}

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
