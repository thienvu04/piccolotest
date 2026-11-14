// Piccolo — manager web app (vanilla JS, hash routing)

const app = document.getElementById("app");
const state = { me: null, aspects: null, filter: "All", q: "" };
const LOCAL_NEW = "piccolo:new-form";

/* ---------------- utilities ---------------- */
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const initials = (n) => (n || "?").split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

class ApiError extends Error {
  constructor(msg, status, field) { super(msg); this.status = status; this.field = field; }
}
async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError("We couldn't reach Piccolo. Check your connection and try again.", 0);
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (res.status === 401 && !path.startsWith("/api/login")) {
    state.me = null;
    location.hash = "#/login";
    throw new ApiError("Please sign in to continue.", 401);
  }
  if (!res.ok) throw new ApiError(data?.error || "Something went wrong. Please try again.", res.status, data?.field);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

function busy(btn, on, label) {
  if (!btn) return;
  if (on) {
    btn.dataset.label = btn.innerHTML;
    btn.setAttribute("aria-busy", "true");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner" aria-hidden="true"></span> ${esc(label || "Working…")}`;
  } else {
    btn.removeAttribute("aria-busy");
    btn.disabled = false;
    if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
  }
}

function showError(container, err) {
  container.innerHTML = `<div class="alert alert-error" role="alert">${esc(err.message || err)}</div>`;
  container.hidden = false;
  container.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

const chip = (status) => `<span class="chip chip-${esc(status)}">${esc(status)}</span>`;

/* ---------------- shell ---------------- */
const icons = {
  list: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  plus: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
  gear: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
};

function shell(active, inner) {
  const nav = (href, key, label) => `<a href="${href}" ${active === key ? 'aria-current="page"' : ""}>${label}</a>`;
  app.innerHTML = `
    <header class="appbar">
      <div class="appbar-inner">
        <a class="brand" href="#/requests">PICCOLO</a>
        <span class="brand-sub">${esc(state.me?.restaurant_name || "")}</span>
        <nav class="nav" aria-label="Main">
          ${nav("#/requests", "requests", "Review requests")}
          ${nav("#/new", "new", "New guest feedback")}
          ${nav("#/settings", "settings", "Settings")}
          <button type="button" id="logout">Sign out</button>
        </nav>
      </div>
    </header>
    <main id="main">${inner}</main>
    <nav class="tabbar" aria-label="Main">
      <a href="#/requests" ${active === "requests" ? 'aria-current="page"' : ""}>${icons.list}Requests</a>
      <a href="#/new" ${active === "new" ? 'aria-current="page"' : ""}>${icons.plus}New feedback</a>
      <a href="#/settings" ${active === "settings" ? 'aria-current="page"' : ""}>${icons.gear}Settings</a>
    </nav>`;
  $("#logout").onclick = logout;
  window.scrollTo(0, 0);
}

async function logout() {
  try { await api("/api/logout", { method: "POST" }); } catch {}
  state.me = null;
  location.hash = "#/login";
}

/* ---------------- auth ---------------- */
function renderAuth(mode = "login") {
  app.innerHTML = `
  <div class="auth-wrap">
    <div class="auth">
      <div class="auth-logo"><span class="mark">P</span><h1>PICCOLO</h1>
        <p class="small">Turn what happy guests tell you into reviews they're glad to post.</p></div>
      <div class="card">
        <div class="tabs" role="tablist">
          <button role="tab" id="tab-login" aria-selected="${mode === "login"}">Sign in</button>
          <button role="tab" id="tab-register" aria-selected="${mode === "register"}">Create account</button>
        </div>
        <div id="auth-err" hidden></div>
        ${mode === "login" ? `
        <form id="auth-form" class="stack" novalidate>
          <label class="field"><span class="label">Email</span><input type="email" name="email" autocomplete="username" required /></label>
          <label class="field"><span class="label">Password</span><input type="password" name="password" autocomplete="current-password" required /></label>
          <button class="btn btn-primary btn-block" type="submit">Sign in</button>
          <div class="alert alert-info demo-box"><span>Demo account: <b>demo@piccolo.app</b> / <b>piccolo123</b></span>
            <button type="button" class="btn btn-secondary btn-sm" id="fill-demo">Use demo account</button></div>
        </form>` : `
        <form id="auth-form" class="stack" novalidate>
          <label class="field"><span class="label">Restaurant name</span><input type="text" name="restaurant_name" maxlength="100" required /></label>
          <label class="field"><span class="label">Google “write a review” link <span class="small">(optional)</span></span>
            <input type="url" name="google_review_link" placeholder="https://g.page/r/…/review" maxlength="255" />
            <span class="hint">Guests are sent here to post. You can add it later in Settings.</span></label>
          <label class="field"><span class="label">Your name</span><input type="text" name="manager_name" maxlength="100" autocomplete="name" required /></label>
          <label class="field"><span class="label">Email</span><input type="email" name="email" maxlength="100" autocomplete="username" required /></label>
          <label class="field"><span class="label">Password</span><input type="password" name="password" minlength="8" autocomplete="new-password" required />
            <span class="hint">At least 8 characters.</span></label>
          <button class="btn btn-primary btn-block" type="submit">Create account</button>
        </form>`}
      </div>
    </div>
  </div>`;
  $("#tab-login").onclick = () => (location.hash = "#/login");
  $("#tab-register").onclick = () => (location.hash = "#/register");
  const form = $("#auth-form");
  $("#fill-demo")?.addEventListener("click", () => {
    form.email.value = "demo@piccolo.app";
    form.password.value = "piccolo123";
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector("[type=submit]");
    const data = Object.fromEntries(new FormData(form));
    busy(btn, true, mode === "login" ? "Signing in…" : "Creating…");
    try {
      await api(mode === "login" ? "/api/login" : "/api/register", { method: "POST", body: data });
      state.me = await api("/api/me");
      location.hash = mode === "login" ? "#/requests" : "#/new";
    } catch (err) {
      showError($("#auth-err"), err);
      if (err.field && form[err.field]) form[err.field].focus();
    } finally {
      busy(btn, false);
    }
  };
}

/* ---------------- requests list ---------------- */
const FILTERS = ["All", "Draft", "Approved", "Sent", "Completed", "Declined", "On hold", "Archived"];
function matchesFilter(r, f) {
  if (f === "All") return r.activity_status !== "Archived";
  if (f === "On hold") return r.activity_status === "Hold";
  if (f === "Archived") return r.activity_status === "Archived";
  return r.status === f && r.activity_status !== "Archived";
}

async function renderRequests() {
  shell("requests", `<div class="page-head"><div><h1>Review requests</h1><p class="small">Every guest conversation and where its review stands.</p></div>
    <a class="btn btn-primary" href="#/new">+ New guest feedback</a></div><div id="body"><p class="small">Loading…</p></div>`);
  let rows;
  try {
    rows = await api("/api/forms");
  } catch (err) {
    if (err.status !== 401) showError($("#body"), err);
    return;
  }
  const body = $("#body");
  if (!rows.length) {
    body.innerHTML = `<div class="card empty"><h2>No guest feedback yet</h2>
      <p>After a guest shares something they loved, record it here and Piccolo will turn it into a review draft.</p>
      <div class="row" style="justify-content:center"><a class="btn btn-primary" href="#/new">Record guest feedback</a>
      <button class="btn btn-secondary" id="seed">Load sample data</button></div></div>`;
    $("#seed").onclick = (e) => seed(e.currentTarget);
    return;
  }
  const active = rows.filter((r) => r.activity_status !== "Archived");
  const sent = rows.filter((r) => ["Sent", "Completed", "Declined"].includes(r.status)).length;
  const done = rows.filter((r) => r.status === "Completed").length;
  const waiting = active.filter((r) => r.status === "Draft" || r.status === "Approved").length;
  const counts = Object.fromEntries(FILTERS.map((f) => [f, rows.filter((r) => matchesFilter(r, f)).length]));

  body.innerHTML = `
    <div class="stats">
      <div class="stat"><b>${waiting}</b><span>Need your attention</span></div>
      <div class="stat"><b>${sent}</b><span>Invitations sent</span></div>
      <div class="stat"><b>${done}</b><span>Posted to Google</span></div>
      <div class="stat"><b>${sent ? Math.round((done / sent) * 100) : 0}%</b><span>Of invited guests posted</span></div>
    </div>
    <div class="toolbar">
      <label class="search" style="flex:1"><span class="sr-only">Search</span>
        <input type="search" id="q" placeholder="Search guests, form # or table" value="${esc(state.q)}" /></label>
      <div class="filters" role="group" aria-label="Filter by status">
        ${FILTERS.map((f) => `<button type="button" data-f="${f}" aria-pressed="${state.filter === f}">${f}<span class="count">${counts[f]}</span></button>`).join("")}
      </div>
    </div>
    <div id="list" class="list"></div>`;

  const draw = () => {
    const q = state.q.toLowerCase();
    const list = rows.filter(
      (r) => matchesFilter(r, state.filter) && (!q || [r.full_name, r.email, r.phone, r.form_number, r.table_number].some((x) => x && x.toLowerCase().includes(q)))
    );
    $("#list").innerHTML = list.length
      ? list.map((r) => `
        <a class="req" href="#/form/${esc(r.form_number)}">
          <span class="avatar" aria-hidden="true">${esc(initials(r.full_name))}</span>
          <span class="req-main">
            <span class="req-name">${esc(r.full_name)}</span>
            <span class="req-meta">${esc(r.form_number)}${r.table_number ? ` · Table ${esc(r.table_number)}` : ""} · ${esc(ago(r.created_at))}</span>
            <span class="req-meta">${r.has_draft ? "" : r.follow_up_consent === "Y" ? "No draft yet" : "No follow-up consent"}</span>
          </span>
          <span class="req-side">${chip(r.status)}
            ${r.activity_status === "Hold" ? '<span class="tag tag-Hold">On hold</span>' : r.activity_status === "Archived" ? '<span class="tag">Archived</span>' : ""}</span>
        </a>`).join("")
      : `<div class="card empty" style="grid-column:1/-1"><p>No requests match this filter.</p></div>`;
  };
  draw();
  $("#q").oninput = (e) => { state.q = e.target.value; draw(); };
  $$(".filters button").forEach((b) => (b.onclick = () => {
    state.filter = b.dataset.f;
    $$(".filters button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    draw();
  }));
}

async function seed(btn) {
  busy(btn, true, "Loading…");
  try {
    await api("/api/demo/seed", { method: "POST" });
    toast("Sample guests added");
    renderRequests();
  } catch (err) {
    toast(err.message);
    busy(btn, false);
  }
}

/* ---------------- new / edit guest feedback ---------------- */
async function getAspects() {
  if (!state.aspects) state.aspects = await api("/api/aspects");
  return state.aspects;
}

async function renderForm(formNumber) {
  const editing = !!formNumber;
  shell(editing ? "" : "new", `<p class="small">Loading…</p>`);
  let aspects, existing = null;
  try {
    aspects = await getAspects();
    if (editing) existing = await api(`/api/forms/${formNumber}`);
  } catch (err) {
    if (err.status !== 401) showError($("#main"), err);
    return;
  }
  if (existing?.invitation) { location.hash = `#/form/${formNumber}`; return; }

  const saved = editing
    ? { ...existing.guest, table_number: existing.form.table_number, detailed_notes: existing.form.detailed_notes,
        follow_up_consent: existing.form.follow_up_consent === "Y", aspects: existing.form.aspects }
    : store.get(LOCAL_NEW) || {};
  const v = (k) => esc(saved[k] || "");

  $("#main").innerHTML = `
  <div class="narrow">
    <div class="page-head"><div>
      <h1>${editing ? "Edit guest feedback" : "New guest feedback"}</h1>
      <p class="small">Capture only comments the guest actually shared.${editing ? ` Form ${esc(formNumber)}.` : ""}</p></div></div>
    ${!editing && store.get(LOCAL_NEW) ? `<div class="alert alert-info demo-box" style="margin-bottom:12px"><span>We restored the form you started earlier.</span> <button type="button" class="btn btn-secondary btn-sm" id="clear-local">Start over</button></div>` : ""}
    <form id="fb" class="card stack" novalidate>
      <div id="form-err" hidden></div>
      <label class="field" data-f="full_name"><span class="label">Guest name</span>
        <input type="text" name="full_name" maxlength="100" autocomplete="off" value="${v("full_name")}" required /></label>
      <div>
        <div class="fields-2">
          <label class="field" data-f="email"><span class="label">Guest email</span>
            <input type="email" name="email" maxlength="100" inputmode="email" autocomplete="off" placeholder="(optional)" value="${v("email")}" /></label>
          <label class="field" data-f="phone"><span class="label">Guest phone</span>
            <input type="tel" name="phone" maxlength="20" inputmode="tel" autocomplete="off" placeholder="(optional)" value="${v("phone")}" /></label>
        </div>
        <span class="small" style="display:block;margin-top:4px">Email or phone is needed to send the review invitation.</span>
      </div>
      <div class="fields-3">
        <label class="field" data-f="table_number"><span class="label">Table number</span>
          <input type="text" name="table_number" maxlength="10" placeholder="e.g. 12 or Patio 3" value="${v("table_number")}" style="max-width:220px" /></label>
      </div>
      <fieldset>
        <legend>What did the guest praise?</legend>
        <div class="checks">
          ${aspects.map((a) => `<label class="check"><input type="checkbox" name="aspects" value="${a.aspect_id}" ${(saved.aspects || []).map(Number).includes(a.aspect_id) ? "checked" : ""}/> ${esc(a.aspect_name)}</label>`).join("")}
        </div>
      </fieldset>
      <label class="field" data-f="detailed_notes"><span class="label">Detailed notes</span>
        <textarea name="detailed_notes" maxlength="2000" placeholder="What did the guest say, in their words? e.g. “Seafood pasta was excellent. Live music made our anniversary special.”">${v("detailed_notes")}</textarea>
        <div class="counter"><span id="notes-count">0</span> / 2000</div></label>
      <label class="check consent" data-f="follow_up_consent"><input type="checkbox" name="follow_up_consent" ${saved.follow_up_consent ? "checked" : ""}/>
        <span>Guest agreed to receive one follow-up<br><span class="small">Only guests who say yes can be sent a review invitation.</span></span></label>
      <div class="stack">
        <button class="btn btn-primary btn-block" type="submit" value="generate" id="gen-btn">Save and generate draft</button>
        <button class="btn btn-secondary btn-block" type="submit" value="save">Save draft</button>
        ${editing ? `<a class="btn btn-ghost btn-block" href="#/form/${esc(formNumber)}">Cancel</a>` : ""}
      </div>
    </form>
  </div>`;

  const form = $("#fb");
  const notes = form.detailed_notes;
  const updCount = () => ($("#notes-count").textContent = notes.value.length);
  const updConsent = () => {
    const ok = form.follow_up_consent.checked;
    $("#gen-btn").disabled = !ok;
    $("#gen-btn").title = ok ? "" : "The guest must agree to a follow-up first";
  };
  updCount(); updConsent();
  $("#clear-local")?.addEventListener("click", () => { store.del(LOCAL_NEW); renderForm(); });

  const collect = () => ({
    full_name: form.full_name.value.trim(),
    email: form.email.value.trim(),
    phone: form.phone.value.trim(),
    table_number: form.table_number.value.trim(),
    detailed_notes: notes.value.trim(),
    follow_up_consent: form.follow_up_consent.checked,
    aspects: $$("input[name=aspects]:checked", form).map((x) => Number(x.value)),
  });
  // Keep an unfinished new form on this device so a busy shift doesn't lose it (PBI 20)
  form.addEventListener("input", () => {
    updCount(); updConsent();
    $$(".field.invalid", form).forEach((f) => { f.classList.remove("invalid"); f.querySelector(".err")?.remove(); });
    if (!editing) store.set(LOCAL_NEW, collect());
  });

  const fieldError = (name, msg) => {
    const f = form.querySelector(`[data-f="${name}"]`) || form.querySelector(`[data-f="email"]`);
    if (!f) return;
    f.classList.add("invalid");
    if (!f.querySelector(".err")) f.insertAdjacentHTML("beforeend", `<span class="err">${esc(msg)}</span>`);
    f.querySelector("input,textarea")?.focus();
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const generate = e.submitter?.value === "generate";
    const d = collect();
    $("#form-err").hidden = true;
    // client-side validation (server validates again)
    if (!d.full_name) return fieldError("full_name", "Enter the guest's name.");
    if (!d.email && !d.phone) return fieldError("email", "Add an email or phone number.");
    if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email)) return fieldError("email", "That email address doesn't look right.");
    if (d.phone && d.phone.replace(/\D/g, "").length < 7) return fieldError("phone", "That phone number doesn't look right.");
    if (generate && !d.detailed_notes && !d.aspects.length) return fieldError("detailed_notes", "Add notes or check something the guest praised.");

    const payload = {
      guest: { full_name: d.full_name, email: d.email, phone: d.phone },
      table_number: d.table_number, detailed_notes: d.detailed_notes,
      follow_up_consent: d.follow_up_consent ? "Y" : "N", aspects: d.aspects, generate,
    };
    const btn = e.submitter;
    busy(btn, true, generate ? "Writing review draft…" : "Saving…");
    try {
      const res = editing
        ? await api(`/api/forms/${formNumber}`, { method: "PUT", body: payload })
        : await api("/api/forms", { method: "POST", body: payload });
      store.del(LOCAL_NEW);
      if (res.draft?.source === "template") sessionStorage.setItem("piccolo:template", "1");
      toast(generate ? "Draft ready — review it below" : `Saved as ${res.form_number}`);
      location.hash = `#/form/${res.form_number}`;
    } catch (err) {
      busy(btn, false);
      if (err.field && form.querySelector(`[data-f="${err.field}"]`)) fieldError(err.field, err.message);
      else showError($("#form-err"), err);
    }
  };
}

/* ---------------- request detail ---------------- */
async function renderDetail(formNumber) {
  shell("", `<p class="small">Loading…</p>`);
  let d, aspects;
  try {
    [d, aspects] = await Promise.all([api(`/api/forms/${formNumber}`), getAspects()]);
  } catch (err) {
    if (err.status !== 401) showError($("#main"), err);
    return;
  }
  const { form, guest, draft, invitation, status, timeline } = d;
  const praised = aspects.filter((a) => form.aspects.includes(a.aspect_id)).map((a) => a.aspect_name);
  const sent = !!invitation;
  const approved = draft?.draft_status === "Approved" || sent;
  const consent = form.follow_up_consent === "Y";
  const usedTemplate = sessionStorage.getItem("piccolo:template") === "1";
  sessionStorage.removeItem("piccolo:template");
  const link = invitation ? `${location.origin}/r/${invitation.link_token}` : "";
  const defaultVia = guest.email ? "Email" : "SMS";

  $("#main").innerHTML = `
    <a href="#/requests" class="btn btn-ghost btn-sm" style="margin-bottom:8px">← All requests</a>
    <div class="page-head">
      <div class="row" style="gap:12px">
        <span class="avatar" aria-hidden="true">${esc(initials(guest.full_name))}</span>
        <div><h1>${esc(guest.full_name)}</h1><p class="small">Form ${esc(form.form_number)}${form.table_number ? ` · Table ${esc(form.table_number)}` : ""} · ${esc(fmtTime(form.created_at))}</p></div>
      </div>
      <div class="row">${chip(status)}${form.activity_status === "Hold" ? '<span class="tag tag-Hold">On hold</span>' : form.activity_status === "Archived" ? '<span class="tag">Archived</span>' : ""}</div>
    </div>
    <div class="grid-2">
      <div>
        <!-- 1. Guest comments -->
        <section class="card">
          <div class="section-head"><span class="num done">1</span><h2>What the guest told you</h2><span class="spacer"></span>
            ${sent ? "" : `<a class="btn btn-ghost btn-sm" href="#/form/${esc(form.form_number)}/edit">Edit</a>`}</div>
          <dl class="kv">
            <dt>Email</dt><dd>${esc(guest.email || "—")}</dd>
            <dt>Phone</dt><dd>${esc(guest.phone || "—")}</dd>
            <dt>Follow-up</dt><dd>${consent ? "Agreed to one follow-up" : "<b>Did not agree</b> — no invitation can be sent"}</dd>
          </dl>
          ${praised.length ? `<div style="margin-top:14px"><div class="small" style="margin-bottom:6px">Praised</div><div class="pill-list">${praised.map((p) => `<span class="pill">${esc(p)}</span>`).join("")}</div></div>` : ""}
          ${form.detailed_notes ? `<div style="margin-top:14px"><div class="small" style="margin-bottom:6px">Notes</div><p class="quote">${esc(form.detailed_notes)}</p></div>` : ""}
        </section>

        <!-- 2. Review draft -->
        <section class="card ${consent ? "" : "locked"}" aria-disabled="${!consent}">
          <div class="section-head"><span class="num ${approved ? "done" : ""}">2</span><h2>Review draft</h2></div>
          <div id="draft-err" hidden></div>
          ${!draft ? `
            <p>Piccolo will write a short review in the guest's voice, using only what you recorded.</p>
            <button class="btn btn-primary" id="gen">Generate review draft</button>` : `
            ${usedTemplate ? `<div class="alert alert-warn" style="margin-bottom:12px">The AI writer was busy, so Piccolo used a simple template. Edit it or try “Rewrite”.</div>` : ""}
            <label class="field"><span class="sr-only">Draft text</span>
              <textarea id="draft-text" maxlength="2000" rows="7" ${sent ? "readonly" : ""}>${esc(draft.draft_text)}</textarea>
              <div class="counter"><span id="draft-count">${draft.draft_text.length}</span> / 2000</div></label>
            ${sent ? `<p class="small">This draft was sent to the guest and can no longer be changed.</p>` : `
            <p class="small" id="draft-hint">${approved ? "" : "Read it as the guest would. Fix anything that doesn't sound like them, then approve."}</p>
            <div id="approved-note" class="alert alert-success" ${draft.draft_status === "Approved" ? "" : "hidden"} style="margin-bottom:12px">Approved — ready to send.</div>
            <div class="row">
              <button class="btn btn-primary" id="approve" ${draft.draft_status === "Approved" ? "hidden" : ""}>Approve draft</button>
              <button class="btn btn-secondary" id="save-draft" hidden>Save changes</button>
              <button class="btn btn-ghost" id="regen">↻ Rewrite</button>
            </div>`}`}
        </section>

        <!-- 3. Invitation -->
        <section class="card ${approved && consent ? "" : "locked"}" aria-disabled="${!(approved && consent)}" id="send-card">
          <div class="section-head"><span class="num ${sent ? "done" : ""}">3</span><h2>Send invitation</h2></div>
          <div id="send-err" hidden></div>
          ${sent ? sentBlock(invitation, guest, link) : `
            <p class="small" style="margin-top:0">${approved ? "The guest gets a link to see the draft, edit it, and post it to Google — or say no thanks." : "Approve the draft to unlock sending."}</p>
            <fieldset style="margin-bottom:14px"><legend>Send by</legend>
              <div class="segmented">
                <label><input type="radio" name="via" value="Email" ${defaultVia === "Email" ? "checked" : ""} ${guest.email ? "" : "disabled"}/> Email</label>
                <label><input type="radio" name="via" value="SMS" ${defaultVia === "SMS" ? "checked" : ""} ${guest.phone ? "" : "disabled"}/> Text message</label>
              </div>
              <div class="small" id="via-to" style="margin-top:6px"></div>
            </fieldset>
            ${!guest.email || !guest.phone ? `<div class="alert alert-warn" style="margin-bottom:12px">No ${!guest.email ? "email" : "phone number"} on file, so only ${!guest.email ? "text" : "email"} is available.</div>` : ""}
            <div class="row">
              <button class="btn btn-secondary" id="preview">Preview invitation</button>
              <button class="btn btn-primary" id="send">Send invitation</button>
            </div>`}
        </section>
      </div>

      <aside class="stack">
        <section class="card">
          <h2 style="margin-bottom:12px">History</h2>
          <ol class="timeline">${timeline.map((t) => `<li>${esc(t.label)}<time datetime="${esc(t.at)}">${esc(fmtTime(t.at))}</time></li>`).join("")}</ol>
          ${!sent ? `<button class="btn btn-ghost btn-sm" id="delete" style="color:var(--danger);margin-top:4px">Delete this form</button>` : ""}
        </section>
        ${invitation?.guest_edited_text ? `<section class="card"><h2 style="margin-bottom:8px">Guest's final wording</h2><p class="quote">${esc(invitation.guest_edited_text)}</p></section>` : ""}
      </aside>
    </div>
    <dialog id="dlg"></dialog>`;

  // ---- wire up: draft ----
  $("#gen")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    busy(btn, true, "Writing review draft…");
    try {
      const r = await api(`/api/forms/${formNumber}/draft`, { method: "POST" });
      if (r.source === "template") sessionStorage.setItem("piccolo:template", "1");
      renderDetail(formNumber);
    } catch (err) { busy(btn, false); showError($("#draft-err"), err); }
  });
  const ta = $("#draft-text");
  if (ta && !sent) {
    const original = draft.draft_text;
    ta.addEventListener("input", () => {
      $("#draft-count").textContent = ta.value.length;
      const changed = ta.value.trim() !== original.trim();
      $("#save-draft").hidden = !changed;
      if (changed) { $("#approve").hidden = false; $("#approved-note").hidden = true; lockSend(true); }
    });
    $("#approve").onclick = (e) => saveDraftText(e.currentTarget, formNumber, ta.value, true);
    $("#save-draft").onclick = (e) => saveDraftText(e.currentTarget, formNumber, ta.value, false);
    $("#regen").onclick = async (e) => {
      const btn = e.currentTarget;
      if (ta.value.trim() !== original.trim() && !confirmInline(btn, "Replace your edits?")) return;
      busy(btn, true, "Rewriting…");
      try {
        const r = await api(`/api/forms/${formNumber}/draft`, { method: "POST" });
        if (r.source === "template") sessionStorage.setItem("piccolo:template", "1");
        toast("New draft written");
        renderDetail(formNumber);
      } catch (err) { busy(btn, false); showError($("#draft-err"), err); }
    };
  }
  function lockSend(lock) {
    const c = $("#send-card");
    if (!c || sent) return;
    c.classList.toggle("locked", lock);
  }

  // ---- wire up: send ----
  const viaTo = () => {
    const via = $("input[name=via]:checked")?.value;
    if ($("#via-to")) $("#via-to").textContent = via ? `To ${via === "SMS" ? guest.phone : guest.email}` : "";
  };
  $$("input[name=via]").forEach((r) => (r.onchange = viaTo));
  viaTo();
  $("#preview")?.addEventListener("click", () => openPreview(guest, $("#draft-text")?.value || draft?.draft_text, $("input[name=via]:checked")?.value));
  $("#send")?.addEventListener("click", (e) => doSend(e.currentTarget));

  async function doSend(btn) {
    const via = $("input[name=via]:checked")?.value;
    if (!via) return showError($("#send-err"), new Error("This guest has no email or phone number. Edit the form to add one."));
    busy(btn, true, "Sending…");
    try {
      const r = await api(`/api/forms/${formNumber}/send`, { method: "POST", body: { via } });
      $("#dlg").open && $("#dlg").close();
      toast(`Invitation sent to ${r.sent_to}`);
      renderDetail(formNumber);
    } catch (err) { busy(btn, false); showError($("#send-err"), err); }
  }

  function openPreview(guest, text, via) {
    const dlg = $("#dlg");
    const first = (guest.full_name || "").split(" ")[0];
    const rname = state.me?.restaurant_name || "our restaurant";
    const msg = via === "SMS"
      ? `<div class="sms-bubble">Hi ${esc(first)}, thanks for visiting ${esc(rname)}! We turned your kind words into a short review. Edit it or post it to Google in 2 taps: <u>${esc(location.host)}/r/…</u> Reply STOP to opt out.</div>`
      : `<div class="meta"><b>From:</b> ${esc(rname)} via Piccolo<br><b>To:</b> ${esc(guest.email)}<br><b>Subject:</b> Thanks for dining with us, ${esc(first)}!</div>Hi ${esc(first)},

Thank you for chatting with us during your visit to ${esc(rname)}. We wrote down what you shared and turned it into a short review:

<i>“${esc(text)}”</i>

If you'd like, you can edit it and post it to Google in a couple of taps — or let us know you'd rather not. No account needed.

<b style="color:var(--primary)">[ See my review → ]</b>

Grazie,
${esc(state.me?.manager_name || "")}`;
    dlg.innerHTML = `
      <div class="modal-head"><h2>Preview: ${via === "SMS" ? "text message" : "email"}</h2><span class="spacer"></span>
        <button class="btn btn-ghost btn-sm" id="dlg-x" aria-label="Close">✕</button></div>
      <div class="modal-body"><div class="preview-msg">${msg}</div></div>
      <div class="modal-foot"><button class="btn btn-secondary" id="dlg-close">Back to edit</button>
        <button class="btn btn-primary" id="dlg-send">Send invitation</button></div>`;
    $("#dlg-x").onclick = $("#dlg-close").onclick = () => dlg.close();
    $("#dlg-send").onclick = (e) => doSend(e.currentTarget);
    dlg.showModal();
  }

  // ---- sent: copy link + QR ----
  if (sent) {
    $("#copy-link")?.addEventListener("click", async () => {
      await copyText(link, $("#link-input"));
      toast("Link copied");
    });
    const qr = $("#qr-img");
    if (qr && window.qrcode) {
      try {
        const q = window.qrcode(0, "M");
        q.addData(link);
        q.make();
        qr.innerHTML = `<img alt="QR code for the guest invitation link" src="${q.createDataURL(5, 0)}" />`;
      } catch { qr.parentElement.hidden = true; }
    }
  }

  // ---- delete ----
  $("#delete")?.addEventListener("click", async (e) => {
    if (!confirmInline(e.currentTarget, "Tap again to delete")) return;
    try {
      await api(`/api/forms/${formNumber}`, { method: "DELETE" });
      toast("Form deleted");
      location.hash = "#/requests";
    } catch (err) { toast(err.message); }
  });
}

function sentBlock(inv, guest, link) {
  const viaLabel = inv.sent_via === "SMS" ? "text" : "email";
  const to = inv.sent_via === "SMS" ? guest.phone : guest.email;
  const resp = inv.guest_response;
  return `
    <div class="alert alert-success" role="status" style="margin-bottom:12px">
      <div><b>Invitation sent by ${viaLabel}</b> to ${esc(to)} · ${esc(fmtTime(inv.sent_at))}</div></div>
    ${resp === "Opened Google" ? `<div class="alert alert-success" style="margin-bottom:12px">The guest copied the review and opened your Google page. 🎉</div>` : ""}
    ${resp === "Declined" ? `<div class="alert alert-error" style="margin-bottom:12px">The guest declined. They won't be asked again about this visit.</div>` : ""}
    ${resp === "Pending" ? `<p class="small" style="margin-top:0">Waiting for the guest. Prototype note: delivery is simulated — share this link or QR code to open the guest's view.</p>` : ""}
    <div class="linkbox"><label style="flex:1"><span class="sr-only">Invitation link</span><input type="text" id="link-input" readonly value="${esc(link)}" /></label>
      <button class="btn btn-secondary btn-sm" id="copy-link">Copy</button></div>
    <div class="qr">
      <div class="qr-img" id="qr-img"></div>
      <div class="stack"><a class="btn btn-primary btn-sm" href="${esc(link)}" target="_blank" rel="noopener">Open guest view ↗</a>
        <span class="small">Scan with a phone to try it as the guest.</span></div>
    </div>`;
}

async function saveDraftText(btn, formNumber, text, approve) {
  busy(btn, true, approve ? "Approving…" : "Saving…");
  try {
    await api(`/api/forms/${formNumber}/draft`, { method: "PUT", body: { draft_text: text, approve } });
    toast(approve ? "Draft approved" : "Changes saved");
    renderDetail(formNumber);
  } catch (err) { busy(btn, false); showError($("#draft-err"), err); }
}

function confirmInline(btn, label) {
  if (btn.dataset.confirm === "1") return true;
  btn.dataset.confirm = "1";
  const old = btn.textContent;
  btn.textContent = label;
  setTimeout(() => { btn.dataset.confirm = ""; btn.textContent = old; }, 3000);
  return false;
}

async function copyText(text, input) {
  try { await navigator.clipboard.writeText(text); }
  catch { input?.select(); document.execCommand?.("copy"); }
}

/* ---------------- settings ---------------- */
function renderSettings() {
  const me = state.me;
  shell("settings", `
  <div class="narrow">
    <div class="page-head"><div><h1>Settings</h1><p class="small">Signed in as ${esc(me.manager_name)} (${esc(me.email)})</p></div></div>
    <form class="card stack" id="rest" novalidate>
      <h2>Restaurant</h2>
      <div id="rest-err" hidden></div>
      <label class="field"><span class="label">Restaurant name</span><input type="text" name="restaurant_name" maxlength="100" value="${esc(me.restaurant_name)}" required /></label>
      <label class="field"><span class="label">Google “write a review” link</span>
        <input type="url" name="google_review_link" maxlength="255" placeholder="https://g.page/r/…/review" value="${esc(me.google_review_link || "")}" />
        <span class="hint">In Google Business Profile, choose “Ask for reviews” and copy the link. Guests are sent here to post.</span></label>
      <button class="btn btn-primary" type="submit">Save</button>
    </form>
    <section class="card stack">
      <h2>Demo tools</h2>
      <p class="small" style="margin:0">Adds seven sample guests at every stage — including forms 8 and 15 days old, to show the automatic “On hold” (7 days) and “Archived” (14 days) rules.</p>
      <div><button class="btn btn-secondary" id="seed">Load sample data</button></div>
    </section>
    <button class="btn btn-danger btn-block" id="logout2" style="margin-top:16px">Sign out</button>
  </div>`);
  $("#seed").onclick = (e) => seed(e.currentTarget);
  $("#logout2").onclick = logout;
  const f = $("#rest");
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = f.querySelector("[type=submit]");
    busy(btn, true, "Saving…");
    try {
      await api("/api/restaurant", { method: "PUT", body: Object.fromEntries(new FormData(f)) });
      state.me = await api("/api/me");
      toast("Settings saved");
      renderSettings();
    } catch (err) { busy(btn, false); showError($("#rest-err"), err); }
  };
}

/* ---------------- router ---------------- */
async function router() {
  const h = location.hash || "#/requests";
  if (!state.me) {
    try {
      const me = await api("/api/me");
      state.me = me.signedIn ? me : null;
    } catch { state.me = null; }
  }
  if (h === "#/register") return state.me ? (location.hash = "#/requests") : renderAuth("register");
  if (!state.me) return renderAuth("login");
  if (h === "#/login") return (location.hash = "#/requests");
  let m;
  if (h === "#/new") return renderForm();
  if (h === "#/settings") return renderSettings();
  if ((m = h.match(/^#\/form\/([\w-]+)\/edit$/))) return renderForm(m[1]);
  if ((m = h.match(/^#\/form\/([\w-]+)$/))) return renderDetail(m[1]);
  return renderRequests();
}
window.addEventListener("hashchange", router);
router();
