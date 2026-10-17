// lawndoctor-before-service: visit heads-up email and text.
// Replaces corporate's AMA "Before Service Email" and "Before Service SMS".
// Trigger: a current-year service at status "$" (invoice printed) with a start date of today or later. RealGreen sets startDate to the
// service day when the invoice prints. One message per customer per visit date. Email to everyone with an address (not dontEmail),
// text to everyone with a phone (not dontText, not on the no_text list). No arrival times (routes shift).
// Send window 8:00 to 20:00 Denver; a visit dated today is only announced before 10:00. Settings (shared table, prefix bs_):
//   bs_mode off|dry-run|live, bs_test {"to","phone","customer"}.
// Dry-run marks visits state 'dry'. When switching to live, run: UPDATE bs_visits SET state='new' WHERE state='dry' AND visit_date >= today.
// Content: data/before_service_template.html, data/before_service_copy.json, data/condition_codes_data.json (service_library).

const BASE = "https://saapi.realgreen.com";
const RAW = "https://raw.githubusercontent.com/utlawndoctor/lawndoctor-assets/main/";
const BRANCH_PHONE = "385-463-2430";
const QUO_FROM = "+13854632430";
const ALERT_TO = "ty@utlawndoctor.com";
const TZ = "America/Denver";

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(tick(env)); },
  async fetch() { return new Response("Not found", { status: 404 }); }
};

async function tick(env) {
  let err = "", note = "";
  try {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS bs_visits (customer_number INTEGER, visit_date TEXT, service_ids TEXT, codes TEXT, first_seen_at TEXT, state TEXT, flags TEXT, result TEXT, sent_at TEXT, PRIMARY KEY (customer_number, visit_date))").run();
    const mode = await sGet(env, "bs_mode", "off");
    if (mode === "off") return;
    try { await processTest(env); } catch (e) { err += "test: " + String(e).slice(0, 200) + " | "; }
    try { note += "found " + (await discover(env)) + " "; } catch (e) { err += "discover: " + String(e).slice(0, 200) + " | "; }
    try { note += "sent " + (await sendPass(env, mode)); } catch (e) { err += "send: " + String(e).slice(0, 200) + " | "; }
    try { await alerts(env); } catch (e) { err += "alerts: " + String(e).slice(0, 200) + " | "; }
  } catch (e) { err += String(e).slice(0, 300); }
  await sSet(env, "bs_last_tick", new Date().toISOString() + " " + note + (err ? " ERR " + err : " ok"));
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
function denverMin() {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date());
  return (parseInt(p.find(function (x) { return x.type === "hour"; }).value, 10) % 24) * 60 + parseInt(p.find(function (x) { return x.type === "minute"; }).value, 10);
}
function dayLong(ymd) { return new Date(ymd + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }); }
function dayShort(ymd) { return new Date(ymd + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).replace(/,/g, ""); }
function toE164(raw) { let d = String(raw == null ? "" : raw).replace(/\D/g, ""); if (d.length === 11 && d[0] === "1") d = d.slice(1); return d.length === 10 ? "+1" + d : ""; }
function isAscii(s) { return /^[\x20-\x7E]*$/.test(s); }
function tok(s, t) { return String(s).replace(/\{\{(\w+)\}\}/g, function (m, k) { return Object.prototype.hasOwnProperty.call(t, k) ? t[k] : m; }); }

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
  const lib = await get("bs_lib", RAW + "data/condition_codes_data.json", true);
  return { tpl: await get("bs_tpl", RAW + "data/before_service_template.html", false), copy: await get("bs_copy", RAW + "data/before_service_copy.json", true), lib: lib.service_library || {} };
}

function category(code) {
  if (/^M\d/.test(code)) return "lawn";
  if (/^MC/.test(code)) return "mosquito";
  if (/^PP/.test(code)) return "pest";
  if (/^TS/.test(code)) return "tree";
  if (["CAF", "CAO", "CAS", "COF"].indexOf(code) >= 0) return "aeration";
  if (["OVS", "SSF"].indexOf(code) >= 0) return "seed";
  if (code === "SBO") return "blowout";
  return "";
}

function rowHtml(emoji, text, bold) {
  return '<tr><td width="30" valign="top" style="font-size:18px;line-height:1.4;padding-bottom:10px;">' + emoji + '</td><td style="color:#231f20;font-size:14px;line-height:1.4;padding-bottom:10px;">' + (bold ? "<b>" + esc(text) + "</b>" : esc(text)) + "</td></tr>";
}

function render(ct, v) {
  const cp = ct.copy;
  const t = { FirstName: v.first, VisitDay: dayLong(v.date), VisitShort: dayShort(v.date) };
  const svcRows = v.codes.map(function (c) { const s = ct.lib[c] || {}; return rowHtml(s.emoji || "&#9989;", s.heading || c, true); }).join("");
  const cats = ["general"];
  v.codes.forEach(function (c) { const k = category(c); if (k && cats.indexOf(k) < 0) cats.push(k); });
  const tips = [];
  cats.forEach(function (k) { (cp.prep[k] || []).forEach(function (x) { if (tips.indexOf(x) < 0) tips.push(x); }); });
  const prepRows = tips.map(function (x) { return '<tr><td width="22" valign="top" style="color:#008349;font-size:15px;font-weight:bold;line-height:1.4;">&#10003;</td><td style="color:#231f20;font-size:14px;line-height:1.4;padding-bottom:10px;">' + esc(x) + "</td></tr>"; }).join("");
  const map = { Preheader: esc(tok(cp.pre, t)), Headline: esc(tok(cp.headline, t)), Subline: esc(tok(cp.subline, t)), ServiceAddress: esc(v.address), Intro: esc(tok(cp.intro, t)), After: esc(tok(cp.after, t)), Closing: esc(tok(cp.closing, t)), BranchPhone: esc(BRANCH_PHONE), SERVICE_ROWS: svcRows, PREP_ROWS: prepRows };
  let h = ct.tpl.replace(/<!--[\s\S]*?-->/, "");
  h = h.replace(/\{\{(\w+)\}\}/g, function (m, k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : m; });
  const left = h.match(/\{\{[^}]*\}\}/g);
  if (left) throw new Error("unreplaced placeholders " + left.join(","));
  let sms = tok(cp.sms, t);
  if (sms.length > 160 || !isAscii(sms)) sms = tok(cp.sms_short, t);
  if (sms.length > 160 || !isAscii(sms)) sms = "";
  const text = tok(cp.intro, t) + "\n\n" + v.codes.map(function (c) { return "- " + ((ct.lib[c] || {}).heading || c); }).join("\n") + "\n\nHelpful prep:\n" + tips.map(function (x) { return "- " + x; }).join("\n") + "\n\n" + tok(cp.closing, t) + "\n\nLawn Doctor of Provo-Spanish Fork-Orem";
  return { subject: tok(cp.subject, t), html: h, sms: sms, text: text };
}

function images(html) { const out = []; let m; const re = /cid:([\w.\-]+)/g; while ((m = re.exec(html))) if (out.indexOf(m[1]) < 0) out.push(m[1]); return out; }

async function mail(env, to, subject, html, text, tag) {
  const key = await env.MAILGUN_KEY.get();
  const fd = new FormData();
  fd.append("from", "Lawn Doctor <support@utlawndoctor.com>");
  fd.append("to", to);
  fd.append("subject", subject);
  fd.append("html", html);
  if (text) fd.append("text", text);
  if (tag) fd.append("o:tag", tag);
  for (const n of images(html)) {
    const ir = await fetch(RAW + "images/email/" + n);
    if (!ir.ok) throw new Error("image " + n + " HTTP " + ir.status);
    fd.append("inline", new Blob([await ir.arrayBuffer()], { type: /\.jpe?g$/.test(n) ? "image/jpeg" : "image/png" }), n);
  }
  const r = await fetch("https://api.mailgun.net/v3/utlawndoctor.com/messages", { method: "POST", headers: { Authorization: "Basic " + btoa("api:" + key) }, body: fd, signal: AbortSignal.timeout(30000) });
  const t = await r.text();
  if (!r.ok) throw new Error("Mailgun HTTP " + r.status + " " + t.slice(0, 160));
  try { return JSON.parse(t).id || "ok"; } catch (e) { return "ok"; }
}

async function sms(env, to, text) {
  const key = await env.QUO_KEY.get();
  const r = await fetch("https://api.quo.com/v1/messages", { method: "POST", headers: { Authorization: key, "Content-Type": "application/json" }, body: JSON.stringify({ content: text, from: QUO_FROM, to: [to] }), signal: AbortSignal.timeout(20000) });
  const t = await r.text();
  if (!r.ok) throw new Error("Quo HTTP " + r.status + " " + t.slice(0, 160));
  try { return JSON.parse(t).data.id || "ok"; } catch (e) { return "ok"; }
}

async function archive(env, mode, kind, n, date, to, subject, body, pid) {
  await env.DB.prepare("INSERT INTO sent_messages (sent_at, mode, kind, customer_number, done_date, recipient, subject, body, provider_id, job) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(nowIso(), mode, kind, n, date, to, subject, body, String(pid || ""), "before-service").run();
}

function pickPhone(c) {
  const cands = (Array.isArray(c.phones) ? c.phones : []).map(function (p) { return { e164: toE164(p && p.number), pref: !!(p && p.isPreferred), type: trim(p && (p.type || p.typeDescription)).toLowerCase() }; }).filter(function (p) { return p.e164; });
  return cands.find(function (p) { return p.pref; }) || cands.find(function (p) { return p.type === "cell"; }) || null;
}

async function customerFacts(env, n) {
  const c = await api(env, "/Customer/" + n);
  const a = c.address || {};
  const line1 = trim(a.addressLine1) || trim([trim(a.houseNumber), trim(a.streetName)].join(" "));
  const ph = pickPhone(c);
  return { first: trim(c.firstName), email: trim(c.preferredEmail || c.email), phone: ph ? ph.e164 : "", address: line1 ? line1 + (trim(a.city) ? ", " + trim(a.city) : "") : "" };
}

// Finds printed visits dated today or later and records one row per customer per visit date.
async function discover(env) {
  const today = denverDate(Date.now());
  const yr = parseInt(today.slice(0, 4), 10);
  const list = await api(env, "/Service/Search?ServiceStatus=%24&StartDateMinValue=" + today + "&Records=500");
  const groups = {};
  for (const s of (Array.isArray(list) ? list : [])) {
    if (Number(s.serviceYear) !== yr || !s.startDate || s.doneDate) continue;
    const date = String(s.startDate).slice(0, 10);
    if (date < today) continue;
    const key = s.customerNumber + "|" + date;
    (groups[key] = groups[key] || { n: s.customerNumber, date: date, ids: [], codes: [] });
    groups[key].ids.push(s.id);
    const code = trim(s.serviceCode);
    if (code && groups[key].codes.indexOf(code) < 0) groups[key].codes.push(code);
  }
  const stmts = [];
  for (const k of Object.keys(groups)) {
    const g = groups[k];
    stmts.push(env.DB.prepare("INSERT INTO bs_visits (customer_number, visit_date, service_ids, codes, first_seen_at, state) VALUES (?,?,?,?,?, 'new') ON CONFLICT(customer_number, visit_date) DO UPDATE SET service_ids=excluded.service_ids, codes=CASE WHEN bs_visits.state='new' THEN excluded.codes ELSE bs_visits.codes END").bind(g.n, g.date, JSON.stringify(g.ids), JSON.stringify(g.codes), nowIso()));
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return stmts.length;
}

async function sendPass(env, mode) {
  const m = denverMin();
  if (m < 8 * 60 || m >= 20 * 60) return 0;
  const today = denverDate(Date.now());
  // Wait 10 minutes after first seeing a visit, so a whole route's invoices finish printing first.
  const rows = (await env.DB.prepare("SELECT * FROM bs_visits WHERE state='new' AND first_seen_at <= ? ORDER BY visit_date, customer_number LIMIT 5").bind(new Date(Date.now() - 10 * 60000).toISOString()).all()).results;
  if (!rows.length) return 0;
  const ct = await content(env);
  let n = 0;
  for (const v of rows) {
    const set = async function (state, flags, result) { await env.DB.prepare("UPDATE bs_visits SET state=?, flags=?, result=?, sent_at=? WHERE customer_number=? AND visit_date=?").bind(state, flags ? JSON.stringify(flags) : null, result || null, state === "sent" || state === "dry" ? nowIso() : null, v.customer_number, v.visit_date).run(); };
    if (v.visit_date < today || (v.visit_date === today && m >= 10 * 60)) { await set("skipped", ["too late to announce"]); continue; }
    if (mode === "live") {
      const cl = await env.DB.prepare("UPDATE bs_visits SET state='sending' WHERE customer_number=? AND visit_date=? AND state='new'").bind(v.customer_number, v.visit_date).run();
      if (!(cl.meta && cl.meta.changes === 1)) continue;
    }
    try {
      const f = await customerFacts(env, v.customer_number);
      const nok = await env.DB.prepare("SELECT 1 x FROM name_ok WHERE customer_number=?").bind(v.customer_number).first();
      if (!nok && (!f.first || /[\s&\d\/,+]/.test(f.first) || /\band\b/i.test(f.first))) { await set("held", ["name needs review"]); continue; }
      let prefs = {}; try { prefs = await api(env, "/Customer/" + v.customer_number + "/ContactPreferences"); } catch (e) {}
      const out = render(ct, { first: f.first, address: f.address, date: v.visit_date, codes: JSON.parse(v.codes || "[]") });
      const parts = [];
      if (f.email && !prefs.dontEmail) {
        if (mode === "live") { const pid = await mail(env, f.email, out.subject, out.html, out.text, "before-service"); await archive(env, "live", "email", v.customer_number, v.visit_date, f.email, out.subject, out.html, pid); parts.push("email sent"); }
        else parts.push("email would send");
      } else parts.push(f.email ? "email skipped: dontEmail" : "email skipped: no address");
      const nt = f.phone ? await env.DB.prepare("SELECT 1 x FROM no_text WHERE phone=?").bind(f.phone).first() : null;
      if (f.phone && !nt && !prefs.dontText && out.sms) {
        if (mode === "live") { const pid = await sms(env, f.phone, out.sms); await archive(env, "live", "sms", v.customer_number, v.visit_date, f.phone, null, out.sms, pid); parts.push("text sent"); }
        else parts.push("text would send");
      } else parts.push("text skipped: " + (!f.phone ? "no phone" : nt ? "no_text list" : prefs.dontText ? "dontText" : "too long"));
      await set(mode === "live" ? "sent" : "dry", null, parts.join(", "));
      n++;
    } catch (e) {
      await set(mode === "live" ? "error" : "dry", ["error: " + String(e).slice(0, 150)]);
    }
  }
  return n;
}

async function alerts(env) {
  const last = await sGet(env, "bs_alert_last", "");
  if (last && Date.now() - Date.parse(last) < 6 * 3600000) return;
  const bad = (await env.DB.prepare("SELECT customer_number, visit_date, state, flags FROM bs_visits WHERE state IN ('held','error') AND visit_date >= ? LIMIT 50").bind(denverDate(Date.now())).all()).results;
  if (!bad.length) return;
  const body = "<p>Visit heads-up messages that did not go out:</p><ul>" + bad.map(function (b) { return "<li>Customer " + b.customer_number + ", visit " + b.visit_date + ": " + esc(b.state + " " + (b.flags || "")) + "</li>"; }).join("") + "</ul><p>Fix the record in RealGreen, then tell Claude to release them.</p>";
  await mail(env, ALERT_TO, "Visit heads-up held: " + bad.length, body, null, "before-service-alert");
  await sSet(env, "bs_alert_last", nowIso());
}

// bs_test = {"to":"ty@utlawndoctor.com","phone":"+18019139317","customer":1328}. Uses that customer's printed visit if there is one.
async function processTest(env) {
  const raw = await sGet(env, "bs_test", "");
  if (!raw) return;
  await sSet(env, "bs_test", "");
  const out = [];
  try {
    const t = JSON.parse(raw);
    const ct = await content(env);
    const f = await customerFacts(env, t.customer);
    const row = await env.DB.prepare("SELECT visit_date, codes FROM bs_visits WHERE customer_number=? ORDER BY visit_date DESC LIMIT 1").bind(t.customer).first();
    const date = row ? row.visit_date : new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const codes = row ? JSON.parse(row.codes || "[]") : ["M6"];
    const r = render(ct, { first: f.first, address: f.address, date: date, codes: codes });
    const pid = await mail(env, t.to, "[TEST] " + r.subject, r.html, r.text, "before-service-test");
    await archive(env, "test", "email", t.customer, date, t.to, "[TEST] " + r.subject, r.html, pid);
    out.push("email ok");
    if (t.phone && r.sms) { const sid = await sms(env, t.phone, r.sms); await archive(env, "test", "sms", t.customer, date, t.phone, null, r.sms, sid); out.push("text ok (" + r.sms.length + " chars)"); }
  } catch (e) { out.push("error: " + String(e).slice(0, 200)); }
  await sSet(env, "bs_test_result", nowIso() + " " + out.join(", "));
}
