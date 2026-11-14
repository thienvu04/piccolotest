// Piccolo — guest review page (opened from the invitation link, no login)
const token = location.pathname.split("/").filter(Boolean)[1] || new URLSearchParams(location.search).get("t") || "";
const body = document.getElementById("body");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let data;

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  setTimeout(() => (t.hidden = true), 3000);
}

async function call(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, { ...opts, headers: { "content-type": "application/json" } });
  } catch {
    throw new Error("We couldn't connect. Check your internet and try again.");
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || "Something went wrong. Please try again.");
  return j;
}

async function load() {
  try {
    data = await call(`/api/invite/${encodeURIComponent(token)}`);
  } catch (e) {
    document.getElementById("title").textContent = "Link not found";
    body.innerHTML = `<div class="alert alert-error" role="alert">${esc(e.message)}</div>`;
    return;
  }
  document.getElementById("rname").textContent = data.restaurant_name;
  document.title = `Your review · ${data.restaurant_name}`;
  if (data.guest_response === "Declined") return showDeclined();
  if (data.guest_response === "Opened Google") return showPosted(true);
  showEditor();
}

function showEditor() {
  document.getElementById("title").textContent = `Thanks for visiting, ${data.guest_first_name}!`;
  body.innerHTML = `
    <p style="margin-top:0">You told us what you enjoyed, so we wrote it down as a short review. It's <b>your</b> review — change anything you like.</p>
    <ol class="steps">
      <li><b class="n">1</b><span>Read and edit the review below.</span></li>
      <li><b class="n">2</b><span>Tap the green button. We copy your review and open Google.</span></li>
      <li><b class="n">3</b><span>On Google, pick your stars, paste, and tap <b>Post</b>.</span></li>
    </ol>
    <label class="field"><span class="label">Your review</span>
      <textarea id="text" rows="8" maxlength="4000">${esc(data.text)}</textarea>
      <div class="counter"><span id="cnt">${data.text.length}</span> / 4000</div></label>
    <div id="err" hidden></div>
    <div class="stack" style="margin-top:8px">
      <button class="btn btn-primary btn-block" id="post">Copy review &amp; open Google</button>
      <button class="btn btn-ghost btn-block" id="decline">No thanks</button>
    </div>`;
  const ta = document.getElementById("text");
  ta.oninput = () => (document.getElementById("cnt").textContent = ta.value.length);

  document.getElementById("post").onclick = async (e) => {
    const btn = e.currentTarget;
    const text = ta.value.trim();
    const err = document.getElementById("err");
    if (text.length < 10) {
      err.hidden = false;
      err.innerHTML = `<div class="alert alert-error" role="alert">Your review is a bit short. Add a sentence or two.</div>`;
      return;
    }
    // Copy + open Google inside the tap so browsers allow it.
    const win = window.open(data.google_review_link, "_blank");
    if (win) try { win.opener = null; } catch {}
    const copied = await copyText(text, ta);
    btn.disabled = true;
    try {
      await call(`/api/invite/${encodeURIComponent(token)}/respond`, { method: "POST", body: JSON.stringify({ action: "post", text }) });
      data.text = text;
      showPosted(false, copied, !win);
    } catch (ex) {
      btn.disabled = false;
      err.hidden = false;
      err.innerHTML = `<div class="alert alert-error" role="alert">${esc(ex.message)}</div>`;
    }
  };

  document.getElementById("decline").onclick = () => {
    body.innerHTML = `
      <h2>Skip the review?</h2>
      <p>No problem at all. We won't ask you again about this visit.</p>
      <div id="err" hidden></div>
      <div class="stack"><button class="btn btn-danger btn-block" id="yes">Yes, no thanks</button>
      <button class="btn btn-secondary btn-block" id="back">Go back</button></div>`;
    document.getElementById("back").onclick = showEditor;
    document.getElementById("yes").onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await call(`/api/invite/${encodeURIComponent(token)}/respond`, { method: "POST", body: JSON.stringify({ action: "decline" }) });
        showDeclined();
      } catch (ex) {
        btn.disabled = false;
        const err = document.getElementById("err");
        err.hidden = false;
        err.innerHTML = `<div class="alert alert-error" role="alert">${esc(ex.message)}</div>`;
      }
    };
  };
}

function showPosted(returning, copied = true, blocked = false) {
  document.getElementById("title").textContent = returning ? "Welcome back!" : "Almost done!";
  body.innerHTML = `
    <div style="text-align:center"><div class="big-icon" aria-hidden="true">📋</div>
    <h2>${copied ? "Your review is copied" : "Copy your review below"}</h2>
    <p>On the Google page, choose your stars <span class="stars" aria-hidden="true">★★★★★</span>, press and hold in the text box, tap <b>Paste</b>, then <b>Post</b>.</p></div>
    ${blocked ? `<div class="alert alert-warn" style="margin-bottom:12px">Your browser blocked the Google page. Use the button below.</div>` : ""}
    <label class="field"><span class="label">Your review</span><textarea id="text" rows="6" readonly>${esc(data.text)}</textarea></label>
    <div class="stack" style="margin-top:12px">
      <a class="btn btn-primary btn-block" href="${esc(data.google_review_link)}" target="_blank" rel="noopener">Open Google reviews ↗</a>
      <button class="btn btn-secondary btn-block" id="copy">Copy again</button>
    </div>
    <p class="small" style="text-align:center;margin-top:16px">Thank you from everyone at ${esc(data.restaurant_name)}!</p>`;
  document.getElementById("copy").onclick = async () => {
    const ta = document.getElementById("text");
    toast((await copyText(ta.value, ta)) ? "Review copied" : "Select the text and copy it");
  };
}

function showDeclined() {
  document.getElementById("title").textContent = "Thanks for letting us know";
  body.innerHTML = `<div style="text-align:center"><div class="big-icon" aria-hidden="true">🙏</div>
    <h2>You're all set</h2><p>We won't ask you about this visit again. We hope to see you back at ${esc(data.restaurant_name)} soon!</p></div>`;
}

load();

// Clipboard with a timeout + legacy fallback (some browsers block or stall the async API)
async function copyText(text, ta) {
  try {
    await Promise.race([navigator.clipboard.writeText(text), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1500))]);
    return true;
  } catch {
    try {
      const ro = ta.readOnly;
      ta.readOnly = false; ta.select();
      const ok = document.execCommand("copy");
      ta.readOnly = ro; window.getSelection()?.removeAllRanges();
      return ok;
    } catch { return false; }
  }
}
