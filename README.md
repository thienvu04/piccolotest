# Piccolo

**Turn what happy guests tell you into Google reviews they're glad to post.**
ISDS 4125 · Fall 2026 · Milestone 3 prototype — Syphany Guo, Dane Loup, Thien Vu, Blake Bock

Piccolo runs entirely on Cloudflare:

| Piece | Cloudflare product | Code |
|---|---|---|
| Manager web app + guest review page | Workers static assets | `public/` |
| API (Account, Guest Feedback, Review Generation, Guest Response services) | Worker | `src/worker.js` |
| Piccolo database (8 tables from the M2 schema) | D1 (SQLite) | `migrations/0001_init.sql` |
| AI text generation | Workers AI (`@cf/meta/llama-3.1-8b-instruct`) | `writeReview()` in `src/worker.js` |
| Email / SMS delivery | **Simulated** for the prototype — the app shows the secure link + a QR code | `sendInvitation()` |

Demo login (created by the migration): **demo@piccolo.app / piccolo123**

---

## Deploy to Cloudflare (about 10 minutes, one teammate does this once)

You need Node.js 20+ and a free Cloudflare account.

```bash
npm install
npx wrangler login                       # opens a browser to authorize

npx wrangler d1 create piccolo-db        # prints a database_id
```

1. Paste the printed `database_id` into `wrangler.jsonc` (replace `REPLACE_WITH_YOUR_D1_DATABASE_ID`).
2. Set the secret used to sign login sessions (paste any long random string when asked):
   ```bash
   npx wrangler secret put SESSION_SECRET
   ```
3. Create the tables and seed the demo account, then deploy:
   ```bash
   npm run db:migrate:remote
   npm run deploy
   ```
Wrangler prints your URL, e.g. `https://piccolo.<your-subdomain>.workers.dev`. Open it on a phone, tablet, and laptop.

### Auto-deploy from GitHub (recommended for the team workflow)
In the Cloudflare dashboard → **Workers & Pages → piccolo → Settings → Builds → Connect** your team's GitHub repo.
Build command: *(leave empty)* · Deploy command: `npx wrangler deploy`. Every push to `main` now redeploys.

## Run locally

```bash
npm install
cp .dev.vars.example .dev.vars   # local session secret
npm run db:migrate:local
npm run dev                # http://localhost:8787
```
Locally, Workers AI calls go to Cloudflare (you must be logged in with `wrangler login`). If the AI service is
unreachable, Piccolo automatically falls back to a template draft and tells the manager — the demo never stalls.

---

## Demo-day script (3 minutes, hands-on)

1. **Sign in** on a phone with the demo account → *Settings → Load sample data* (shows every status, plus the 7-day **On hold** and 14-day **Archived** rules).
2. **Capture Guest Comments** — *New feedback*: name, email, table, check what they praised, type their words, tick consent → **Save and generate draft**.
3. **Prepare/Send Draft** — read the AI draft, tweak a word, **Approve**, **Preview invitation**, **Send**. Confirmation + link + QR appear.
4. **Guest Review Response** — hand a visitor your phone or let them **scan the QR**: they edit the review, tap **Copy review & open Google** (or **No thanks**).
5. **Track Review Requests** — back on *Requests*: status chip is now **Completed**, history timeline shows every step, search & filter work.

Good "try to break it" moments: submit an empty form, untick consent (draft button disables), try to send by text to a guest with no phone, open a made-up link like `/r/xxxxxxxxxxxxxxxxxxxx`.

---

## How the prototype maps to the backlog (M2 PBI list)

| PBI | Done in prototype |
|---|---|
| 1 Database & migrations | `migrations/0001_init.sql` — all 8 tables, keys and checks from the data dictionary |
| 2 Cloudflare hosting & deploy | `wrangler.jsonc`, `npm run deploy`, GitHub builds |
| 3 Manager sign-in | PBKDF2-hashed passwords, signed HttpOnly session cookie, create-account flow |
| 4–7 Capture guest comments | Guest details (email **or** phone), notes, praised aspects, follow-up consent |
| 8–10 AI draft, edit | Workers AI draft from notes only; editable, rewrite, approve |
| 11–12, 19, 22 Send invitation | Email/Text choice, preview, confirmation, secure link + QR (delivery simulated) |
| 13–16 Guest response | No-account link, edit, copy + open Google review page, decline |
| 17–18 Status & history | Draft / Approved / Sent / Completed (+ Declined) chips; timestamped timeline |
| 20 Finish after the rush | **Save draft** keeps a form open; an unsaved new form is restored on the same device |
| 21 Hold / Archive | Applied automatically: Hold after 7 days, Archived after 14, when no invitation went out |
| 23 Errors & retries | Field-level validation (client + server), friendly messages, AI fallback, no-contact warnings |
| 24 Responsive & accessible | Phone (bottom tab bar), tablet, desktop layouts; labels, focus rings, keyboard use, contrast |
| 25 Search & filter | Search by guest / phone / form # / table; filter by status, On hold, Archived |

**Out of scope for the prototype (talking points):** real email/SMS provider (would plug into `sendInvitation`), posting to Google on the guest's behalf (Google doesn't allow it — the guest always posts), multi-location chains, reminders, analytics exports.

## API reference

| Method & path | Purpose |
|---|---|
| `POST /api/login`, `/api/register`, `/api/logout`, `GET /api/me` | Account service |
| `PUT /api/restaurant` | Restaurant name + Google review link |
| `GET /api/aspects` | Praise checklist |
| `GET/POST /api/forms`, `GET/PUT/DELETE /api/forms/:formNumber` | Guest feedback forms |
| `POST /api/forms/:n/draft` (generate) · `PUT /api/forms/:n/draft` (edit/approve) | Review drafts |
| `POST /api/forms/:n/send` | Create the invitation + secure link |
| `GET /api/invite/:token`, `POST /api/invite/:token/respond` | Guest page (no login) |
| `POST /api/demo/seed` | Sample data for demo day |
