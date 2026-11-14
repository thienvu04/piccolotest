// Piccolo — Cloudflare Worker API
// Services (see architecture diagram): Account, Guest Feedback, Review Generation, Guest Response.

const SESSION_COOKIE = "piccolo_session";
const SESSION_DAYS = 7;
// Tried in order; a retired or unavailable model is skipped and the next one is used.
// To force a specific model without editing code, set AI_MODEL (e.g. `npx wrangler secret put AI_MODEL`).
// Current models: https://developers.cloudflare.com/workers-ai/models/
const AI_MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
  "@cf/google/gemma-3-12b-it",
];
const HOLD_DAYS = 7;
const ARCHIVE_DAYS = 14;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      // Guest invitation link -> serve the guest review page
      if (url.pathname.startsWith("/r/")) {
        return env.ASSETS.fetch(new Request(new URL("/review", url), request));
      }
      if (url.pathname.startsWith("/api/")) {
        return await route(request, env, url);
      }
      return env.ASSETS.fetch(request);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, field: err.field }, err.status);
      console.error(err);
      return json({ error: "Something went wrong on our side. Please try again." }, 500);
    }
  },
};

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

async function route(req, env, url) {
  const p = url.pathname;
  const m = req.method;
  let mt;

  // Account Service
  if (p === "/api/login" && m === "POST") return login(req, env);
  if (p === "/api/register" && m === "POST") return register(req, env);
  if (p === "/api/logout" && m === "POST") return logout(req);
  if (p === "/api/me" && m === "GET") return me(req, env);
  if (p === "/api/restaurant" && m === "PUT") return updateRestaurant(req, env);

  // Guest Response Service (public, token based — no login)
  if ((mt = p.match(/^\/api\/invite\/([A-Za-z0-9_-]{16,64})$/)) && m === "GET") return getInvite(env, mt[1]);
  if ((mt = p.match(/^\/api\/invite\/([A-Za-z0-9_-]{16,64})\/respond$/)) && m === "POST") return respondInvite(req, env, mt[1]);

  // Everything below requires a signed-in manager
  const session = await requireSession(req, env);

  if (p === "/api/aspects" && m === "GET") return listAspects(env);
  if (p === "/api/forms" && m === "GET") return listForms(env, session, url);
  if (p === "/api/forms" && m === "POST") return createForm(req, env, session);
  if (p === "/api/demo/seed" && m === "POST") return seedDemo(env, session);

  if ((mt = p.match(/^\/api\/forms\/(P\d{4}-\d{3,})$/))) {
    if (m === "GET") return getForm(env, session, mt[1]);
    if (m === "PUT") return updateForm(req, env, session, mt[1]);
    if (m === "DELETE") return deleteForm(env, session, mt[1]);
  }
  if ((mt = p.match(/^\/api\/forms\/(P\d{4}-\d{3,})\/draft$/))) {
    if (m === "POST") return generateDraftRoute(env, session, mt[1]);
    if (m === "PUT") return saveDraft(req, env, session, mt[1]);
  }
  if ((mt = p.match(/^\/api\/forms\/(P\d{4}-\d{3,})\/send$/)) && m === "POST") return sendInvitation(req, env, session, mt[1], url);

  throw new HttpError(404, "Not found");
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(status, message, field) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

async function body(req) {
  try {
    const b = await req.json();
    if (!b || typeof b !== "object") throw 0;
    return b;
  } catch {
    throw new HttpError(400, "The request could not be read. Please try again.");
  }
}

const nowIso = () => new Date().toISOString();
const daysAgoIso = (d) => new Date(Date.now() - d * 86400000).toISOString();
const clean = (v) => (typeof v === "string" ? v.trim() : "");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomToken(n = 24) {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}

/* ------------------------------------------------------------------ */
/* Account Service: passwords + sessions                               */
/* ------------------------------------------------------------------ */

async function hashPassword(password, saltB64, iterations = 100000) {
  const salt = saltB64 ? Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  const toB64 = (u) => btoa(String.fromCharCode(...new Uint8Array(u)));
  return `pbkdf2$${iterations}$${toB64(salt)}$${toB64(bits)}`;
}

async function verifyPassword(password, stored) {
  const [alg, iter, salt, hash] = String(stored).split("$");
  if (alg !== "pbkdf2") return false;
  const check = await hashPassword(password, salt, Number(iter));
  const a = check.split("$")[3];
  if (a.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

async function hmac(env, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SESSION_SECRET || "dev-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

async function makeSessionCookie(env, req, managerId, restaurantId) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ mid: managerId, rid: restaurantId, exp: Date.now() + SESSION_DAYS * 86400000 })));
  const sig = await hmac(env, payload);
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${payload}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

async function readSession(req, env) {
  const cookie = req.headers.get("cookie") || "";
  const m = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (!m) return null;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig || (await hmac(env, payload)) !== sig) return null;
  try {
    const data = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    if (data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

async function requireSession(req, env) {
  const s = await readSession(req, env);
  if (!s) throw new HttpError(401, "Please sign in to continue.");
  return s;
}

async function login(req, env) {
  const b = await body(req);
  const email = clean(b.email).toLowerCase();
  const password = typeof b.password === "string" ? b.password : "";
  if (!email || !password) throw new HttpError(400, "Enter your email and password.");
  const mgr = await env.DB.prepare("SELECT * FROM Manager WHERE email = ?").bind(email).first();
  if (!mgr || !(await verifyPassword(password, mgr.password_hash))) {
    throw new HttpError(401, "That email and password don't match our records.");
  }
  const cookie = await makeSessionCookie(env, req, mgr.manager_id, mgr.restaurant_id);
  return json({ ok: true }, 200, { "set-cookie": cookie });
}

async function register(req, env) {
  const b = await body(req);
  const restaurant = clean(b.restaurant_name);
  const name = clean(b.manager_name);
  const email = clean(b.email).toLowerCase();
  const password = typeof b.password === "string" ? b.password : "";
  const link = clean(b.google_review_link);
  if (!restaurant || restaurant.length > 100) throw new HttpError(400, "Enter your restaurant's name (up to 100 characters).", "restaurant_name");
  if (!name || name.length > 100) throw new HttpError(400, "Enter your name (up to 100 characters).", "manager_name");
  if (!EMAIL_RE.test(email) || email.length > 100) throw new HttpError(400, "Enter a valid email address.", "email");
  if (password.length < 8) throw new HttpError(400, "Use a password with at least 8 characters.", "password");
  if (link && !/^https:\/\/\S+$/.test(link)) throw new HttpError(400, "The Google review link should start with https://", "google_review_link");
  const exists = await env.DB.prepare("SELECT 1 FROM Manager WHERE email = ?").bind(email).first();
  if (exists) throw new HttpError(409, "An account with this email already exists. Try signing in.", "email");

  const r = await env.DB.prepare("INSERT INTO Restaurant (restaurant_name, google_review_link) VALUES (?, ?)").bind(restaurant, link || null).run();
  const rid = r.meta.last_row_id;
  const hash = await hashPassword(password);
  const mres = await env.DB.prepare("INSERT INTO Manager (restaurant_id, manager_name, email, password_hash) VALUES (?, ?, ?, ?)")
    .bind(rid, name, email, hash)
    .run();
  const cookie = await makeSessionCookie(env, req, mres.meta.last_row_id, rid);
  return json({ ok: true }, 201, { "set-cookie": cookie });
}

function logout() {
  return json({ ok: true }, 200, { "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
}

async function me(req, env) {
  const s = await readSession(req, env);
  if (!s) return json({ signedIn: false });
  const row = await env.DB.prepare(
    `SELECT m.manager_id, m.manager_name, m.email, r.restaurant_id, r.restaurant_name, r.google_review_link
     FROM Manager m JOIN Restaurant r ON r.restaurant_id = m.restaurant_id WHERE m.manager_id = ?`
  )
    .bind(s.mid)
    .first();
  if (!row) return json({ signedIn: false });
  return json({ signedIn: true, ...row });
}

async function updateRestaurant(req, env) {
  const s = await requireSession(req, env);
  const b = await body(req);
  const name = clean(b.restaurant_name);
  const link = clean(b.google_review_link);
  if (!name || name.length > 100) throw new HttpError(400, "Enter your restaurant's name (up to 100 characters).", "restaurant_name");
  if (link && (!/^https:\/\/\S+$/.test(link) || link.length > 255)) throw new HttpError(400, "The Google review link should start with https://", "google_review_link");
  await env.DB.prepare("UPDATE Restaurant SET restaurant_name = ?, google_review_link = ? WHERE restaurant_id = ?").bind(name, link || null, s.rid).run();
  return json({ ok: true });
}

/* ------------------------------------------------------------------ */
/* Guest Feedback Service                                              */
/* ------------------------------------------------------------------ */

async function listAspects(env) {
  const { results } = await env.DB.prepare("SELECT aspect_id, aspect_name FROM BasicAspect ORDER BY aspect_id").all();
  return json(results);
}

async function validateFormInput(env, b) {
  const g = b.guest || {};
  const full_name = clean(g.full_name);
  const email = clean(g.email).toLowerCase();
  const phone = clean(g.phone);
  const table_number = clean(b.table_number);
  const notes = clean(b.detailed_notes);
  const consent = b.follow_up_consent === "Y" || b.follow_up_consent === true ? "Y" : "N";

  if (!full_name) throw new HttpError(400, "Enter the guest's name.", "full_name");
  if (full_name.length > 100) throw new HttpError(400, "The guest's name is too long (100 characters max).", "full_name");
  if (!email && !phone) throw new HttpError(400, "Add the guest's email or phone so we can send the invitation.", "email");
  if (email && (!EMAIL_RE.test(email) || email.length > 100)) throw new HttpError(400, "That email address doesn't look right.", "email");
  const digits = phone.replace(/\D/g, "");
  if (phone && (digits.length < 7 || digits.length > 15 || !/^[\d\s()+.-]+$/.test(phone))) {
    throw new HttpError(400, "That phone number doesn't look right.", "phone");
  }
  if (table_number.length > 10) throw new HttpError(400, "Table number is too long (10 characters max).", "table_number");
  if (notes.length > 2000) throw new HttpError(400, "Notes are too long (2,000 characters max).", "detailed_notes");

  let aspects = Array.isArray(b.aspects) ? [...new Set(b.aspects.map(Number).filter(Number.isInteger))] : [];
  if (aspects.length) {
    const { results } = await env.DB.prepare(`SELECT aspect_id FROM BasicAspect WHERE aspect_id IN (${aspects.map(() => "?").join(",")})`)
      .bind(...aspects)
      .all();
    aspects = results.map((r) => r.aspect_id);
  }
  return { full_name, email: email || null, phone: phone || null, table_number: table_number || null, notes: notes || null, consent, aspects };
}

async function nextFormNumber(env, d = new Date()) {
  const prefix = `P${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}-`;
  const row = await env.DB.prepare("SELECT form_number FROM InteractionForm WHERE form_number LIKE ? ORDER BY form_number DESC LIMIT 1")
    .bind(prefix + "%")
    .first();
  const seq = row ? parseInt(row.form_number.split("-")[1], 10) + 1 : 1;
  return prefix + String(seq).padStart(3, "0");
}

async function createForm(req, env, s) {
  const b = await body(req);
  const v = await validateFormInput(env, b);
  const g = await env.DB.prepare("INSERT INTO Guest (full_name, email, phone) VALUES (?, ?, ?)").bind(v.full_name, v.email, v.phone).run();
  const guestId = g.meta.last_row_id;

  // Retry on the rare collision of two forms created at the same moment
  let formNumber;
  for (let attempt = 0; attempt < 3; attempt++) {
    formNumber = await nextFormNumber(env);
    try {
      await env.DB.prepare(
        `INSERT INTO InteractionForm (form_number, manager_id, guest_id, table_number, follow_up_consent, detailed_notes, created_at, activity_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'Open')`
      )
        .bind(formNumber, s.mid, guestId, v.table_number, v.consent, v.notes, nowIso())
        .run();
      break;
    } catch (e) {
      if (attempt === 2) throw e;
    }
  }
  await saveAspects(env, formNumber, v.aspects);

  let draft = null;
  if (b.generate) draft = await createOrRegenerateDraft(env, s, formNumber);
  return json({ form_number: formNumber, draft }, 201);
}

async function saveAspects(env, formNumber, aspects) {
  const stmts = [env.DB.prepare("DELETE FROM FormAspect WHERE form_number = ?").bind(formNumber)];
  for (const a of aspects) stmts.push(env.DB.prepare("INSERT INTO FormAspect (form_number, aspect_id) VALUES (?, ?)").bind(formNumber, a));
  await env.DB.batch(stmts);
}

async function loadOwnedForm(env, s, formNumber) {
  const f = await env.DB.prepare(
    `SELECT f.*, g.full_name, g.email, g.phone
     FROM InteractionForm f JOIN Guest g ON g.guest_id = f.guest_id
     JOIN Manager m ON m.manager_id = f.manager_id
     WHERE f.form_number = ? AND m.restaurant_id = ?`
  )
    .bind(formNumber, s.rid)
    .first();
  if (!f) throw new HttpError(404, "We couldn't find that guest form.");
  return f;
}

async function loadDraft(env, formNumber) {
  return env.DB.prepare("SELECT * FROM ReviewDraft WHERE form_number = ? AND draft_status != 'Deleted'").bind(formNumber).first();
}
async function loadInvitation(env, draftId) {
  if (!draftId) return null;
  return env.DB.prepare("SELECT * FROM ReviewInvitation WHERE draft_id = ? ORDER BY invitation_id DESC LIMIT 1").bind(draftId).first();
}

async function updateForm(req, env, s, formNumber) {
  const f = await loadOwnedForm(env, s, formNumber);
  const draft = await loadDraft(env, formNumber);
  const inv = await loadInvitation(env, draft?.draft_id);
  if (inv) throw new HttpError(409, "This guest has already been invited, so the form can no longer be changed.");
  const b = await body(req);
  const v = await validateFormInput(env, b);
  await env.DB.batch([
    env.DB.prepare("UPDATE Guest SET full_name = ?, email = ?, phone = ? WHERE guest_id = ?").bind(v.full_name, v.email, v.phone, f.guest_id),
    env.DB.prepare(
      "UPDATE InteractionForm SET table_number = ?, follow_up_consent = ?, detailed_notes = ?, activity_status = 'Open' WHERE form_number = ?"
    ).bind(v.table_number, v.consent, v.notes, formNumber),
  ]);
  await saveAspects(env, formNumber, v.aspects);
  let newDraft = null;
  if (b.generate) newDraft = await createOrRegenerateDraft(env, s, formNumber);
  return json({ ok: true, form_number: formNumber, draft: newDraft });
}

async function deleteForm(env, s, formNumber) {
  await loadOwnedForm(env, s, formNumber);
  const draft = await loadDraft(env, formNumber);
  const inv = await loadInvitation(env, draft?.draft_id);
  if (inv) throw new HttpError(409, "This guest has already been invited, so the form can't be deleted.");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM FormAspect WHERE form_number = ?").bind(formNumber),
    env.DB.prepare("DELETE FROM ReviewDraft WHERE form_number = ?").bind(formNumber),
    env.DB.prepare("DELETE FROM InteractionForm WHERE form_number = ?").bind(formNumber),
  ]);
  return json({ ok: true });
}

/* Hold after 7 days / Archived after 14 days when no invitation went out (PBI 21) */
async function applyAgingRules(env, s) {
  const noInvite = `NOT EXISTS (SELECT 1 FROM ReviewDraft d JOIN ReviewInvitation i ON i.draft_id = d.draft_id WHERE d.form_number = InteractionForm.form_number)`;
  const mine = `manager_id IN (SELECT manager_id FROM Manager WHERE restaurant_id = ?)`;
  await env.DB.batch([
    env.DB.prepare(`UPDATE InteractionForm SET activity_status = 'Archived' WHERE activity_status IN ('Open','Hold') AND created_at < ? AND ${noInvite} AND ${mine}`).bind(
      daysAgoIso(ARCHIVE_DAYS),
      s.rid
    ),
    env.DB.prepare(`UPDATE InteractionForm SET activity_status = 'Hold' WHERE activity_status = 'Open' AND created_at < ? AND ${noInvite} AND ${mine}`).bind(
      daysAgoIso(HOLD_DAYS),
      s.rid
    ),
  ]);
}

function requestStatus(row) {
  if (row.guest_response === "Opened Google") return "Completed";
  if (row.guest_response === "Declined") return "Declined";
  if (row.invitation_id) return "Sent";
  if (row.draft_status === "Approved") return "Approved";
  return "Draft";
}

async function listForms(env, s, url) {
  await applyAgingRules(env, s);
  const q = clean(url.searchParams.get("q") || "").toLowerCase();
  const { results } = await env.DB.prepare(
    `SELECT f.form_number, f.table_number, f.follow_up_consent, f.created_at, f.activity_status,
            g.full_name, g.email, g.phone,
            d.draft_id, d.draft_status, d.created_at AS draft_created_at, d.approved_at,
            i.invitation_id, i.sent_via, i.sent_at, i.guest_response, i.responded_at
     FROM InteractionForm f
     JOIN Guest g ON g.guest_id = f.guest_id
     JOIN Manager m ON m.manager_id = f.manager_id
     LEFT JOIN ReviewDraft d ON d.form_number = f.form_number AND d.draft_status != 'Deleted'
     LEFT JOIN ReviewInvitation i ON i.draft_id = d.draft_id
     WHERE m.restaurant_id = ?
     ORDER BY f.created_at DESC
     LIMIT 500`
  )
    .bind(s.rid)
    .all();
  let rows = results.map((r) => ({ ...r, status: requestStatus(r), has_draft: !!r.draft_id }));
  if (q) rows = rows.filter((r) => [r.full_name, r.email, r.phone, r.form_number, r.table_number].some((x) => x && String(x).toLowerCase().includes(q)));
  return json(rows);
}

async function getForm(env, s, formNumber) {
  const f = await loadOwnedForm(env, s, formNumber);
  const { results: aspects } = await env.DB.prepare("SELECT aspect_id FROM FormAspect WHERE form_number = ?").bind(formNumber).all();
  const draft = await loadDraft(env, formNumber);
  const inv = await loadInvitation(env, draft?.draft_id);
  const status = requestStatus({ ...draft, ...(inv || {}), draft_status: draft?.draft_status });
  const timeline = [{ label: "Created", at: f.created_at }];
  if (draft) timeline.push({ label: "Draft written", at: draft.created_at });
  if (draft?.approved_at) timeline.push({ label: "Approved", at: draft.approved_at });
  if (inv) timeline.push({ label: `Sent by ${inv.sent_via === "SMS" ? "text" : "email"}`, at: inv.sent_at });
  if (inv?.responded_at) timeline.push({ label: inv.guest_response === "Declined" ? "Guest declined" : "Guest posted to Google", at: inv.responded_at });
  return json({
    form: {
      form_number: f.form_number,
      table_number: f.table_number,
      follow_up_consent: f.follow_up_consent,
      detailed_notes: f.detailed_notes,
      created_at: f.created_at,
      activity_status: f.activity_status,
      aspects: aspects.map((a) => a.aspect_id),
    },
    guest: { full_name: f.full_name, email: f.email, phone: f.phone },
    draft,
    invitation: inv,
    status,
    timeline,
  });
}

/* ------------------------------------------------------------------ */
/* Review Generation Service                                           */
/* ------------------------------------------------------------------ */

async function generateDraftRoute(env, s, formNumber) {
  const draft = await createOrRegenerateDraft(env, s, formNumber);
  return json(draft);
}

async function createOrRegenerateDraft(env, s, formNumber) {
  const f = await loadOwnedForm(env, s, formNumber);
  if (f.follow_up_consent !== "Y") throw new HttpError(400, "The guest didn't agree to a follow-up, so Piccolo won't prepare a review request.", "follow_up_consent");
  const { results: aspects } = await env.DB.prepare(
    "SELECT a.aspect_name FROM FormAspect fa JOIN BasicAspect a ON a.aspect_id = fa.aspect_id WHERE fa.form_number = ?"
  )
    .bind(formNumber)
    .all();
  const praised = aspects.map((a) => a.aspect_name);
  if (!f.detailed_notes && !praised.length) {
    throw new HttpError(400, "Add notes or check at least one thing the guest praised so the draft has something to say.", "detailed_notes");
  }
  const existing = await loadDraft(env, formNumber);
  if (existing && (await loadInvitation(env, existing.draft_id))) throw new HttpError(409, "This invitation was already sent; the draft can't be rewritten.");

  const rest = await env.DB.prepare("SELECT restaurant_name FROM Restaurant WHERE restaurant_id = ?").bind(s.rid).first();
  const { text, source } = await writeReview(env, { restaurant: rest?.restaurant_name || "the restaurant", notes: f.detailed_notes || "", praised });
  const at = nowIso();
  if (existing) {
    await env.DB.prepare("UPDATE ReviewDraft SET draft_text = ?, draft_status = 'Drafted', created_at = ?, approved_at = NULL WHERE draft_id = ?")
      .bind(text, at, existing.draft_id)
      .run();
  } else {
    await env.DB.prepare("INSERT INTO ReviewDraft (form_number, draft_text, draft_status, created_at) VALUES (?, ?, 'Drafted', ?)").bind(formNumber, text, at).run();
  }
  const draft = await loadDraft(env, formNumber);
  return { ...draft, source };
}

async function writeReview(env, { restaurant, notes, praised }) {
  const facts = [praised.length ? `Things the guest praised: ${praised.join(", ")}.` : "", notes ? `Manager's notes of what the guest said: "${notes}"` : ""]
    .filter(Boolean)
    .join("\n");
  if (!env.AI) console.warn("AI binding missing: check \"ai\" in wrangler.jsonc");
  const messages = [
    {
      role: "system",
      content:
        "You write short, honest Google reviews in the first person, as the restaurant guest. " +
        "Use ONLY the facts provided. Never invent dishes, names, prices, or events that are not in the facts. " +
        "Write 3 to 5 natural sentences in plain, warm language. No hashtags, no emojis, no star ratings, no title, no quotation marks. " +
        "Output only the review text.",
    },
    { role: "user", content: `Restaurant: ${restaurant}\n${facts}\n\nWrite the review.` },
  ];
  const models = env.AI_MODEL ? [env.AI_MODEL, ...AI_MODELS] : AI_MODELS;
  for (const model of env.AI ? models : []) {
    try {
      const out = await env.AI.run(model, { messages, max_tokens: 260, temperature: 0.6 });
      let text = extractText(out).trim().replace(/^["“]|["”]$/g, "").trim();
      text = text.replace(/^(here('| i)s (the|your|a) review:?\s*)/i, "").trim();
      if (text.length >= 40) return { text: text.slice(0, 2000), source: "ai" };
      console.warn(`AI model ${model} returned too little text:`, JSON.stringify(out).slice(0, 300));
    } catch (e) {
      console.warn(`AI model ${model} failed:`, e?.message || String(e));
    }
  }
  return { text: templateReview(restaurant, notes, praised), source: "template" };
}

// Workers AI models answer in a few shapes; read whichever one came back.
function extractText(out) {
  if (!out) return "";
  if (typeof out === "string") return out;
  if (typeof out.response === "string") return out.response;
  if (out.response && typeof out.response === "object") return extractText(out.response);
  if (out.result) return extractText(out.result);
  const c = out.choices?.[0];
  if (c) return c.message?.content || c.text || "";
  return "";
}

// Fallback so the demo never stalls if the AI service is unavailable.
function templateReview(restaurant, notes, praised) {
  const phrases = {
    "Food quality and taste": "the food was delicious",
    "Speed of service": "the service was quick",
    "Friendly staff": "the staff were genuinely friendly",
    Atmosphere: "the atmosphere was lovely",
    "Value for money": "it was great value for the money",
    Cleanliness: "everything was spotless",
    "Special occasion handling": "they made our special occasion feel special",
    "Dietary needs handled": "they took good care of our dietary needs",
  };
  const parts = praised.map((p) => phrases[p] || p.toLowerCase());
  let s = `We had a wonderful visit to ${restaurant}.`;
  if (parts.length === 1) s += ` ${cap(parts[0])}.`;
  else if (parts.length > 1) s += ` ${cap(parts.slice(0, -1).join(", "))}, and ${parts[parts.length - 1]}.`;
  if (notes) s += ` ${cap(notes.replace(/\s+/g, " ").replace(/\.?$/, "."))}`;
  s += " We will definitely be back!";
  return s;
}
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

async function saveDraft(req, env, s, formNumber) {
  await loadOwnedForm(env, s, formNumber);
  const draft = await loadDraft(env, formNumber);
  if (!draft) throw new HttpError(404, "There's no draft yet. Generate one first.");
  if (await loadInvitation(env, draft.draft_id)) throw new HttpError(409, "This invitation was already sent; the draft can't be changed.");
  const b = await body(req);
  const text = clean(b.draft_text);
  if (text.length < 10) throw new HttpError(400, "The draft is too short. Write at least a sentence.", "draft_text");
  if (text.length > 2000) throw new HttpError(400, "The draft is too long (2,000 characters max).", "draft_text");
  if (b.approve) {
    await env.DB.prepare("UPDATE ReviewDraft SET draft_text = ?, draft_status = 'Approved', approved_at = ? WHERE draft_id = ?").bind(text, nowIso(), draft.draft_id).run();
  } else {
    await env.DB.prepare("UPDATE ReviewDraft SET draft_text = ?, draft_status = 'Drafted', approved_at = NULL WHERE draft_id = ?").bind(text, draft.draft_id).run();
  }
  return json(await loadDraft(env, formNumber));
}

async function sendInvitation(req, env, s, formNumber, url) {
  const f = await loadOwnedForm(env, s, formNumber);
  const b = await body(req);
  const via = b.via === "SMS" ? "SMS" : "Email";
  if (f.follow_up_consent !== "Y") throw new HttpError(400, "The guest didn't agree to a follow-up, so no invitation can be sent.");
  const draft = await loadDraft(env, formNumber);
  if (!draft) throw new HttpError(400, "Write and approve a draft before sending.");
  if (draft.draft_status !== "Approved") throw new HttpError(400, "Approve the draft before sending it to the guest.");
  if (await loadInvitation(env, draft.draft_id)) throw new HttpError(409, "An invitation was already sent to this guest.");
  if (via === "Email" && !f.email) throw new HttpError(400, "This guest has no email address. Send by text instead, or add an email.", "via");
  if (via === "SMS" && !f.phone) throw new HttpError(400, "This guest has no phone number. Send by email instead, or add a phone number.", "via");

  const token = randomToken();
  const at = nowIso();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO ReviewInvitation (draft_id, link_token, sent_via, sent_at, guest_response) VALUES (?, ?, ?, ?, 'Pending')").bind(
      draft.draft_id,
      token,
      via,
      at
    ),
    env.DB.prepare("UPDATE ReviewDraft SET draft_status = 'Sent' WHERE draft_id = ?").bind(draft.draft_id),
    env.DB.prepare("UPDATE InteractionForm SET activity_status = 'Pending Post' WHERE form_number = ?").bind(formNumber),
  ]);
  // Prototype: delivery is simulated. A real provider (email/SMS) would be called here.
  const link = `${url.origin}/r/${token}`;
  return json({ ok: true, sent_via: via, sent_to: via === "SMS" ? f.phone : f.email, sent_at: at, link, simulated: true });
}

/* ------------------------------------------------------------------ */
/* Guest Response Service (no login, secure link)                      */
/* ------------------------------------------------------------------ */

async function loadInviteByToken(env, token) {
  const row = await env.DB.prepare(
    `SELECT i.*, d.draft_text, f.form_number, g.full_name, r.restaurant_name, r.google_review_link
     FROM ReviewInvitation i
     JOIN ReviewDraft d ON d.draft_id = i.draft_id
     JOIN InteractionForm f ON f.form_number = d.form_number
     JOIN Guest g ON g.guest_id = f.guest_id
     JOIN Manager m ON m.manager_id = f.manager_id
     JOIN Restaurant r ON r.restaurant_id = m.restaurant_id
     WHERE i.link_token = ?`
  )
    .bind(token)
    .first();
  if (!row || row.guest_response === "Deleted") throw new HttpError(404, "This invitation link isn't valid or has expired.");
  return row;
}

async function getInvite(env, token) {
  const r = await loadInviteByToken(env, token);
  return json({
    restaurant_name: r.restaurant_name,
    google_review_link: r.google_review_link || "https://www.google.com/maps",
    guest_first_name: (r.full_name || "").split(" ")[0],
    text: r.guest_edited_text || r.draft_text,
    guest_response: r.guest_response,
  });
}

async function respondInvite(req, env, token) {
  const r = await loadInviteByToken(env, token);
  const b = await body(req);
  if (r.guest_response === "Declined") throw new HttpError(409, "You already declined this invitation. Thanks for letting us know!");
  const at = nowIso();
  if (b.action === "decline") {
    if (r.guest_response === "Opened Google") throw new HttpError(409, "You've already posted this review. Thank you!");
    await env.DB.batch([
      env.DB.prepare("UPDATE ReviewInvitation SET guest_response = 'Declined', responded_at = ? WHERE invitation_id = ?").bind(at, r.invitation_id),
      env.DB.prepare("UPDATE InteractionForm SET activity_status = 'Denied' WHERE form_number = ?").bind(r.form_number),
    ]);
    return json({ ok: true, guest_response: "Declined" });
  }
  if (b.action === "post") {
    const text = clean(b.text);
    if (text.length < 10) throw new HttpError(400, "Your review is a bit short. Add a sentence or two before posting.");
    if (text.length > 4000) throw new HttpError(400, "Your review is too long (4,000 characters max).");
    const edited = text !== r.draft_text ? text : null;
    await env.DB.prepare("UPDATE ReviewInvitation SET guest_edited_text = ?, guest_response = 'Opened Google', responded_at = ? WHERE invitation_id = ?")
      .bind(edited, at, r.invitation_id)
      .run();
    return json({ ok: true, guest_response: "Opened Google", google_review_link: r.google_review_link || "https://www.google.com/maps" });
  }
  throw new HttpError(400, "Unknown action.");
}

/* ------------------------------------------------------------------ */
/* Demo data (so the 7/14-day rules and every status show on demo day) */
/* ------------------------------------------------------------------ */

async function seedDemo(env, s) {
  const samples = [
    { name: "Jordan Lee", email: "jordan@example.com", table: "Patio 3", days: 0.05, aspects: [1, 7], notes: "Seafood pasta was excellent. Allergy request handled carefully. Live music made the anniversary special.", stage: "completed" },
    { name: "Priya Shah", phone: "225-555-0142", table: "8", days: 0.4, aspects: [2, 3], notes: "Loved how fast the lunch came out; server Marco was very friendly.", stage: "sent" },
    { name: "Carlos Diaz", email: "carlos@example.com", table: "Bar 2", days: 1, aspects: [4, 5], notes: "Great happy hour value, cozy vibe at the bar.", stage: "approved" },
    { name: "Emma Nguyen", email: "emma@example.com", table: "14", days: 2, aspects: [1], notes: "Tiramisu was the best she's had outside Italy.", stage: "drafted" },
    { name: "Sam Patel", email: "sam@example.com", table: "5", days: 3, aspects: [3], notes: "Said thanks but prefers not to write reviews.", stage: "declined" },
    { name: "Olivia Brooks", phone: "225-555-0199", table: "2", days: 8, aspects: [1, 3], notes: "Enjoyed the lasagna.", stage: "form" },
    { name: "Noah Kim", email: "noah@example.com", table: "11", days: 15, aspects: [4], notes: "Liked the patio lights.", stage: "form" },
  ];
  const rest = await env.DB.prepare("SELECT restaurant_name FROM Restaurant WHERE restaurant_id = ?").bind(s.rid).first();
  let created = 0;
  for (const x of samples) {
    const created_at = daysAgoIso(x.days);
    const g = await env.DB.prepare("INSERT INTO Guest (full_name, email, phone) VALUES (?, ?, ?)").bind(x.name, x.email || null, x.phone || null).run();
    const fn = await nextFormNumber(env, new Date(created_at));
    await env.DB.prepare(
      "INSERT INTO InteractionForm (form_number, manager_id, guest_id, table_number, follow_up_consent, detailed_notes, created_at, activity_status) VALUES (?, ?, ?, ?, 'Y', ?, ?, 'Open')"
    )
      .bind(fn, s.mid, g.meta.last_row_id, x.table, x.notes, created_at)
      .run();
    await saveAspects(env, fn, x.aspects);
    created++;
    if (x.stage === "form") continue;
    const { results: asp } = await env.DB.prepare(
      "SELECT a.aspect_name FROM FormAspect fa JOIN BasicAspect a ON a.aspect_id = fa.aspect_id WHERE fa.form_number = ?"
    )
      .bind(fn)
      .all();
    const text = templateReview(rest.restaurant_name, x.notes, asp.map((a) => a.aspect_name));
    const step = (h) => new Date(Date.parse(created_at) + h * 3600000).toISOString();
    const approved = x.stage !== "drafted";
    const sent = ["sent", "completed", "declined"].includes(x.stage);
    const d = await env.DB.prepare("INSERT INTO ReviewDraft (form_number, draft_text, draft_status, created_at, approved_at) VALUES (?, ?, ?, ?, ?)")
      .bind(fn, text, sent ? "Sent" : approved ? "Approved" : "Drafted", step(0.02), approved ? step(0.05) : null)
      .run();
    if (!sent) continue;
    const resp = x.stage === "completed" ? "Opened Google" : x.stage === "declined" ? "Declined" : "Pending";
    await env.DB.prepare(
      "INSERT INTO ReviewInvitation (draft_id, link_token, sent_via, sent_at, guest_response, responded_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(d.meta.last_row_id, randomToken(), x.email ? "Email" : "SMS", step(0.06), resp, resp === "Pending" ? null : step(1))
      .run();
    await env.DB.prepare("UPDATE InteractionForm SET activity_status = ? WHERE form_number = ?").bind(resp === "Declined" ? "Denied" : "Pending Post", fn).run();
  }
  return json({ ok: true, created });
}
