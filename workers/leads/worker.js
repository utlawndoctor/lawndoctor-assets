// lawndoctor-leads: first text to a new RealGreen lead (replaces the Outlook > Zapier > Quo zap, Ty 2026-10-22).
// Every minute: Customer/Search by create date, keep status "0" (lead). One text per lead, from the Quo number.
// Send window 8:00 to 21:00 Denver, every day. Leads after 21:00 get the text at 8:00. A text sent on a Sunday says we'll be in touch Monday.
// Skips: no usable phone, no_text list, dontText, or the Quo number already texted that phone in the last 24 hours.
// A first name that looks wrong (two names, digits, all caps etc. that can't be fixed) gets the version without a name instead of waiting.
// The first run records every lead already in RealGreen as 'baseline' (never texted), so only leads created after go-live get a text.
// Settings (prefix ld_): ld_mode off|dry-run|live, ld_test {"phone","customer"} sends one test text,
//   ld_check "+1..." counts Quo texts to that phone in the last 24h (no send, result in ld_check_result), ld_last_tick.
// Logged to the RealGreen call log by lawndoctor-calllog (job 'leads'). Errors alert Ty at most every 6 hours.

const BASE = "https://saapi.realgreen.com";
const QUO = "https://api.quo.com/v1";
const QUO_FROM = "+13854632430";
const ALERT_TO = "ty@utlawndoctor.com";
const TZ = "America/Denver";
const COPY = {
  named: "{{FirstName}}, thanks for reaching out to Lawn Doctor! We're reviewing your info and will contact you soon. Questions? Just text them here. Reply STOP to opt out.",
  plain: "Thanks for reaching out to Lawn Doctor! We're reviewing your info and will contact you soon. Questions? Just text them here. Reply STOP to opt out.",
  named_sun: "{{FirstName}}, thanks for reaching out to Lawn Doctor! We're reviewing your info and will contact you on Monday. Questions? Just text them here. Reply STOP to opt out.",
  plain_sun: "Thanks for reaching out to Lawn Doctor! We're reviewing your info and will contact you on Monday. Questions? Just text them here. Reply STOP to opt out."
};

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(tick(env)); },
  async fetch() { return new Response("Not found", { status: 404 }); }
};

async function tick(env) {
  let err = "", note = "";
  try {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS leads (customer_number INTEGER PRIMARY KEY, first_seen_at TEXT, state TEXT, tries INTEGER DEFAULT 0, result TEXT, sent_at TEXT)").run();
    const mode = await sGet(env, "ld_mode", "off");
    if (mode === "off") return;
    try { await processTest(env); } catch (e) { err += "test: " + String(e).slice(0, 200) + " | "; }
    try { await processCheck(env); } catch (e) { err += "check: " + String(e).slice(0, 200) + " | "; }
    try { note += "found " + (await discover(env)) + " "; } catch (e) { err += "discover: " + String(e).slice(0, 200) + " | "; }
    try { note += "sent " + (await sendPass(env, mode)); } catch (e) { err += "send: " + String(e).slice(0, 200) + " | "; }
    try { await alerts(env); } catch (e) { err += "alerts: " + String(e).slice(0, 200) + " | "; }
  } catch (e) { err += String(e).slice(0, 300); }
  await sSet(env, "ld_last_tick", new Date().toISOString() + " " + note + (err ? " ERR " + err : " ok"));
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
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function denverDate(d) { return new Date(d).toLocaleDateString("en-CA", { timeZone: TZ }); }
function denverMin() {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date());
  return (parseInt(p.find(function (x) { return x.type === "hour"; }).value, 10) % 24) * 60 + parseInt(p.find(function (x) { return x.type === "minute"; }).value, 10);
}
function denverWeekday() { return new Date().toLocaleDateString("en-US", { timeZone: TZ, weekday: "short" }); }
function toE164(raw) { let d = String(raw == null ? "" : raw).replace(/\D/g, ""); if (d.length === 11 && d[0] === "1") d = d.slice(1); return d.length === 10 ? "+1" + d : ""; }

function pickPhone(c) {
  const cands = (Array.isArray(c.phones) ? c.phones : []).map(function (p) { return { e164: toE164(p && p.number), pref: !!(p && p.isPreferred), type: trim(p && (p.type || p.typeDescription)).toLowerCase() }; }).filter(function (p) { return p.e164; });
  const pref = cands.find(function (p) { return p.pref; }), cell = cands.find(function (p) { return p.type === "cell"; });
  if (pref && pref.type && pref.type !== "cell" && cell) return cell;
  return pref || cell || null;
}

// Returns a clean first name, or "" when it should not be used.
function cleanFirst(raw) {
  let f = trim(raw);
  if (!f || f.length > 20 || /[\s&\d\/,+.@]/.test(f) || /\band\b/i.test(f)) return "";
  if (f === f.toLowerCase() || f === f.toUpperCase()) f = f.charAt(0).toUpperCase() + f.slice(1).toLowerCase();
  return f;
}

function message(first) {
  const sun = denverWeekday() === "Sun";
  if (first) return (sun ? COPY.named_sun : COPY.named).replace("{{FirstName}}", first);
  return sun ? COPY.plain_sun : COPY.plain;
}

// Finds leads created in the last 2 days. Search leaves out leads unless the status range is 0 to 0.
// On the very first run, everything found is baseline (never texted).
async function discover(env) {
  const since = denverDate(Date.now() - 2 * 86400000);
  const list = await api(env, "/Customer/Search?CreatedMinValue=" + since + "&CustomerStatusMinValue=0&CustomerStatusMaxValue=0&Records=500");
  const ids = (Array.isArray(list) ? list : []).filter(function (c) { return trim(c.statusCharacter) === "0" && (c.customerNumber || c.id); }).map(function (c) { return Number(c.customerNumber || c.id); });
  const first = (await sGet(env, "ld_baseline_done", "")) === "";
  const stmts = ids.map(function (n) { return env.DB.prepare("INSERT OR IGNORE INTO leads (customer_number, first_seen_at, state) VALUES (?,?,?)").bind(n, nowIso(), first ? "baseline" : "new"); });
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  if (first) await sSet(env, "ld_baseline_done", nowIso() + " (" + ids.length + " leads)");
  return ids.length;
}

async function quoGet(env, path) {
  const key = await env.QUO_KEY.get();
  const r = await fetch(QUO + path, { headers: { Authorization: key }, signal: AbortSignal.timeout(20000) });
  const t = await r.text();
  if (!r.ok) throw new Error("Quo HTTP " + r.status + " " + t.slice(0, 160));
  return JSON.parse(t);
}

async function quoNumberId(env) {
  const cached = await sGet(env, "ld_quo_pn", "");
  if (cached) return cached;
  const r = await quoGet(env, "/phone-numbers");
  const hit = (r.data || []).find(function (p) { return toE164(p.number) === QUO_FROM || p.number === QUO_FROM; });
  if (!hit) throw new Error("Quo number not found");
  await sSet(env, "ld_quo_pn", hit.id);
  return hit.id;
}

// Number of texts the Quo number sent to this phone in the last 24 hours.
async function recentOutgoing(env, phone) {
  const pn = await quoNumberId(env);
  const after = new Date(Date.now() - 86400000).toISOString();
  const r = await quoGet(env, "/messages?phoneNumberId=" + encodeURIComponent(pn) + "&participants=" + encodeURIComponent(phone) + "&createdAfter=" + encodeURIComponent(after) + "&maxResults=10");
  return (r.data || []).filter(function (m) { return m.direction === "outgoing"; }).length;
}

async function sms(env, to, text) {
  const key = await env.QUO_KEY.get();
  const r = await fetch(QUO + "/messages", { method: "POST", headers: { Authorization: key, "Content-Type": "application/json" }, body: JSON.stringify({ content: text, from: QUO_FROM, to: [to] }), signal: AbortSignal.timeout(20000) });
  const t = await r.text();
  if (!r.ok) throw new Error("Quo HTTP " + r.status + " " + t.slice(0, 160));
  try { return JSON.parse(t).data.id || "ok"; } catch (e) { return "ok"; }
}

async function archive(env, mode, n, to, body, pid) {
  await env.DB.prepare("INSERT INTO sent_messages (sent_at, mode, kind, customer_number, done_date, recipient, subject, body, provider_id, job) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(nowIso(), mode, "sms", n, denverDate(Date.now()), to, null, body, String(pid || ""), "leads").run();
}

async function sendPass(env, mode) {
  const m = denverMin();
  if (m < 8 * 60 || m >= 21 * 60) return 0;
  const rows = (await env.DB.prepare("SELECT * FROM leads WHERE state='new' ORDER BY customer_number LIMIT 5").all()).results;
  let sent = 0;
  for (const L of rows) {
    const set = async function (state, result) { await env.DB.prepare("UPDATE leads SET state=?, result=?, sent_at=? WHERE customer_number=?").bind(state, result, nowIso(), L.customer_number).run(); };
    if (mode === "live") {
      const cl = await env.DB.prepare("UPDATE leads SET state='sending' WHERE customer_number=? AND state='new'").bind(L.customer_number).run();
      if (!(cl.meta && cl.meta.changes === 1)) continue;
    }
    try {
      const c = await api(env, "/Customer/" + L.customer_number);
      if (trim(c.statusCharacter) !== "0") { await set("skipped", "no longer a lead (status " + trim(c.statusCharacter) + ")"); continue; }
      const ph = pickPhone(c);
      if (!ph) { await set("skipped", "no phone"); continue; }
      const nt = await env.DB.prepare("SELECT 1 x FROM no_text WHERE phone=?").bind(ph.e164).first();
      if (nt) { await set("skipped", "no_text list"); continue; }
      let prefs = {}; try { prefs = await api(env, "/Customer/" + L.customer_number + "/ContactPreferences"); } catch (e) {}
      if (prefs.dontText) { await set("skipped", "dontText"); continue; }
      const recent = await recentOutgoing(env, ph.e164);
      if (recent > 0) { await set("skipped", "already texted from Quo in last 24h (" + recent + ")"); continue; }
      const first = cleanFirst(c.firstName);
      const body = message(first);
      if (mode !== "live") { await set("dry", "would text " + ph.e164 + (first ? "" : " (no name)") + ": " + body); sent++; continue; }
      try {
        const pid = await sms(env, ph.e164, body);
        await archive(env, "live", L.customer_number, ph.e164, body, pid);
        await set("sent", "texted " + ph.e164 + (first ? "" : " (no name)"));
        sent++;
      } catch (e) {
        if (/opted out/i.test(String(e))) {
          await env.DB.prepare("INSERT OR IGNORE INTO no_text (phone, note, added_at) VALUES (?,?,?)").bind(ph.e164, "auto: opted out in Quo, lead " + L.customer_number, nowIso()).run();
          await set("skipped", "opted out in Quo (added to no-text list)");
        } else throw e;
      }
    } catch (e) {
      // Retry next minute, up to 5 tries, then stop and alert.
      const tries = (L.tries || 0) + 1;
      await env.DB.prepare("UPDATE leads SET state=?, tries=?, result=? WHERE customer_number=?").bind(tries >= 5 ? "error" : "new", tries, "error: " + String(e).slice(0, 150), L.customer_number).run();
    }
  }
  return sent;
}

async function alerts(env) {
  const last = await sGet(env, "ld_alert_last", "");
  if (last && Date.now() - Date.parse(last) < 6 * 3600000) return;
  const bad = (await env.DB.prepare("SELECT customer_number, result FROM leads WHERE state='error' AND first_seen_at >= ? LIMIT 20").bind(new Date(Date.now() - 3 * 86400000).toISOString()).all()).results;
  if (!bad.length) return;
  const body = "<p>New lead texts that did not go out after 5 tries:</p><ul>" + bad.map(function (b) { return "<li>Lead " + b.customer_number + ": " + esc(b.result || "") + "</li>"; }).join("") + "</ul><p>Text them from Quo yourself, or tell Claude to retry.</p>";
  await mail(env, ALERT_TO, "Lead text failed: " + bad.length, body);
  await sSet(env, "ld_alert_last", nowIso());
}

async function mail(env, to, subject, html) {
  const key = await env.MAILGUN_KEY.get();
  const fd = new FormData();
  fd.append("from", "Lawn Doctor <support@utlawndoctor.com>");
  fd.append("to", to);
  fd.append("subject", subject);
  fd.append("html", html);
  await fetch("https://api.mailgun.net/v3/utlawndoctor.com/messages", { method: "POST", headers: { Authorization: "Basic " + btoa("api:" + key) }, body: fd, signal: AbortSignal.timeout(20000) });
}

// ld_test = {"phone":"+18019139317","customer":2906}: texts the phone with that lead's name, and reports what the checks found.
async function processTest(env) {
  const raw = await sGet(env, "ld_test", "");
  if (!raw) return;
  await sSet(env, "ld_test", "");
  let out = "";
  try {
    const t = JSON.parse(raw);
    const c = await api(env, "/Customer/" + t.customer);
    const ph = pickPhone(c);
    const first = cleanFirst(c.firstName);
    const body = message(first);
    let recent = "n/a";
    try { recent = String(await recentOutgoing(env, t.phone)); } catch (e) { recent = "check failed: " + String(e).slice(0, 120); }
    const pid = await sms(env, t.phone, body);
    await archive(env, "test", Number(t.customer), t.phone, body, pid);
    out = "sent " + pid + " | lead status " + trim(c.statusCharacter) + " | lead phone " + (ph ? ph.e164 + " " + ph.type : "none") + " | name '" + first + "' | Quo texts to test phone in 24h: " + recent + " | body: " + body;
  } catch (e) { out = "ERR " + String(e).slice(0, 300); }
  await sSet(env, "ld_test_result", nowIso() + " " + out);
}

// ld_check = "+18019139317": reports how many texts the Quo number sent that phone in the last 24 hours. Sends nothing.
async function processCheck(env) {
  const phone = await sGet(env, "ld_check", "");
  if (!phone) return;
  await sSet(env, "ld_check", "");
  let out = "";
  try { out = String(await recentOutgoing(env, phone)); } catch (e) { out = "ERR " + String(e).slice(0, 300); }
  await sSet(env, "ld_check_result", nowIso() + " " + phone + ": " + out);
}
