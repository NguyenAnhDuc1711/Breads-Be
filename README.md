# DATN-Be

Backend API server for **Breads**, a social networking application — REST API and real-time (Socket.IO) backend covering posts, messaging, notifications, collections, categories, and analytics.

## Features

- User accounts & JWT authentication
- Posts, collections (with daily auto-generated collections), and interest-based categories (personalized via scheduled jobs)
- Real-time messaging and notifications via Socket.IO
- Content reporting / moderation
- Analytics tracking (separate analytics database)
- Media uploads via Cloudinary
- Scheduled jobs (node-cron) for collection generation and category assignment

## Tech Stack

- **Runtime:** Node.js (ESM), TypeScript 5.7 (mixed with JavaScript)
- **Framework:** Express 4
- **Database:** MongoDB (Mongoose) — primary + separate analytics database
- **Cache:** Redis (ioredis)
- **Real-time:** Socket.IO
- **Auth:** JWT (jsonwebtoken) + bcryptjs
- **Media:** Cloudinary, Multer
- **Email:** Nodemailer
- **Scheduling:** node-cron

## Getting Started

1. Install dependencies:
   ```bash
   npm install
   ```
2. Configure environment variables in `.env` (see required keys below).
3. Run in development mode:
   ```bash
   npm run dev
   ```
   The server starts on `PORT` (default `8080`).

### Required Environment Variables

- `MONGO_URI` — primary MongoDB connection string (also stores analytics events, `events` collection)
- `UNSPLASH_API_KEY` — Unsplash API key (seed/demo content)
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` — Cloudinary credentials
- `SEND_MAIL_PASS` — email sending credential
- `PYTHON_SERVER` — URL of companion Python service

## Project Structure

```
src/
  app.ts              # Express app setup (middleware, routes, error handling)
  server.ts           # Process entry point (HTTP server + Socket.IO init)
  api/
    controllers/       # Request handlers
    routers/            # Express route definitions
    services/            # Business logic
    models/               # Mongoose schemas
    middlewares/           # Auth guard, upload handling
    utils/                  # API-layer helpers
  socket/               # Socket.IO real-time layer (controllers, listeners, services)
  core/                 # Shared response helpers
  dbs/                   # MongoDB / Redis connection setup
  cronjob/                # Scheduled job definitions
  Breads-Shared/           # Git submodule — shared constants/utilities
```

This repo uses a git submodule (`src/Breads-Shared`). After cloning, run:

```bash
git submodule update --init --recursive
```

## Note

No automated test suite is currently configured for this project.
