// lawndoctor-billing: past-due reminders, card expiry reminders, ACH gift card detection, daily office list.
// Replaces corporate's AMA "Payment Reminder Email". Design: claude/billing-reminders-plan.md (draft 2).
// Runs once a day in steps (one step per 5 minute tick): snapshot (from 8:00 Denver) > cases > cards > gift > send (from 9:00) > office list.
// Sunday is skipped (Monday covers it). Settings in the shared settings table, all prefixed bill_:
//   bill_mode off|dry-run|live, bill_office_to, bill_test {"to","phone","customer"}, bill_run_now 1 (force today's run now; dry-run safe),
//   bill_exclude [customer numbers] = never message these customers (they still show on the office list as excluded).
// Content: data/billing_reminder_template.html and data/billing_reminder_copy.json in GitHub (cached 30 min in D1 content).
// Never reads or stores passwords, card numbers or tokens. Card type and expiry month are display facts only.

const BASE = "https://saapi.realgreen.com";
const RAW = "https://raw.githubusercontent.com/utlawndoctor/lawndoctor-assets/main/";
const BRANCH_PHONE = "(385) 463-2430";
const QUO_FROM = "+13854632430";
const ALERT_TO = "ty@utlawndoctor.com";
const TZ = "America/Denver";
const CARD_NAMES = { VI: "Visa", MC: "Mastercard", AX: "American Express", DI: "Discover" };

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(tick(env)); },
  async fetch() { return new Response("Not found", { status: 404 }); }
};

async function tick(env) {
  let err = "", step = "";
  try {
    await schema(env);
    const mode = await sGet(env, "bill_mode", "off");
    if (mode === "off") return;
    try { await processTest(env); } catch (e) { err += "test: " + String(e).slice(0, 200) + " | "; }
    step = await runStep(env, mode);
  } catch (e) { err += String(e).slice(0, 300); }
  await sSet(env, "bill_last_tick", new Date().toISOString() + " " + (step || "-") + (err ? " ERR " + err : " ok"));
}

async function schema(env) {
  const s = [
    "CREATE TABLE IF NOT EXISTS bill_day (run_date TEXT, customer_number INTEGER, first TEXT, last TEXT, email TEXT, phone TEXT, phone_type TEXT, address TEXT, net REAL, billing_type TEXT, card_type TEXT, card_exp TEXT, status TEXT, evaluated INTEGER DEFAULT 0, decision TEXT, sent TEXT, PRIMARY KEY (run_date, customer_number))",
    "CREATE TABLE IF NOT EXISTS bill_cust (customer_number INTEGER PRIMARY KEY, billing_type TEXT, card_type TEXT, first_seen TEXT, prev_billing_type TEXT, type_changed_at TEXT, gift_state TEXT, gift_at TEXT)",
    "CREATE TABLE IF NOT EXISTS bill_cases (customer_number INTEGER, oldest_done TEXT, opened_at TEXT, d3_at TEXT, d10_at TEXT, d17_at TEXT, last_amount REAL, closed_at TEXT, PRIMARY KEY (customer_number, oldest_done))",
    "CREATE TABLE IF NOT EXISTS bill_card (customer_number INTEGER, card_exp TEXT, kind TEXT, sent_at TEXT, PRIMARY KEY (customer_number, card_exp, kind))"
  ];
  for (const q of s) await env.DB.prepare(q).run();
  for (const col of ["house", "zip"]) { try { await env.DB.prepare("ALTER TABLE bill_day ADD COLUMN " + col + " TEXT").run(); } catch (e) {} }
}

async function sGet(env, k, d) { const r = await env.DB.prepare("SELECT v FROM settings WHERE k=?").bind(k).first(); return r && r.v !== null && r.v !== "" ? r.v : d; }
async function sSet(env, k, v) { await env.DB.prepare("INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(k, String(v)).run(); }

async function api(env, path, body) {
  const key = await env.SAAPI_KEY.get();
  const opt = { headers: { apiKey: key, Accept: "application/json" }, signal: AbortSignal.timeout(20000) };
  if (body) { opt.method = "POST"; opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  const r = await fetch(BASE + path, opt);
  if (!r.ok) throw new Error("SAAPI " + r.status + " " + path.split("?")[0]);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

function nowIso() { return new Date().toISOString(); }
function trim(s) { return String(s == null ? "" : s).trim(); }
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function money(n) { return "$" + Number(n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
function denverDate(d) { return new Date(d).toLocaleDateString("en-CA", { timeZone: TZ }); }
function denverParts() {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "numeric", weekday: "short", hour12: false }).formatToParts(new Date());
  const g = function (t) { return p.find(function (x) { return x.type === t; }).value; };
  return { min: (parseInt(g("hour"), 10) % 24) * 60 + parseInt(g("minute"), 10), wd: g("weekday") };
}
function daysBetween(fromYmd, toYmd) { return Math.round((Date.parse(toYmd + "T12:00:00Z") - Date.parse(String(fromYmd).slice(0, 10) + "T12:00:00Z")) / 86400000); }
function shortDate(ymd) { return new Date(String(ymd).slice(0, 10) + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }); }
function longDate(ymd) { return new Date(String(ymd).slice(0, 10) + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }); }
function toE164(raw) { let d = String(raw == null ? "" : raw).replace(/\D/g, ""); if (d.length === 11 && d[0] === "1") d = d.slice(1); return d.length === 10 ? "+1" + d : ""; }
function isAscii(s) { return /^[\x20-\x7E]*$/.test(s); }

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
  return { tpl: await get("bill_tpl", RAW + "data/billing_reminder_template.html", false), copy: await get("bill_copy", RAW + "data/billing_reminder_copy.json", true) };
}

// ---------- rendering ----------
function tok(s, t) { return String(s).replace(/\{\{(\w+)\}\}/g, function (m, k) { return Object.prototype.hasOwnProperty.call(t, k) ? t[k] : m; }); }

function strip(color, text) {
  const c = color === "red" ? { bg: "#fde8e6", line: "#e07a6f", ink: "#a1261b" } : { bg: "#fff4dc", line: "#e8b04a", ink: "#8a5a00" };
  return '<tr><td style="background:' + c.bg + ';border-top:3px solid ' + c.line + ';border-bottom:1px solid ' + c.line + ';padding:12px 24px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td valign="middle" style="padding-right:10px;"><div style="width:22px;height:22px;line-height:22px;border-radius:11px;background:' + c.ink + ';color:#ffffff;font-size:14px;font-weight:bold;text-align:center;">!</div></td><td valign="middle" style="color:' + c.ink + ';font-size:13px;font-weight:bold;letter-spacing:0.6px;">' + esc(text) + '</td></tr></table></td></tr>';
}

function cardShell(title, inner) {
  return '<tr><td style="padding:20px 24px 6px 24px;">\n<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:2px solid #008349;border-radius:14px;">\n<tr><td style="background:#008349;padding:12px 22px;border-radius:11px 11px 0 0;">\n<div style="color:#ffffff;font-size:11px;font-weight:bold;letter-spacing:1.2px;">' + esc(title) + '</div>\n</td></tr>\n<tr><td style="padding:16px 22px 18px 22px;">' + inner + '</td></tr>\n</table>\n</td></tr>';
}

function balanceCard(lines, total, today) {
  const rows = lines.map(function (l) {
    const age = daysBetween(l.done, today);
    return '<tr><td style="color:#231f20;font-size:14px;padding:6px 0;border-bottom:1px solid #e3efe7;">' + esc(l.name) + '<div style="color:#777;font-size:12px;">Visit on ' + esc(longDate(l.done)) + ' · ' + age + ' days past due</div></td><td align="right" style="color:#231f20;font-size:14px;padding:6px 0;border-bottom:1px solid #e3efe7;white-space:nowrap;">' + money(l.open) + '</td></tr>';
  }).join("");
  return cardShell("YOUR BALANCE", '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + rows + '<tr><td style="color:#00623a;font-size:14px;font-weight:bold;padding:10px 0 0 0;">Balance due</td><td align="right" style="color:#00623a;font-size:22px;font-weight:bold;padding:10px 0 0 0;">' + money(total) + '</td></tr></table>');
}

function autopayCard(cardType, exp) {
  const row = function (k, v) { return '<tr><td style="color:#555;font-size:12px;padding:3px 0;">' + k + '</td><td align="right" style="color:#231f20;font-size:14px;font-weight:bold;padding:3px 0;">' + esc(v) + '</td></tr>'; };
  return cardShell("YOUR AUTOPAY CARD", '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0f8f3;border-radius:10px;"><tr><td style="padding:14px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + row("Card on file", CARD_NAMES[cardType] || "Card") + row("Expires", exp ? exp.slice(5, 7) + "/" + exp.slice(0, 4) : "") + '</table></td></tr></table>');
}

function achCard(a) {
  return cardShell(a.title, '<div style="color:#231f20;font-size:14px;line-height:1.5;">' + a.body1 + '</div><div style="color:#231f20;font-size:14px;line-height:1.5;margin-top:10px;">' + a.body2 + '</div><div style="color:#888;font-size:11px;margin-top:8px;">' + a.fine + '</div>');
}

// Registered customers get only the call line; others get the registration details (customer number, house number, ZIP).
function portalHelp(p, m) {
  if (m.registered) return '<tr><td style="padding:4px 24px 4px 24px;color:#231f20;font-size:14px;line-height:1.5;">' + esc(p.registered) + '</td></tr>';
  const row = function (k, v) { return '<tr><td style="color:#555555;font-size:12px;padding:3px 0;">' + k + '</td><td align="right" style="color:#231f20;font-size:14px;font-weight:bold;padding:3px 0;">' + esc(v) + '</td></tr>'; };
  const inner = '<div style="color:#231f20;font-size:14px;line-height:1.5;margin-bottom:12px;">' + esc(p.register_intro) + '</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0f8f3;border-radius:10px;"><tr><td style="padding:14px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + row("Customer number", String(m.account)) + (m.house ? row("House number only", m.house) : "") + (m.zip ? row("ZIP code", m.zip) : "") + row("Email address", p.register_email) + '</table></td></tr></table><div style="color:#555555;font-size:12px;line-height:1.5;text-align:center;margin-top:12px;">Already registered? <a href="https://lawndoctorcustomer.com" style="color:#008349;">Log in here</a>. ' + esc(p.register_after) + '</div>';
  return cardShell(p.register_title, inner);
}

// m: {kind, first, account, address, amount, days, lines, visitDate, cardType, cardExp, showAch, registered, house, zip}
function render(ct, m, today) {
  const cp = ct.copy[m.kind];
  if (!cp) throw new Error("no copy for " + m.kind);
  const t = { FirstName: m.first, Amount: money(m.amount), Days: String(m.days || ""), VisitDate: m.visitDate ? shortDate(m.visitDate) : "", CardExp: m.cardExp ? m.cardExp.slice(5, 7) + "/" + m.cardExp.slice(2, 4) : "" };
  const isCard = m.kind === "expiry" || m.kind === "expired";
  const blocks = {
    Preheader: esc(tok(cp.pre, t)), Headline: esc(tok(cp.headline, t)), Subline: esc(tok(cp.subline, t)),
    AccountNumber: esc(String(m.account)), ServiceAddress: esc(m.address), ButtonText: esc(tok(cp.button, t)),
    Intro: esc(tok(cp.intro, t)), Closing: esc(tok(cp.closing, t)),
    STATUS_STRIP: strip(cp.strip, tok(cp.strip_text, t)),
    MAIN_CARD: isCard ? autopayCard(m.cardType, m.cardExp) : balanceCard(m.lines, m.amount, today),
    ACH_CARD: m.showAch ? achCard(ct.copy.ach_card) : "",
    PORTAL_HELP: portalHelp(ct.copy.portal, m),
    ButtonUrl: m.registered ? "https://lawndoctorcustomer.com" : "https://lawndoctorcustomer.com/Account/Register"
  };
  let h = ct.tpl.replace(/<!--[\s\S]*?-->/, "");
  h = h.replace(/\{\{(\w+)\}\}/g, function (x, k) { return Object.prototype.hasOwnProperty.call(blocks, k) ? blocks[k] : x; });
  const left = h.match(/\{\{[^}]*\}\}/g);
  if (left) throw new Error("unreplaced placeholders " + left.join(","));
  let sms = tok(cp.sms, t);
  if (sms.length > 160 || !isAscii(sms)) sms = tok(cp.sms_short, t);
  if (sms.length > 160 || !isAscii(sms)) sms = "";
  const text = tok(cp.intro, t) + "\n\n" + (isCard ? "Card on file expires: " + t.CardExp : "Balance due: " + money(m.amount)) + "\nPay or update at https://lawndoctorcustomer.com or call " + BRANCH_PHONE + ".\nWe will never ask for your card or bank number by email or text.\n\nLawn Doctor of Provo-Spanish Fork-Orem";
  return { subject: tok(cp.subject, t), html: h, sms: sms, text: text };
}

// ---------- senders ----------
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

async function archive(env, mode, kind, n, to, subject, body, pid) {
  await env.DB.prepare("INSERT INTO sent_messages (sent_at, mode, kind, customer_number, done_date, recipient, subject, body, provider_id, job) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(nowIso(), mode, kind, n, null, to, subject, body, String(pid || ""), "billing").run();
}

// ---------- RealGreen reads ----------
function pickPhone(c) {
  const cands = (Array.isArray(c.phones) ? c.phones : []).map(function (p) { return { e164: toE164(p && p.number), pref: !!(p && p.isPreferred), type: trim(p && (p.type || p.typeDescription)).toLowerCase() }; }).filter(function (p) { return p.e164; });
  const pref = cands.find(function (p) { return p.pref; }), cell = cands.find(function (p) { return p.type === "cell"; });
  if (pref && pref.type && pref.type !== "cell" && cell) return cell;
  return pref || cell || null;
}

// Only the fields this job needs are kept.
function facts(c) {
  const a = c.address || {};
  const line1 = trim(a.addressLine1) || trim([trim(a.houseNumber), trim(a.streetName)].join(" "));
  const ph = pickPhone(c);
  return {
    n: Number(c.customerNumber || c.id), first: trim(c.firstName), last: trim(c.lastName), email: trim(c.preferredEmail || c.email),
    phone: ph ? ph.e164 : "", phoneType: ph ? ph.type : "", address: line1 ? line1 + (trim(a.city) ? ", " + trim(a.city) : "") : "",
    net: Number(c.netBalance || 0), billingType: trim(c.billingType), cardType: trim(c.cardType), cardExp: c.cardExpiryDate ? String(c.cardExpiryDate).slice(0, 10) : "",
    status: trim(c.statusCharacter), house: trim(a.houseNumber), zip: trim(a.zip).slice(0, 5)
  };
}

// Unpaid lines for one customer: completed services where charge exceeds what has been applied.
async function openLines(env, n) {
  const list = await api(env, "/Service/Search?CustomerNumber=" + n + "&ServiceStatus=S&Records=200");
  const svcs = (Array.isArray(list) ? list : []).filter(function (s) { return s.doneDate && !s.isReversed; })
    .sort(function (a, b) { return String(b.doneDate).localeCompare(String(a.doneDate)); }).slice(0, 25);
  if (!svcs.length) return [];
  let alloc = null;
  try { alloc = await api(env, "/Service/Allocations", { serviceIDs: svcs.map(function (s) { return s.id; }) }); } catch (e) { alloc = null; }
  const arr = Array.isArray(alloc) ? alloc : (alloc && (alloc.allocations || alloc.items || alloc.results)) || [];
  const by = {};
  for (const x of arr) { const id = x.serviceID || x.serviceId || x.id; if (id) by[id] = x; }
  const out = [];
  for (const s of svcs) {
    const a = by[s.id];
    let open;
    if (a && a.totalServiceCharge != null) open = Number(a.totalServiceCharge || 0) - Number(a.totalApplied || 0);
    else open = s.isPaid ? 0 : Number(s.totalAmount || 0);
    if (open > 0.009) out.push({ id: s.id, done: String(s.doneDate).slice(0, 10), open: Math.round(open * 100) / 100, name: trim(s.serviceLongName) || trim(s.serviceCode), code: trim(s.serviceCode) });
  }
  return out.sort(function (a, b) { return a.done.localeCompare(b.done); });
}

async function prefsOf(env, n) { try { return await api(env, "/Customer/" + n + "/ContactPreferences"); } catch (e) { return {}; } }

// ---------- daily run ----------
async function runStep(env, mode) {
  const today = denverDate(Date.now());
  const p = denverParts();
  const force = (await sGet(env, "bill_run_now", "")) === "1";
  let run = {}; try { run = JSON.parse(await sGet(env, "bill_run", "{}")); } catch (e) { run = {}; }
  if (run.date !== today) {
    if (!force && (p.wd === "Sun" || p.min < 8 * 60 || p.min >= 13 * 60)) return "idle";
    run = { date: today, step: "snapshot", offset: 0, mode: mode };
    await env.DB.prepare("DELETE FROM bill_day WHERE run_date < ?").bind(new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10)).run();
  }
  if (run.step === "done") return "done";
  const save = async function () { await sSet(env, "bill_run", JSON.stringify(run)); };

  if (run.step === "snapshot") {
    const page = await api(env, "/Customer/Search?CustomerStatusMinValue=9&CustomerStatusMaxValue=9&Records=500&Offset=" + run.offset);
    const arr = Array.isArray(page) ? page : [];
    const known = {};
    for (const k of (await env.DB.prepare("SELECT customer_number, billing_type FROM bill_cust").all()).results) known[k.customer_number] = k.billing_type;
    const stmts = [];
    for (const c of arr) {
      const f = facts(c);
      if (!f.n) continue;
      stmts.push(env.DB.prepare("INSERT OR REPLACE INTO bill_day (run_date, customer_number, first, last, email, phone, phone_type, address, net, billing_type, card_type, card_exp, status, evaluated, decision, sent, house, zip) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,NULL,?,?)")
        .bind(today, f.n, f.first, f.last, f.email, f.phone, f.phoneType, f.address, f.net, f.billingType, f.cardType, f.cardExp, f.status, f.house, f.zip));
      if (!(f.n in known)) stmts.push(env.DB.prepare("INSERT INTO bill_cust (customer_number, billing_type, card_type, first_seen) VALUES (?,?,?,?)").bind(f.n, f.billingType, f.cardType, today));
      else if (known[f.n] !== f.billingType) stmts.push(env.DB.prepare("UPDATE bill_cust SET prev_billing_type=?, billing_type=?, card_type=?, type_changed_at=? WHERE customer_number=?").bind(known[f.n], f.billingType, f.cardType, today, f.n));
    }
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    if (arr.length < 500) { run.step = "cases"; run.offset = 0; } else run.offset += 500;
    await save(); return "snapshot " + arr.length;
  }

  if (run.step === "cases") {
    const rows = (await env.DB.prepare("SELECT * FROM bill_day WHERE run_date=? AND net >= 10 AND evaluated=0 ORDER BY customer_number LIMIT 6").bind(today).all()).results;
    for (const r of rows) {
      let d = { list: [] };
      try {
        const lines = await openLines(env, r.customer_number);
        if (!lines.length) d.list.push("nomatch");
        else {
          const oldest = lines[0].done, age = daysBetween(oldest, today);
          await env.DB.prepare("INSERT OR IGNORE INTO bill_cases (customer_number, oldest_done, opened_at) VALUES (?,?,?)").bind(r.customer_number, oldest, nowIso()).run();
          await env.DB.prepare("UPDATE bill_cases SET last_amount=?, closed_at=NULL WHERE customer_number=? AND oldest_done=?").bind(r.net, r.customer_number, oldest).run();
          const cs = await env.DB.prepare("SELECT * FROM bill_cases WHERE customer_number=? AND oldest_done=?").bind(r.customer_number, oldest).first();
          d.oldest = oldest; d.age = age; d.lines = lines;
          let kind = null;
          if (age > 90) d.list.push("over90");
          else if (age >= 17) { if (!cs.d10_at) kind = (r.billing_type === "A" || r.billing_type === "D") ? "d10" : "d10_invoice"; else if (!cs.d17_at && Date.parse(cs.d10_at) <= Date.now() - 7 * 86400000) kind = "d17"; d.list.push("hold"); }
          else if (age >= 10) { if (!cs.d10_at) kind = (r.billing_type === "A" || r.billing_type === "D") ? "d10" : "d10_invoice"; }
          else if (age >= 3) { if (!cs.d3_at) kind = (r.billing_type === "A" || r.billing_type === "D") ? "d3_auto" : "d3_invoice"; }
          if (age >= 4 && age < 17 && age <= 90) d.list.push("call");
          if (kind) d.kind = kind;
        }
      } catch (e) { d.list.push("error"); d.error = String(e).slice(0, 150); }
      await env.DB.prepare("UPDATE bill_day SET evaluated=1, decision=? WHERE run_date=? AND customer_number=?").bind(JSON.stringify(d), today, r.customer_number).run();
    }
    if (rows.length < 6) {
      await env.DB.prepare("UPDATE bill_cases SET closed_at=? WHERE closed_at IS NULL AND customer_number NOT IN (SELECT customer_number FROM bill_day WHERE run_date=? AND net >= 10)").bind(nowIso(), today).run();
      run.step = "cards";
    }
    await save(); return "cases " + rows.length;
  }

  if (run.step === "cards") {
    const month = parseInt(today.slice(5, 7), 10);
    if (month >= 3 && month <= 10) {
      const horizon = new Date(Date.parse(today + "T12:00:00Z") + 45 * 86400000).toISOString().slice(0, 10);
      const rows = (await env.DB.prepare("SELECT * FROM bill_day WHERE run_date=? AND billing_type='A' AND card_exp <> '' AND evaluated=0 AND card_exp <= ? ORDER BY customer_number LIMIT 6").bind(today, horizon).all()).results;
      for (const r of rows) {
        const end = new Date(Date.UTC(parseInt(r.card_exp.slice(0, 4), 10), parseInt(r.card_exp.slice(5, 7), 10), 0)).toISOString().slice(0, 10);
        const kind = end < today ? "expired" : "expiry";
        let d = { list: ["card"] };
        if (end <= horizon) {
          const done = await env.DB.prepare("SELECT 1 x FROM bill_card WHERE customer_number=? AND card_exp=? AND kind=?").bind(r.customer_number, r.card_exp, kind).first();
          let upcoming = false;
          try {
            const sv = await api(env, "/Service/Search?CustomerNumber=" + r.customer_number + "&Records=100");
            const yr = parseInt(today.slice(0, 4), 10);
            upcoming = (Array.isArray(sv) ? sv : []).some(function (s) { return Number(s.serviceYear) === yr && ["Y", "$", "*"].indexOf(trim(s.serviceStatus)) >= 0; });
          } catch (e) { d.error = String(e).slice(0, 100); }
          if (!done && upcoming) { d.kind = kind; d.cardExp = r.card_exp; }
        }
        await env.DB.prepare("UPDATE bill_day SET evaluated=1, decision=? WHERE run_date=? AND customer_number=?").bind(JSON.stringify(d), today, r.customer_number).run();
      }
      if (rows.length === 6) { await save(); return "cards " + rows.length; }
    }
    run.step = "gift"; await save(); return "cards done";
  }

  if (run.step === "gift") {
    const rows = (await env.DB.prepare("SELECT * FROM bill_cust WHERE prev_billing_type='A' AND billing_type='D' AND (gift_state IS NULL OR gift_state='waiting') AND type_changed_at IS NOT NULL LIMIT 6").all()).results;
    const found = [];
    for (const r of rows) {
      let hist = null;
      try { hist = await api(env, "/History/Transaction/Search?CustomerNumbers=" + r.customer_number + "&Records=100"); }
      catch (e) { try { hist = await api(env, "/History/Transaction/Search", { customerNumbers: [r.customer_number] }); } catch (e2) { hist = null; } }
      const rowsH = Array.isArray(hist) ? hist : (hist && (hist.items || hist.results)) || [];
      const pay = rowsH.find(function (h) {
        const pt = trim(h.PaymentType || h.paymentType), code = trim(h.TransactionCode || h.transactionCode), rev = h.IsReversed || h.isReversed;
        const dp = String(h.DateProcessed || h.dateProcessed || "").slice(0, 10);
        return pt === "AC" && code === "P" && !rev && dp && dp >= r.type_changed_at.slice(0, 10) && daysBetween(dp, today) >= 7;
      });
      if (pay) { await env.DB.prepare("UPDATE bill_cust SET gift_state='listed', gift_at=? WHERE customer_number=?").bind(today, r.customer_number).run(); found.push(r.customer_number); }
      else await env.DB.prepare("UPDATE bill_cust SET gift_state='waiting' WHERE customer_number=?").bind(r.customer_number).run();
    }
    run.step = "send"; await save(); return "gift " + found.length;
  }

  if (run.step === "send") {
    if (!force && p.min < 9 * 60) return "waiting for 9:00";
    const ct = await content(env);
    const rows = (await env.DB.prepare("SELECT * FROM bill_day WHERE run_date=? AND decision LIKE '%\"kind\"%' AND sent IS NULL ORDER BY customer_number LIMIT 4").bind(today).all()).results;
    for (const r of rows) {
      const d = JSON.parse(r.decision);
      const res = await sendOne(env, ct, run.mode, r, d, today);
      await env.DB.prepare("UPDATE bill_day SET sent=? WHERE run_date=? AND customer_number=?").bind(res, today, r.customer_number).run();
    }
    if (rows.length < 4) run.step = "office";
    await save(); return "send " + rows.length;
  }

  if (run.step === "office") {
    await officeList(env, run.mode, today, p.wd === "Mon");
    run.step = "done"; await save();
    if (force) await sSet(env, "bill_run_now", "");
    return "office sent";
  }
  return run.step;
}

async function sendOne(env, ct, mode, r, d, today) {
  const n = r.customer_number;
  let excluded = []; try { excluded = JSON.parse(await sGet(env, "bill_exclude", "[]")).map(Number); } catch (e) {}
  if (excluded.indexOf(Number(n)) >= 0) return "excluded by Ty (no message)";
  const prefs = await prefsOf(env, n);
  const nok = await env.DB.prepare("SELECT 1 x FROM name_ok WHERE customer_number=?").bind(n).first();
  if (!nok && (!r.first || /[\s&\d\/,+]/.test(r.first) || /\band\b/i.test(r.first))) return "held: name needs review";
  const m = { kind: d.kind, first: r.first, account: n, address: r.address, amount: r.net, days: d.age, lines: d.lines || [], visitDate: d.oldest, cardType: r.card_type, cardExp: r.card_exp, showAch: r.billing_type === "A" && d.kind !== "d17", registered: prefs.cawRegisteredUser === true, house: r.house || "", zip: r.zip || "" };
  const out = render(ct, m, today);
  const parts = [];
  if (mode === "live") {
    const rows = (await env.DB.prepare("SELECT sent_at FROM sent_messages WHERE customer_number=? AND kind='email' AND mode='live' AND sent_at >= ?").bind(n, new Date(Date.now() - 30 * 3600000).toISOString()).all()).results;
    if (rows.some(function (x) { return denverDate(x.sent_at) === today; })) return "postponed: already emailed today";
  }
  if (r.email && !prefs.dontEmail) {
    if (mode === "live") { const pid = await mail(env, r.email, out.subject, out.html, out.text, "billing"); await archive(env, "live", "email", n, r.email, out.subject, out.html, pid); parts.push("email sent"); }
    else parts.push("email would send");
  } else parts.push(r.email ? "email skipped: dontEmail" : "email skipped: no address");
  const nt = r.phone ? await env.DB.prepare("SELECT 1 x FROM no_text WHERE phone=?").bind(r.phone).first() : null;
  if (r.phone && !nt && !prefs.dontText && out.sms) {
    if (mode === "live") { const pid = await sms(env, r.phone, out.sms); await archive(env, "live", "sms", n, r.phone, null, out.sms, pid); parts.push("text sent"); }
    else parts.push("text would send");
  } else parts.push("text skipped: " + (!r.phone ? "no phone" : nt ? "no_text list" : prefs.dontText ? "dontText" : "too long"));
  if (mode === "live") {
    const col = { d3_auto: "d3_at", d3_invoice: "d3_at", d10: "d10_at", d10_invoice: "d10_at", d17: "d17_at" }[d.kind];
    if (col) await env.DB.prepare("UPDATE bill_cases SET " + col + "=? WHERE customer_number=? AND oldest_done=?").bind(nowIso(), n, d.oldest).run();
    else await env.DB.prepare("INSERT OR IGNORE INTO bill_card (customer_number, card_exp, kind, sent_at) VALUES (?,?,?,?)").bind(n, d.cardExp, d.kind, nowIso()).run();
  }
  return d.kind + ": " + parts.join(", ");
}

// ---------- office list ----------
async function officeList(env, mode, today, monday) {
  const rows = (await env.DB.prepare("SELECT * FROM bill_day WHERE run_date=? AND decision IS NOT NULL").bind(today).all()).results;
  const dec = rows.map(function (r) { let d = {}; try { d = JSON.parse(r.decision); } catch (e) {} return { r: r, d: d }; });
  const name = function (r) { return esc((r.first + " " + r.last).trim() || "(no name)"); };
  const phone = function (r) { return r.phone ? r.phone.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "($1) $2-$3") : ""; };
  const pays = function (r) { return r.billing_type === "A" ? "Autopay card" : r.billing_type === "D" ? "Autopay bank" : "Invoice"; };
  const th = function (cols) { return "<tr>" + cols.map(function (c) { return '<th style="text-align:left;font-size:12px;color:#555;padding:6px 8px;border-bottom:1px solid #ddd;">' + c + "</th>"; }).join("") + "</tr>"; };
  const td = function (v, right) { return '<td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;' + (right ? "text-align:right;" : "") + '">' + v + "</td>"; };
  const table = function (title, cols, list, rowFn, note) {
    if (!list.length) return "";
    return '<h3 style="font-size:15px;margin:22px 0 6px;">' + title + " (" + list.length + ")</h3>" + (note ? '<div style="font-size:12px;color:#666;margin-bottom:6px;">' + note + "</div>" : "") + '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;">' + th(cols) + list.map(rowFn).join("") + "</table>";
  };
  const visitTxt = function (d) { return d.oldest ? esc(shortDate(d.oldest)) + " · " + esc((d.lines || []).map(function (l) { return l.code; }).join(", ")) : ""; };
  const call = dec.filter(function (x) { return (x.d.list || []).indexOf("call") >= 0; });
  const hold = dec.filter(function (x) { return (x.d.list || []).indexOf("hold") >= 0; });
  const over = dec.filter(function (x) { return (x.d.list || []).indexOf("over90") >= 0; });
  const nomatch = dec.filter(function (x) { return (x.d.list || []).indexOf("nomatch") >= 0 || (x.d.list || []).indexOf("error") >= 0; });
  const cards = dec.filter(function (x) { return (x.d.list || []).indexOf("card") >= 0 && x.d.kind; });
  const sent = dec.filter(function (x) { return x.r.sent; });
  const gifts = (await env.DB.prepare("SELECT c.customer_number, d.first, d.last, d.email FROM bill_cust c LEFT JOIN bill_day d ON d.customer_number=c.customer_number AND d.run_date=? WHERE c.gift_state='listed' AND c.gift_at=?").bind(today, today).all()).results;
  let h = '<div style="font-family:Arial,Helvetica,sans-serif;color:#231f20;max-width:760px;">';
  h += '<h2 style="margin:0 0 4px;">Billing list for ' + esc(longDate(today)) + "</h2>";
  h += '<div style="font-size:12px;color:#666;">From the billing reminders system' + (mode !== "live" ? " · <b>DRY RUN: nothing was sent to customers</b>" : "") + "</div>";
  h += table("Call today", ["Customer", "#", "Phone", "Balance", "Oldest visit", "Pays by"], call, function (x) { return "<tr>" + td(name(x.r)) + td(x.r.customer_number) + td(phone(x.r)) + td(money(x.r.net), true) + td(visitTxt(x.d)) + td(pays(x.r)) + "</tr>"; });
  h += table("On hold, do not service", ["Customer", "#", "Phone", "Balance", "Days past due", "Pays by"], hold, function (x) { return "<tr>" + td(name(x.r)) + td(x.r.customer_number) + td(phone(x.r)) + td(money(x.r.net), true) + td(x.d.age) + td(pays(x.r)) + "</tr>"; });
  h += table("Send a $10 Amazon gift card", ["Customer", "#", "Email"], gifts, function (g) { return "<tr>" + td(esc(((g.first || "") + " " + (g.last || "")).trim())) + td(g.customer_number) + td(esc(g.email || "")) + "</tr>"; }, "Switched from card to bank autopay and the first bank payment has cleared 7 days. Listed once, so keep this email until the card is sent.");
  h += table(mode === "live" ? "Messages sent today" : "Messages that would have been sent", ["Customer", "#", "Result"], sent, function (x) { return "<tr>" + td(name(x.r)) + td(x.r.customer_number) + td(esc(x.r.sent)) + "</tr>"; });
  h += table("Balance with no matching unpaid visit (check by hand)", ["Customer", "#", "Balance", "Note"], nomatch, function (x) { return "<tr>" + td(name(x.r)) + td(x.r.customer_number) + td(money(x.r.net), true) + td(esc(x.d.error || "no unpaid visit found")) + "</tr>"; });
  if (cards.length) h += '<h3 style="font-size:15px;margin:22px 0 6px;">Card reminders today (' + cards.length + ")</h3><div style=\"font-size:12px;color:#666;\">Listed so the office knows who may call.</div>";
  if (over.length) h += monday || mode !== "live"
    ? table("Past 90 days, not messaged", ["Customer", "#", "Balance", "Oldest visit"], over, function (x) { return "<tr>" + td(name(x.r)) + td(x.r.customer_number) + td(money(x.r.net), true) + td(visitTxt(x.d)) + "</tr>"; })
    : '<h3 style="font-size:15px;margin:22px 0 6px;">Past 90 days, not messaged (' + over.length + ')</h3><div style="font-size:12px;color:#666;">Full list on Mondays.</div>';
  if (!call.length && !hold.length && !gifts.length && !sent.length && !nomatch.length && !over.length) h += "<p>Nothing to do today.</p>";
  h += "</div>";
  const to = mode === "live" ? await sGet(env, "bill_office_to", "support@utlawndoctor.com") : ALERT_TO;
  await mail(env, to, (mode !== "live" ? "[DRY RUN] " : "") + "Billing list for " + shortDate(today), h, null, "billing-office");
}

// ---------- test ----------
// bill_test = {"to":"ty@utlawndoctor.com","phone":"+18019139317","customer":1256}. Sends every message type with [TEST], using that
// customer's real name, address and open balance where there is one (sample amounts otherwise), then clears itself.
async function processTest(env) {
  const raw = await sGet(env, "bill_test", "");
  if (!raw) return;
  await sSet(env, "bill_test", "");
  const out = [];
  try {
    const t = JSON.parse(raw);
    const ct = await content(env);
    const today = denverDate(Date.now());
    const f = facts(await api(env, "/Customer/" + t.customer));
    let lines = [];
    try { lines = await openLines(env, t.customer); } catch (e) { out.push("lines: " + String(e).slice(0, 80)); }
    const amount = f.net >= 10 ? f.net : 74;
    const prefs = await prefsOf(env, t.customer);
    const reg = prefs.cawRegisteredUser === true;
    if (!lines.length) lines = [{ done: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10), open: amount, name: "Lawn Maintainer #5", code: "M5" }];
    const oldest = lines[0].done;
    const kinds = t.kinds === "all" ? [["d3_auto", reg], ["d3_invoice", reg], ["d10", reg], ["d10_invoice", reg], ["d17", reg], ["expiry", reg], ["expired", reg]] : [["d3_auto", true], ["d3_auto", false]];
    for (const k of kinds) {
      const cardExp = k[0] === "expiry" ? new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 8) + "01" : (k[0] === "expired" ? "2026-08-01" : f.cardExp);
      const m = { kind: k[0], first: f.first, account: t.customer, address: f.address, amount: amount, days: daysBetween(oldest, today), lines: lines, visitDate: oldest, cardType: f.cardType || "VI", cardExp: cardExp, showAch: k[0] !== "d17", registered: k[1], house: f.house, zip: f.zip };
      const r = render(ct, m, today);
      const label = "[TEST " + k[0] + (k[1] ? " registered" : " not registered") + "] ";
      const pid = await mail(env, t.to, label + r.subject, r.html, r.text, "billing-test");
      await archive(env, "test", "email", t.customer, t.to, label + r.subject, r.html, pid);
      if (t.phone && r.sms) { const sid = await sms(env, t.phone, r.sms); await archive(env, "test", "sms", t.customer, t.phone, null, r.sms, sid); }
      out.push(k[0] + " ok (" + r.sms.length + " chars)");
    }
  } catch (e) { out.push("error: " + String(e).slice(0, 200)); }
  await sSet(env, "bill_test_result", nowIso() + " " + out.join(", "));
}
