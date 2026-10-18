// lawndoctor-caw: customer portal (CAW) registration emails.
// Replaces corporate's AMA "Online Registration Reminder".
// New customers: send 1 at first completed service +3 days, send 2 at +10, send 3 at +24. Stops when registered or dontEmail.
// Existing unregistered active customers: one-time send ("existing" copy), capped per day.
// Runs every 5 minutes and sends at most 3 emails per run, to stay well under Cloudflare's per-run call limit (2026-10-18).
// Settings (shared settings table): caw_mode off|dry-run|live, caw_cutoff, caw_backlog_on, caw_backlog_daily, caw_test, caw_bcc_first.
// Content: data/caw_registration_template.html and data/caw_registration_copy.json in GitHub, cached 30 minutes in D1 content.
// Never reads or stores passwords, card fields or tokens.

const BASE = "https://saapi.realgreen.com";
const RAW = "https://raw.githubusercontent.com/utlawndoctor/lawndoctor-assets/main/";
const BRANCH_PHONE = "385-463-2430";
const ALERT_TO = "ty@utlawndoctor.com";
const TZ = "America/Denver";

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(tick(env)); },
  async fetch() { return new Response("Not found", { status: 404 }); }
};

async function tick(env) {
  let err = "";
  try {
    await schema(env);
    const mode = await sGet(env, "caw_mode", "off");
    if (mode === "off") return;
    try { await processTest(env); } catch (e) { err += "test: " + String(e).slice(0, 200) + " | "; }
    try { await discoverNew(env); } catch (e) { err += "discover: " + String(e).slice(0, 200) + " | "; }
    try { await checkWaiting(env); } catch (e) { err += "waiting: " + String(e).slice(0, 200) + " | "; }
    try { await buildBacklog(env); } catch (e) { err += "backlog: " + String(e).slice(0, 200) + " | "; }
    try { await checkBacklog(env); } catch (e) { err += "check: " + String(e).slice(0, 200) + " | "; }
    try { await sendDue(env, mode); } catch (e) { err += "send: " + String(e).slice(0, 200) + " | "; }
    try { await alerts(env); } catch (e) { err += "alerts: " + String(e).slice(0, 200) + " | "; }
  } catch (e) { err += String(e).slice(0, 300); }
  await sSet(env, "caw_last_tick", new Date().toISOString() + (err ? " ERR " + err : " ok"));
}

async function schema(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS caw_invites (customer_number INTEGER PRIMARY KEY, cohort TEXT, first_done TEXT, state TEXT, sends INTEGER DEFAULT 0, next_due TEXT, last_sent_at TEXT, flags TEXT, created_at TEXT, updated_at TEXT)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS caw_dry (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, customer_number INTEGER, variant TEXT, recipient TEXT, subject TEXT, html TEXT)").run();
}

async function sGet(env, k, d) { const r = await env.DB.prepare("SELECT v FROM settings WHERE k=?").bind(k).first(); return r && r.v !== null && r.v !== "" ? r.v : d; }
async function sSet(env, k, v) { await env.DB.prepare("INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(k, String(v)).run(); }

async function api(env, path) {
  const key = await env.SAAPI_KEY.get();
  const r = await fetch(BASE + path, { headers: { apiKey: key, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error("SAAPI " + r.status + " " + path.split("?")[0]);
  return r.json();
}

function nowIso() { return new Date().toISOString(); }
function trim(s) { return String(s == null ? "" : s).trim(); }
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function denverDate(d) { return new Date(d).toLocaleDateString("en-CA", { timeZone: TZ }); }
function denverHourMin() {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date());
  return (parseInt(p.find(function (x) { return x.type === "hour"; }).value, 10) % 24) * 60 + parseInt(p.find(function (x) { return x.type === "minute"; }).value, 10);
}
// Send window 17:00 to 19:30 Denver, after most of the day's after-service emails have gone out.
function inWindow() { const m = denverHourMin(); return m >= 17 * 60 && m < 19 * 60 + 30; }
// Due timestamp: a calendar date plus N days, at 23:00 UTC (late afternoon Denver).
function dueAfter(dateStr, days) { const d = new Date(String(dateStr).slice(0, 10) + "T23:00:00Z"); d.setUTCDate(d.getUTCDate() + days); return d.toISOString(); }

async function content(env) {
  const get = async function (k, url, json) {
    const row = await env.DB.prepare("SELECT body, fetched_at FROM content WHERE k=?").bind(k).first();
    if (row && row.fetched_at && Date.now() - Date.parse(row.fetched_at) < 30 * 60000) return json ? JSON.parse(row.body) : row.body;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const body = await r.text();
      if (json) JSON.parse(body);
      await env.DB.prepare("INSERT INTO content (k, fetched_at, body) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET fetched_at=excluded.fetched_at, body=excluded.body").bind(k, nowIso(), body).run();
      return json ? JSON.parse(body) : body;
    } catch (e) {
      if (row && row.body) return json ? JSON.parse(row.body) : row.body;
      throw new Error("content " + k + " unavailable: " + String(e).slice(0, 80));
    }
  };
  return { tpl: await get("caw_tpl", RAW + "data/caw_registration_template.html", false), copy: await get("caw_copy", RAW + "data/caw_registration_copy.json", true) };
}

// Picks only the fields this job needs from the customer record.
async function customerFacts(env, n) {
  const c = await api(env, "/Customer/" + n);
  const a = c.address || {};
  const house = trim(a.houseNumber);
  const street = trim(a.streetName);
  const line1 = trim(a.addressLine1) || trim([house, street].join(" "));
  return {
    first: trim(c.firstName),
    email: trim(c.preferredEmail || c.email),
    house: house,
    zip: trim(a.zip).slice(0, 5),
    address: line1 ? line1 + (trim(a.city) ? ", " + trim(a.city) : "") : "",
    status: trim(c.statusCharacter || c.status || "")
  };
}

function render(ct, variant, f, n) {
  const cp = ct.copy[variant];
  if (!cp) throw new Error("no copy for " + variant);
  const fill = function (s) { return String(s).replace(/\{\{FirstName\}\}/g, f.first); };
  let h = ct.tpl.replace(/<!--[\s\S]*?-->/, "");
  const map = { Headline: esc(fill(cp.headline)), Subline: esc(fill(cp.subline)), Intro: esc(fill(cp.intro)), FirstName: esc(f.first), ServiceAddress: esc(f.address), CustomerNumber: esc(String(n)), HouseNumber: esc(f.house), Zip: esc(f.zip), BranchPhone: esc(BRANCH_PHONE) };
  h = h.replace(/\{\{(\w+)\}\}/g, function (m, k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : m; });
  const left = h.match(/\{\{[^}]*\}\}/g);
  if (left) throw new Error("unreplaced placeholders " + left.join(","));
  const text = "Hi " + f.first + ", " + fill(cp.intro) + "\n\nRegister at https://lawndoctorcustomer.com/Account/Register with:\nCustomer number: " + n + "\nHouse number only: " + f.house + "\nZIP code: " + f.zip + "\nEmail address: the one this message was sent to\n\nNeed a hand? Reply to this email or call " + BRANCH_PHONE + ".\n\nLawn Doctor of Provo-Spanish Fork-Orem\n118 W 500 S, Spanish Fork, UT 84660";
  return { subject: fill(cp.subject), html: h, text: text };
}

function images(html) { const out = []; let m; const re = /cid:([\w.\-]+)/g; while ((m = re.exec(html))) if (out.indexOf(m[1]) < 0) out.push(m[1]); return out; }

// Logo images are fetched once and reused for every email (saves 2 outside calls per email).
const IMG = {};

async function mail(env, to, subject, html, text, bcc, tag) {
  const key = await env.MAILGUN_KEY.get();
  const fd = new FormData();
  fd.append("from", "Lawn Doctor <support@utlawndoctor.com>");
  fd.append("to", to);
  if (bcc) fd.append("bcc", bcc);
  fd.append("subject", subject);
  fd.append("html", html);
  if (text) fd.append("text", text);
  if (tag) fd.append("o:tag", tag);
  for (const n of images(html)) {
    if (!IMG[n]) {
      const ir = await fetch(RAW + "images/email/" + n);
      if (!ir.ok) throw new Error("image " + n + " HTTP " + ir.status);
      IMG[n] = await ir.arrayBuffer();
    }
    fd.append("inline", new Blob([IMG[n]], { type: /\.jpe?g$/.test(n) ? "image/jpeg" : "image/png" }), n);
  }
  const r = await fetch("https://api.mailgun.net/v3/utlawndoctor.com/messages", { method: "POST", headers: { Authorization: "Basic " + btoa("api:" + key) }, body: fd, signal: AbortSignal.timeout(30000) });
  const t = await r.text();
  if (!r.ok) throw new Error("Mailgun HTTP " + r.status + " " + t.slice(0, 160));
  try { return JSON.parse(t).id || "ok"; } catch (e) { return "ok"; }
}

async function archive(env, mode, n, to, subject, html, pid) {
  await env.DB.prepare("INSERT INTO sent_messages (sent_at, mode, kind, customer_number, done_date, recipient, subject, body, provider_id, job) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(nowIso(), mode, "email", n, null, to, subject, html, pid, "caw").run();
}

// Test: settings.caw_test = {"to":"ty@utlawndoctor.com","customer":1234}. Sends all four versions with [TEST] subjects, then clears itself.
async function processTest(env) {
  const raw = await sGet(env, "caw_test", "");
  if (!raw) return;
  await sSet(env, "caw_test", "");
  let t; try { t = JSON.parse(raw); } catch (e) { await sSet(env, "caw_test_result", "bad JSON"); return; }
  const out = [];
  try {
    const ct = await content(env);
    const f = await customerFacts(env, t.customer);
    for (const v of ["send1", "send2", "send3", "existing"]) {
      const m = render(ct, v, f, t.customer);
      const pid = await mail(env, t.to, "[TEST " + v + "] " + m.subject, m.html, m.text, null, "caw-test");
      await archive(env, "test", t.customer, t.to, "[TEST " + v + "] " + m.subject, m.html, pid);
      out.push(v + " sent");
    }
  } catch (e) { out.push("error: " + String(e).slice(0, 200)); }
  await sSet(env, "caw_test_result", nowIso() + " " + out.join(", "));
}

// New customers come from the welcome job (wevents kind welcome) on or after caw_cutoff.
async function discoverNew(env) {
  const cutoff = await sGet(env, "caw_cutoff", "2026-10-14");
  await env.DB.prepare("INSERT OR IGNORE INTO caw_invites (customer_number, cohort, state, sends, created_at, updated_at) SELECT DISTINCT customer_number, 'new', 'waiting', 0, ?, ? FROM wevents WHERE kind='welcome' AND state <> 'skipped' AND created_at >= ?").bind(nowIso(), nowIso(), cutoff).run();
}

// Waiting: look for the first completed service. Gives up after 150 days.
async function checkWaiting(env) {
  const rows = (await env.DB.prepare("SELECT customer_number, created_at FROM caw_invites WHERE state='waiting' ORDER BY updated_at LIMIT 5").all()).results;
  for (const r of rows) {
    const list = await api(env, "/Service/Search?CustomerNumber=" + r.customer_number + "&ServiceStatus=S&Records=100");
    const dates = (Array.isArray(list) ? list : []).map(function (s) { return s.doneDate ? String(s.doneDate).slice(0, 10) : ""; }).filter(Boolean).sort();
    if (dates.length) {
      await env.DB.prepare("UPDATE caw_invites SET first_done=?, state='due', next_due=?, updated_at=? WHERE customer_number=?").bind(dates[0], dueAfter(dates[0], 3), nowIso(), r.customer_number).run();
    } else if (Date.now() - Date.parse(r.created_at) > 150 * 86400000) {
      await env.DB.prepare("UPDATE caw_invites SET state='stopped', flags=?, updated_at=? WHERE customer_number=?").bind(JSON.stringify(["no completed service within 150 days"]), nowIso(), r.customer_number).run();
    } else {
      await env.DB.prepare("UPDATE caw_invites SET updated_at=? WHERE customer_number=?").bind(nowIso(), r.customer_number).run();
    }
  }
}

// Existing customers: one pass over active (status 9) customers, queued once as cohort 'backlog'.
async function buildBacklog(env) {
  if ((await sGet(env, "caw_backlog_on", "0")) !== "1") return;
  if ((await sGet(env, "caw_backlog_built", "")) === "done") return;
  const off = parseInt(await sGet(env, "caw_backlog_offset", "0"), 10) || 0;
  const page = await api(env, "/Customer/Search?CustomerStatusMinValue=9&CustomerStatusMaxValue=9&Records=500&Offset=" + off);
  const arr = Array.isArray(page) ? page : [];
  const stmts = [];
  for (const c of arr) {
    const n = Number(c.customerNumber || c.id);
    if (!n) continue;
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO caw_invites (customer_number, cohort, state, sends, next_due, created_at, updated_at) VALUES (?, 'backlog', 'check', 0, ?, ?, ?)").bind(n, nowIso(), nowIso(), nowIso()));
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  if (arr.length < 500) await sSet(env, "caw_backlog_built", "done");
  else await sSet(env, "caw_backlog_offset", String(off + 500));
}

// Screens queued existing customers any time of day: registered or dontEmail are stopped, the rest become due.
async function checkBacklog(env) {
  const rows = (await env.DB.prepare("SELECT customer_number FROM caw_invites WHERE state='check' ORDER BY customer_number LIMIT 15").all()).results;
  const ups = [];
  for (const r of rows) {
    const p = await api(env, "/Customer/" + r.customer_number + "/ContactPreferences");
    const stop = p.cawRegisteredUser === true ? "registered" : (p.dontEmail === true ? "dontEmail" : "");
    ups.push(env.DB.prepare("UPDATE caw_invites SET state=?, flags=?, updated_at=? WHERE customer_number=?").bind(stop ? "stopped" : "due", stop ? JSON.stringify([stop]) : null, nowIso(), r.customer_number));
  }
  if (ups.length) await env.DB.batch(ups);
}

async function emailedToday(env, n) {
  const rows = (await env.DB.prepare("SELECT sent_at FROM sent_messages WHERE customer_number=? AND kind='email' AND mode='live' AND sent_at >= ?").bind(n, new Date(Date.now() - 30 * 3600000).toISOString()).all()).results;
  const today = denverDate(Date.now());
  return rows.some(function (r) { return denverDate(r.sent_at) === today; });
}

function tomorrowDue() { const d = new Date(Date.now() + 86400000); return denverDate(d) + "T23:00:00.000Z"; }

async function sendDue(env, mode) {
  if (!inWindow()) return;
  const daily = parseInt(await sGet(env, "caw_backlog_daily", "50"), 10) || 0;
  const today = denverDate(Date.now());
  const backlogSentToday = mode === "live"
    ? (await env.DB.prepare("SELECT last_sent_at FROM caw_invites WHERE cohort='backlog' AND last_sent_at >= ?").bind(new Date(Date.now() - 30 * 3600000).toISOString()).all()).results.filter(function (r) { return denverDate(r.last_sent_at) === today; }).length
    : (await env.DB.prepare("SELECT at FROM caw_dry WHERE variant='existing' AND at >= ?").bind(new Date(Date.now() - 30 * 3600000).toISOString()).all()).results.filter(function (r) { return denverDate(r.at) === today; }).length;
  let backlogLeft = Math.max(0, daily - backlogSentToday);
  const rows = (await env.DB.prepare("SELECT * FROM caw_invites WHERE state='due' AND next_due <= ? ORDER BY CASE cohort WHEN 'new' THEN 0 ELSE 1 END, next_due, customer_number LIMIT 6").bind(nowIso()).all()).results;
  let done = 0;
  const ct = await content(env);
  const bccFirst = parseInt(await sGet(env, "caw_bcc_first", "3"), 10) || 0;
  for (const r of rows) {
    if (done >= 3) break;
    if (r.cohort === "backlog" && backlogLeft <= 0) continue;
    const n = r.customer_number;
    if (mode === "dry-run") {
      const seen = await env.DB.prepare("SELECT 1 x FROM caw_dry WHERE customer_number=? AND variant=?").bind(n, variantFor(r)).first();
      if (seen) continue;
    } else {
      const cl = await env.DB.prepare("UPDATE caw_invites SET state='sending', updated_at=? WHERE customer_number=? AND state='due'").bind(nowIso(), n).run();
      if (!(cl.meta && cl.meta.changes === 1)) continue;
    }
    const setState = async function (state, flags, extra) {
      if (mode === "dry-run" && state !== "stopped" && state !== "held") return;
      const args = [state, flags ? JSON.stringify(flags) : null, nowIso()].concat(extra ? extra.args : []).concat([n]);
      await env.DB.prepare("UPDATE caw_invites SET state=?, flags=?, updated_at=?" + (extra ? ", " + extra.sql : "") + " WHERE customer_number=?").bind(...args).run();
    };
    try {
      const prefs = await api(env, "/Customer/" + n + "/ContactPreferences");
      if (prefs.cawRegisteredUser === true) { await setState("stopped", ["registered"]); continue; }
      if (prefs.dontEmail === true) { await setState("stopped", ["dontEmail"]); continue; }
      const f = await customerFacts(env, n);
      if (f.status && f.status !== "9") { await setState("stopped", ["customer status " + f.status]); continue; }
      const flags = [];
      const nok = await env.DB.prepare("SELECT 1 x FROM name_ok WHERE customer_number=?").bind(n).first();
      if (!nok && (!f.first || /[\s&\d\/,+]/.test(f.first) || /\band\b/i.test(f.first))) flags.push("name needs review");
      if (!f.email) flags.push("no email address on file");
      if (!f.house) flags.push("no house number");
      if (!f.zip) flags.push("no zip code");
      if (flags.length) { await setState("held", flags); continue; }
      if (await emailedToday(env, n)) {
        if (mode === "live") await setState("due", ["postponed: already emailed today"], { sql: "next_due=?", args: [tomorrowDue()] });
        continue;
      }
      const v = variantFor(r);
      const m = render(ct, v, f, n);
      if (mode === "dry-run") {
        await env.DB.prepare("INSERT INTO caw_dry (at, customer_number, variant, recipient, subject, html) VALUES (?,?,?,?,?,?)").bind(nowIso(), n, v, f.email, m.subject, m.html).run();
        done++; if (r.cohort === "backlog") backlogLeft--;
        continue;
      }
      const liveSent = (await env.DB.prepare("SELECT COUNT(*) c FROM sent_messages WHERE job='caw' AND mode='live'").first()).c;
      const pid = await mail(env, f.email, m.subject, m.html, m.text, liveSent < bccFirst ? ALERT_TO : null, "caw");
      await archive(env, "live", n, f.email, m.subject, m.html, pid);
      const sends = (r.sends || 0) + 1;
      let next = null, state = "done";
      if (r.cohort === "new" && sends < 3) {
        next = dueAfter(r.first_done, sends === 1 ? 10 : 24);
        const minNext = new Date(Date.now() + 5 * 86400000).toISOString();
        if (next < minNext) next = minNext;
        state = "due";
      }
      await setState(state, null, { sql: "sends=?, last_sent_at=?, next_due=?", args: [sends, nowIso(), next] });
      done++; if (r.cohort === "backlog") backlogLeft--;
    } catch (e) {
      if (mode === "live") await setState("due", ["error: " + String(e).slice(0, 150)], { sql: "next_due=?", args: [new Date(Date.now() + 3600000).toISOString()] });
    }
  }
}

function variantFor(r) { return r.cohort === "backlog" ? "existing" : ["send1", "send2", "send3"][Math.min(r.sends || 0, 2)]; }

// One summary email per day when anything is held or erroring.
async function alerts(env) {
  const last = await sGet(env, "caw_alert_last", "");
  if (last && Date.now() - Date.parse(last) < 24 * 3600000) return;
  const held = (await env.DB.prepare("SELECT customer_number, flags FROM caw_invites WHERE state='held' OR flags LIKE '%error:%' LIMIT 50").all()).results;
  if (!held.length) return;
  const body = "<p>Customer portal emails waiting on you:</p><ul>" + held.map(function (h) { return "<li>Customer " + h.customer_number + ": " + esc(h.flags || "") + "</li>"; }).join("") + "</ul><p>Fix the record in RealGreen, then tell Claude to release them.</p>";
  await mail(env, ALERT_TO, "Portal emails held: " + held.length + " customer(s)", body, null, null, "caw-alert");
  await sSet(env, "caw_alert_last", nowIso());
}
