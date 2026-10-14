# Gochat — Backend (API + real-time server)

The server for **Gochat**, a classic, premium messenger: one-to-one chats, groups, channels with posts and comments, 24-hour Moments, and voice/video calls.

- **Node.js + Express** — REST API
- **Socket.IO** — instant messages, typing indicators, online status, read receipts, call signalling
- **PostgreSQL** (Neon free tier) — all data, including uploaded photos, videos, voice notes and files
- **WebRTC** signalling — calls go device-to-device; the server only introduces the two devices
- **Web Push** (free, VAPID) — notifications when the app is closed

No paid APIs. Everything runs on free plans.

The front end lives in a separate repo ([Frontend_chat_app](https://github.com/munjemunjegiovani-crypto/Frontend_chat_app)).

---

## 1. Run it on your laptop (Ubuntu)

```bash
# Node 18+ is required (20 recommended)
node -v

npm install
cp .env.example .env
```

Edit `.env`:

| Variable | What to put |
|---|---|
| `DATABASE_URL` | Your Neon connection string (Neon dashboard → **Connect** → copy the `postgresql://…` URL) |
| `JWT_SECRET` | A long random string. Generate one: `openssl rand -hex 32` |
| `CLIENT_URL` | `http://localhost:5173` while developing |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Run `npm run vapid` and paste the two lines it prints (needed for notifications when the app is closed) |

Then:

```bash
npm run dev
```

You should see `Gochat API listening on port 4000`. The database tables are created automatically the first time it starts.

---

## 2. Create the free database (Neon)

1. Go to <https://neon.tech> and sign in (you already have an account).
2. **New Project** → name it `gochat` → pick the region closest to your users (e.g. Europe/Frankfurt for Cameroon).
3. Open **Connect**, copy the connection string. It looks like
   `postgresql://user:password@ep-xxxx.eu-central-1.aws.neon.tech/neondb?sslmode=require`
4. That is your `DATABASE_URL`.

> Do **not** use Render's free Postgres — it is deleted after 30 days. Neon's free tier does not expire.

---

## 3. Deploy to Render (free)

Netlify can't keep the live connection that instant chat and calls need, so the backend goes on **Render**.

1. Push this folder to its own GitHub repo (`Backend_chat-app`).
2. Go to <https://render.com> → sign in with GitHub → **New → Web Service** → choose the `Backend_chat-app` repo.
3. Settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
4. **Environment variables** (Environment tab):
   - `DATABASE_URL` — from Neon
   - `JWT_SECRET` — from `openssl rand -hex 32`
   - `CLIENT_URL` — your Netlify URL, e.g. `https://gochat-chat.netlify.app` (no slash at the end). You can add more than one, separated by commas.
   - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` — from `npm run vapid` (`VAPID_SUBJECT` is `mailto:` + your email)
5. **Create Web Service**. When it's live, open `https://YOUR-SERVICE.onrender.com/health` — you should see `{"ok":true,...}`.
6. Copy the Render URL — the front end needs it as `VITE_API_URL`.

(Alternatively use **New → Blueprint**; `render.yaml` in this repo fills in most settings.)

### About the free plan
- The service **sleeps after 15 minutes with no traffic** and takes about a minute to wake up. While anyone has Gochat open, it stays awake.
- To keep it always awake, create a free monitor at <https://cron-job.org> or <https://uptimerobot.com> that opens `https://YOUR-SERVICE.onrender.com/health` every 10 minutes. One always-on service uses ~744 of the 750 free hours per month.

---

## 4. Calls on strict networks (optional)

Calls use free Google STUN servers, which work on most Wi-Fi and mobile networks. Some strict networks (certain offices, some mobile carriers) block direct connections; for those, add a TURN relay. Some providers offer a free TURN tier (search "free TURN server"). Put them in `ICE_SERVERS` as JSON:

```
ICE_SERVERS=[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:YOUR_TURN_HOST:443","username":"USER","credential":"PASS"}]
```

No front-end rebuild needed; the app reads this from `/config`.

---

## 5. Limits worth knowing

- Uploads are stored in PostgreSQL. Max size per file is `MAX_UPLOAD_MB` (default 15 MB). Neon's free tier has 0.5 GB of storage — plenty for friends, not for thousands of videos.
- Moments (and their media) are deleted automatically after 24 hours.
- Calls are one-to-one (no group calls yet).

---

## API overview

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/register`, `POST /auth/login` |
| Users | `GET/PATCH/DELETE /users/me`, `POST /users/me/password`, `GET /users/search?q=`, `GET /users/:id`, `POST/DELETE /users/:id/block` |
| Chats & groups | `GET /conversations`, `POST /conversations/direct`, `POST /conversations/group`, `GET/PATCH /conversations/:id`, `PATCH /conversations/:id/settings`, members, invite links, `GET/POST /conversations/:id/messages`, `POST /conversations/:id/read` |
| Messages | `PATCH/DELETE /messages/:id`, `POST /messages/:id/react`, `/star`, `/forward`, `GET /messages/starred` |
| Channels | `GET/POST /channels`, `GET/PATCH/DELETE /channels/:id`, follow, `GET/POST /channels/:id/posts`, `GET/DELETE /posts/:id`, `POST /posts/:id/react`, `POST /posts/:id/comments` |
| Activity | `GET /notifications`, `POST /notifications/read` |
| Moments | `GET/POST /moments`, `POST /moments/:id/view`, `GET /moments/:id/viewers`, `DELETE /moments/:id` |
| Calls | `GET /calls` (history); signalling over Socket.IO |
| Files | `POST /files` (multipart), `GET /files/:id` |
| Push | `GET /push/key`, `POST /push/subscribe`, `POST /push/unsubscribe` |

Socket.IO events: `message:new`, `message:updated`, `receipts`, `typing`, `presence`, `conversation:updated`, `channel:post`, `post:comment`, `notification`, `moments:changed`, `call:*`.
