# lotto

Minimal Express + TypeScript scaffold prepared for Render.

## Local setup

1. Copy `.env.example` to `.env` and set DB credentials.
2. Install deps: `npm install`.
3. Build: `npm run build`.
4. Start: `npm start`.

## Render deployment

- Build Command: `npm install && npm run build`
- Start Command: `npm start`
- Environment: set DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, DB_SSL (true)
- PORT and RENDER_EXTERNAL_URL are provided by Render.

Server binds to `0.0.0.0:$PORT` when `RENDER_EXTERNAL_URL` is present.
