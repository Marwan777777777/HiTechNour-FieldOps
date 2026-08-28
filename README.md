# HiTechNour Field Ops

Workforce attendance and operations for [HiTechNour Technologies](https://hitechnour.net/). Geofenced check-in, device binding, admin desk, EN/AR.

## Stack

TanStack Start · Postgres (Neon in production, PGLite in local preview) · Better Auth

## Run locally

```bash
npm install
npm run dev
```

Set `DATABASE_URL` to a Postgres/Neon URL for a real database. Without it, the app uses an in-memory store that resets on restart.

First account created is admin. Later accounts wait in **Queue** until you approve them. Admins can also add people from **People**.

## Deploy

Vercel (frontend + server functions) + Neon. Auth: username/password (maps to `@hitechnour.local` if you type a short username).
