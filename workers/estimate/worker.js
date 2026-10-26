// lawndoctor-estimate: quote email for customers RealGreen puts at status 3 ("Gave Estimate - Follow up").
// Approved by Ty 2026-10-26.
//
// Trigger: a customer's status becomes 3. 10 minute settle so the office can finish entering the program.
// Send 1 goes out right away (inside the send window), one follow up on day 4, price expires on day 7.
// Prices come from the service rows RealGreen already has on the program:
//   gross  = sum of service.price        (before discount)
//   net    = sum of service.totalAmount  (after discount)   <- this is what we quote
//   prepay = net less 5%, calculated here (RealGreen does not store it)
// Per service, never "per visit": Lawn Maintainer round 3 bundles grub control into one visit and bills two services.
//
// Guards: nothing sent to anyone already at status 3 before est_cutoff (the stale backlog), and never a program
// from a past season. An unmapped service code holds rather than guessing a program name.
//
// Settings (shared settings table): est_mode off|dry-run|live, est_cutoff, est_seed, est_test, est_bcc_first,
// est_exclude (JSON array of customer numbers), est_followup_days, est_expiry_days.
// Content: data/estimate_template.html, data/estimate_copy.json, welcome/service_code_map.json. Cached 30 min in D1 content.
// Never reads or stores passwords, card fields, bank fields or tokens.

const BASE = "https://saapi.realgreen.com";
const RAW = "https://raw.githubusercontent.com/utlawndoctor/lawndoctor-assets/main/";
const BRANCH_PHONE = "385-463-2430";
const ALERT_TO = "ty@utlawndoctor.com";
const TZ = "America/Denver";
const PREPAY_PCT = 5;

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(tick(env)); },
  async fetch() { return new Response("Not found", { status: 404 }); }
};

async function tick(env) {
  let err = "";
  try {
    await schema(env);
    const mode = await sGet(env, "est_mode", "off");
    if (mode === "off") return;
    try { await processTest(env); } catch (e) { err += "test: " + String(e).slice(0, 200) + " | "; }
    try { await discover(env); } catch (e) { err += "discover: " + String(e).slice(0, 200) + " | "; }
    try { await evaluate(env); } catch (e) { err += "evaluate: " + String(e).slice(0, 200) + " | "; }
    try { await sendDue(env, mode); } catch (e) { err += "send: " + String(e).slice(0, 200) + " | "; }
    try { await sweep(env); } catch (e) { err += "sweep: " + String(e).slice(0, 200) + " | "; }
    try { await alerts(env); } catch (e) { err += "alerts: " + String(e).slice(0, 200) + " | "; }
  } catch (e) { err += String(e).slice(0, 300); }
  await sSet(env, "est_last_tick", new Date().toISOString() + (err ? " ERR " + err : " ok"));
}

async function schema(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS est_quotes (customer_number INTEGER PRIMARY KEY, state TEXT, first_seen TEXT, settle_at TEXT, sends INTEGER DEFAULT 0, next_due TEXT, expires_at TEXT, quote TEXT, flags TEXT, last_sent_at TEXT, last_check TEXT, created_at TEXT, updated_at TEXT)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS est_dry (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, customer_number INTEGER, variant TEXT, recipient TEXT, subject TEXT, total TEXT, html TEXT)").run();
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
function arr(x) { return Array.isArray(x) ? x : []; }
function denverDate(d) { return new Date(d).toLocaleDateString("en-CA", { timeZone: TZ }); }
function denverYear(d) { return parseInt(denverDate(d).slice(0, 4), 10); }
function denverHourMin() {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date());
  return (parseInt(p.find(function (x) { return x.type === "hour"; }).value, 10) % 24) * 60 + parseInt(p.find(function (x) { return x.type === "minute"; }).value, 10);
}
// Same window as the other customer-facing jobs.
function inWindow() { const m = denverHourMin(); return m >= 8 * 60 && m < 20 * 60; }
function longDate(iso) { return new Date(iso).toLocaleDateString("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric", year: "numeric" }); }
function shortDate(iso) { return new Date(iso).toLocaleDateString("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric" }); }
function money(cents) {
  const neg = cents < 0;
  const s = (Math.abs(cents) / 100).toFixed(2);
  const parts = s.split(".");
  return (neg ? "-$" : "$") + parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + parts[1];
}
// Service prices arrive as dollars; work in cents so the 5% never drifts.
function cents(v) { return Math.round((Number(v) || 0) * 100); }

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
  return {
    tpl: await get("est_tpl", RAW + "data/estimate_template.html", false),
    copy: await get("est_copy", RAW + "data/estimate_copy.json", true),
    names: await get("w_names", RAW + "welcome/service_code_map.json", true)
  };
}

// Program display name from the service code already confirmed by Ty in welcome/service_code_map.json.
// Exact code first, then the family prefix. Anything unknown returns "" and the quote is held, never guessed.
function programName(names, code) {
  const c = trim(code).toUpperCase();
  if (!c) return "";
  if (names[c]) return names[c];
  const fam = [["M", "LMP"], ["PP", "PPP"], ["TS", "TSP"], ["MC", "MCP"], ["HG", "HGP"], ["SE", "SEP"], ["BW", "BWC"], ["OW", "OLC"], ["OL", "OLC"], ["FC", "FCP"], ["FS", "FCP"], ["GC", "GCC"], ["PS", "PSS"]];
  for (const f of fam) {
    if (c.indexOf(f[0]) === 0 && /^\d*$/.test(c.slice(f[0].length)) && names[f[1]]) return names[f[1]];
  }
  return "";
}

const DESCRIPTIONS = {
  "Lawn Maintainer Program": "6 visits covering 7 services, spaced 5 to 7 weeks apart from March through November. Round 3 adds grub control to the same visit.",
  "Perimeter Pest Program": "6 exterior visits a year. We treat the foundation line, doors, lower windows and window wells, and knock down any wasp nests we can safely reach. Exterior only, we never need to come inside.",
  "Tree & Shrub Program": "Fertilizing treatments for root development and color, insect and disease control for common Utah pests, and dormant oil applications that target overwintering insects and eggs.",
  "Mosquito Control Program": "Targets shaded foliage, under-deck areas and the other spots mosquitoes rest in, with a blanket lawn and bush spray.",
  "Soil Enrichment Program": "Improves turf health by boosting microbial activity and nutrient uptake. Applied on rounds 3 and 4 of the Lawn Maintainer Program.",
  "Hydraguard Program": "Helps the soil hold moisture at the roots, improving turf health and seed germination, and can reduce watering needs by up to 50% for about 3 months.",
  "Bed Weed Control": "A pre-emergent plus a selective herbicide on flower beds for the first round, then a selective herbicide on later rounds to keep the beds weed free.",
  "Off Lawn Weed Control": "Weed control for the areas off the lawn, such as rock, gravel, fence lines and driveway cracks.",
  "Fungus Control Program": "Preventive and curative fungicide applications for the lawn diseases common in Utah County."
};

// Everything the quote email needs, and nothing else from the customer record.
async function customerFacts(env, n) {
  const c = await api(env, "/Customer/" + n);
  const a = c.address || {};
  const house = trim(a.houseNumber);
  const pre = trim(a.preDirection);
  const street = trim(a.streetName);
  const post = trim(a.postDirection);
  const suffix = trim(a.streetSuffix);
  const line1 = trim(a.addressLine1) || [house, pre, street, suffix, post].filter(Boolean).join(" ");
  const sizeK = Number(c.size) || 0;
  return {
    first: trim(c.firstName),
    email: trim(c.preferredEmail || c.email),
    street: line1,
    address: line1 ? line1 + (trim(a.city) ? ", " + trim(a.city) : "") : "",
    // size is in thousands of square feet, and only counts when the office actually measured it.
    size: sizeK > 0 && trim(c.sizeSource).toUpperCase() === "M" ? Math.round(sizeK * 1000) : 0,
    status: trim(c.statusCharacter || c.status || "")
  };
}

// Builds the priced quote from the program and its service rows. Returns {programs:[], netCents, grossCents} or a hold reason.
async function buildQuote(env, n, names) {
  const year = denverYear(Date.now());
  const programs = arr(await api(env, "/Program/Search?CustomerNumber=" + n));
  const services = arr(await api(env, "/Service/Search?CustomerNumber=" + n + "&Records=300"));
  const out = [];
  let netTotal = 0, grossTotal = 0;
  for (const p of programs) {
    if (p.cancelDate) continue;
    if ((Number(p.season) || 0) < year) continue;
    const rows = services.filter(function (s) {
      return Number(s.programID) === Number(p.id) && !s.isReversed && (Number(s.serviceYear) || 0) >= year;
    });
    if (!rows.length) continue;
    let gross = 0, net = 0;
    for (const s of rows) { gross += cents(s.price); net += cents(s.totalAmount); }
    if (net <= 0) continue;
    const code = trim(rows[0].serviceCode);
    const name = programName(names, code);
    if (!name) return { hold: "unmapped service code " + (code || "(blank)") + " on program " + p.id };
    out.push({
      name: name,
      desc: DESCRIPTIONS[name] || "",
      count: rows.length,
      perService: Math.round(net / rows.length),
      gross: gross,
      net: net,
      discount: gross - net
    });
    netTotal += net;
    grossTotal += gross;
  }
  if (!out.length) return { hold: "no current-season priced program" };
  return { programs: out, netCents: netTotal, grossCents: grossTotal };
}

function programRowsHtml(q) {
  return q.programs.map(function (p) {
    const priceCell = p.discount > 0
      ? '<div style="color:#888888;font-size:11px;white-space:nowrap;"><span style="text-decoration:line-through;">' + money(p.gross) + '</span>&nbsp; ' + money(p.net) + ' for the season</div>'
      : '<div style="color:#888888;font-size:11px;white-space:nowrap;">' + money(p.net) + ' for the season</div>';
    const discountChip = p.discount > 0
      ? '<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr><td style="background:#f0f8f3;border-radius:6px;padding:5px 10px;color:#00623a;font-size:12px;font-weight:bold;">Discount applied: &#8722;' + money(p.discount) + '</td></tr></table>'
      : "";
    const desc = p.desc ? '<div style="color:#555555;font-size:13px;margin-top:3px;line-height:1.45;">' + esc(p.desc) + '</div>' : "";
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">' +
      '<tr>' +
      '<td width="32" valign="top"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="26" height="26" align="center" valign="middle" style="background:#008349;border-radius:13px;color:#ffffff;font-size:14px;font-weight:bold;">&#10003;</td></tr></table></td>' +
      '<td style="padding-left:12px;" valign="top">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
      '<td valign="top"><div style="font-weight:bold;color:#231f20;font-size:17px;">' + esc(p.name) + '</div></td>' +
      '<td width="150" align="right" valign="top">' +
      '<div style="font-weight:bold;color:#008349;font-size:15px;white-space:nowrap;">' + money(p.perService) + '/service</div>' +
      priceCell +
      '</td></tr></table>' +
      desc + discountChip +
      '</td></tr></table>';
  }).join("");
}

function step(num, html) {
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px;"><tr>' +
    '<td width="32" valign="top"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="26" height="26" align="center" valign="middle" style="background:#008349;border-radius:13px;color:#ffffff;font-size:13px;font-weight:bold;">' + num + '</td></tr></table></td>' +
    '<td style="padding-left:12px;color:#231f20;font-size:14px;line-height:1.5;" valign="top">' + html + '</td>' +
    '</tr></table>';
}

function render(ct, variant, f, q, expiresAt) {
  const cp = ct.copy[variant];
  if (!cp) throw new Error("no copy for " + variant);
  const multi = q.programs.length > 1;
  const prepay = Math.round(q.netCents * (100 - PREPAY_PCT) / 100);
  const saves = q.netCents - prepay;
  const sizeClause = f.size
    ? String(multi ? ct.copy.size_clause_multi : ct.copy.size_clause).replace("{{LawnSize}}", f.size.toLocaleString("en-US") + " sq ft")
    : "";

  const fill = function (s) {
    return String(s)
      .replace(/\{\{FirstName\}\}/g, f.first)
      .replace(/\{\{Street\}\}/g, f.street)
      .replace(/\{\{BranchPhone\}\}/g, BRANCH_PHONE)
      .replace(/\{\{ExpiryShort\}\}/g, shortDate(expiresAt))
      .replace(/\{\{ExpiryLong\}\}/g, longDate(expiresAt))
      .replace(/\{\{SizeClause\}\}/g, sizeClause);
  };

  const expiryBlock = variant === "followup"
    ? '<tr><td style="padding:16px 24px 6px 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff8e6;border:2px solid #b4790b;border-radius:14px;"><tr><td style="padding:16px 20px;">' +
      '<div style="color:#231f20;font-size:15px;font-weight:bold;margin-bottom:4px;">' + esc(fill(ct.copy.expiry_box_title)) + '</div>' +
      '<div style="color:#555555;font-size:13px;line-height:1.45;">' + esc(fill(ct.copy.expiry_box_body)) + '</div>' +
      '</td></tr></table></td></tr>'
    : '<tr><td style="padding:14px 24px 4px 24px;color:#231f20;font-size:13px;text-align:center;font-weight:bold;">' + esc(fill(ct.copy.expiry_line)) + '</td></tr>';

  const ctaBlock = variant === "followup"
    ? '<div style="color:#231f20;font-size:14px;line-height:1.5;">' + esc(fill(ct.copy.cta_followup)) + '</div>'
    : step(1, esc(fill(multi ? ct.copy.cta_send1_multi : ct.copy.cta_send1_single))) + step(2, esc(fill(ct.copy.cta_phone)));

  const map = {
    Preheader: esc(fill(cp.preheader)),
    Headline: fill(cp.headline),
    Subline: esc(fill(cp.subline)),
    Intro: esc(fill(cp.intro)),
    ServiceAddress: esc(f.address),
    PROGRAM_ROWS: programRowsHtml(q),
    SeasonTotal: money(q.netCents),
    PrepayNote: esc(multi ? cp.prepay_note_multi : cp.prepay_note),
    PrepayTotal: money(prepay),
    PrepaySaves: money(saves),
    EXPIRY_BLOCK: expiryBlock,
    CTA_BLOCK: ctaBlock,
    BranchPhone: esc(BRANCH_PHONE)
  };
  let h = ct.tpl.replace(/\{\{(\w+)\}\}/g, function (m, k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : m; });
  const left = h.match(/\{\{[^}]*\}\}/g);
  if (left) throw new Error("unreplaced placeholders " + left.join(","));

  const lines = q.programs.map(function (p) {
    return p.name + ": " + money(p.perService) + " per service, " + money(p.net) + " for the season" + (p.discount > 0 ? " (discount applied: " + money(p.discount) + ")" : "");
  }).join("\n");
  const text = "Hi " + f.first + ",\n\n" + fill(cp.intro).replace(/<[^>]+>/g, "") + "\n\n" + lines +
    "\n\nSeason total: " + money(q.netCents) +
    "\nPrepay the season and save 5%: " + money(prepay) + " (you save " + money(saves) + ")" +
    "\n\n" + fill(ct.copy.expiry_line) +
    "\n\nReply to this email with a yes, or call or text " + BRANCH_PHONE + ", and we will set up your account and payment. Paying from your bank account is the option we recommend. For your security, we never ask for card or bank account numbers by email or text." +
    "\n\nLawn Doctor of Provo-Spanish Fork-Orem\n118 W 500 S, Spanish Fork, UT 84660\n" + BRANCH_PHONE;

  return { subject: fill(cp.subject), html: h, text: text, total: money(q.netCents) };
}

function images(html) { const out = []; let m; const re = /cid:([\w.\-]+)/g; while ((m = re.exec(html))) if (out.indexOf(m[1]) < 0) out.push(m[1]); return out; }

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
  await env.DB.prepare("INSERT INTO sent_messages (sent_at, mode, kind, customer_number, done_date, recipient, subject, body, provider_id, job) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(nowIso(), mode, "email", n, null, to, subject, html, pid, "estimate").run();
}

// settings.est_test = {"to":"ty@utlawndoctor.com","customer":1234}. Sends both versions with [TEST] subjects, then clears itself.
async function processTest(env) {
  const raw = await sGet(env, "est_test", "");
  if (!raw) return;
  await sSet(env, "est_test", "");
  let t; try { t = JSON.parse(raw); } catch (e) { await sSet(env, "est_test_result", "bad JSON"); return; }
  const out = [];
  try {
    const ct = await content(env);
    const f = await customerFacts(env, t.customer);
    const q = await buildQuote(env, t.customer, ct.names);
    if (q.hold) throw new Error("quote held: " + q.hold);
    const exp = new Date(Date.now() + 7 * 86400000).toISOString();
    for (const v of ["send1", "followup"]) {
      const m = render(ct, v, f, q, exp);
      const pid = await mail(env, t.to, "[TEST " + v + "] " + m.subject, m.html, m.text, null, "estimate-test");
      await archive(env, "test", t.customer, t.to, "[TEST " + v + "] " + m.subject, m.html, pid);
      out.push(v + " sent (" + m.total + ")");
    }
  } catch (e) { out.push("error: " + String(e).slice(0, 220)); }
  await sSet(env, "est_test_result", nowIso() + " " + out.join(", "));
}

// Everyone sitting at status 3 when the job first runs is baseline and is never emailed: those are the stale
// estimates going back to 2024. Only customers who reach status 3 afterwards get a quote.
async function discover(env) {
  const list = arr(await api(env, "/Customer/Search?CustomerStatusMinValue=3&CustomerStatusMaxValue=3&Records=300"));
  const seeded = (await sGet(env, "est_seed", "")) === "done";
  const settle = new Date(Date.now() + 10 * 60000).toISOString();
  const stmts = [];
  for (const c of list) {
    const n = Number(c.customerNumber || c.id);
    if (!n) continue;
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO est_quotes (customer_number, state, first_seen, settle_at, sends, created_at, updated_at) VALUES (?,?,?,?,0,?,?)")
      .bind(n, seeded ? "new" : "baseline", nowIso(), settle, nowIso(), nowIso()));
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  if (!seeded) {
    await sSet(env, "est_seed", "done");
    await sSet(env, "est_seed_count", String(list.length));
  }
}

async function excluded(env, n) {
  let ex = [];
  try { ex = JSON.parse(await sGet(env, "est_exclude", "[]")); } catch (e) { ex = []; }
  return arr(ex).map(Number).indexOf(Number(n)) >= 0;
}

// new -> ready | held | stopped. Three per tick keeps the run well inside Cloudflare's per-run call limit.
async function evaluate(env) {
  const rows = (await env.DB.prepare("SELECT customer_number FROM est_quotes WHERE state='new' AND settle_at <= ? ORDER BY first_seen LIMIT 3").bind(nowIso()).all()).results;
  if (!rows.length) return;
  const ct = await content(env);
  const expiryDays = parseInt(await sGet(env, "est_expiry_days", "7"), 10) || 7;
  for (const r of rows) {
    const n = r.customer_number;
    const set = async function (state, flags, extra) {
      const args = [state, flags ? JSON.stringify(flags) : null, nowIso()].concat(extra ? extra.args : []).concat([n]);
      await env.DB.prepare("UPDATE est_quotes SET state=?, flags=?, updated_at=?" + (extra ? ", " + extra.sql : "") + " WHERE customer_number=?").bind(...args).run();
    };
    try {
      if (await excluded(env, n)) { await set("stopped", ["on est_exclude"]); continue; }
      const f = await customerFacts(env, n);
      if (f.status !== "3") { await set("stopped", ["customer status " + (f.status || "unknown")]); continue; }
      const prefs = await api(env, "/Customer/" + n + "/ContactPreferences");
      if (prefs.dontEmail === true) { await set("stopped", ["dontEmail"]); continue; }

      const flags = [];
      const nok = await env.DB.prepare("SELECT 1 x FROM name_ok WHERE customer_number=?").bind(n).first();
      if (!nok && (!f.first || /[\s&\d\/,+]/.test(f.first) || /\band\b/i.test(f.first))) flags.push("name needs review");
      if (!f.email) flags.push("no email address on file");
      if (!f.address) flags.push("no service address");
      const q = await buildQuote(env, n, ct.names);
      if (q.hold) flags.push(q.hold);
      if (flags.length) { await set("held", flags); continue; }

      const expires = new Date(Date.now() + expiryDays * 86400000).toISOString();
      await set("ready", null, { sql: "quote=?, expires_at=?, next_due=?", args: [JSON.stringify(q), expires, nowIso()] });
    } catch (e) {
      await set("new", ["error: " + String(e).slice(0, 150)], { sql: "settle_at=?", args: [new Date(Date.now() + 3600000).toISOString()] });
    }
  }
}

async function sendDue(env, mode) {
  if (!inWindow()) return;
  const rows = (await env.DB.prepare("SELECT * FROM est_quotes WHERE state='ready' AND next_due <= ? ORDER BY next_due LIMIT 3").bind(nowIso()).all()).results;
  if (!rows.length) return;
  const ct = await content(env);
  const bccFirst = parseInt(await sGet(env, "est_bcc_first", "3"), 10) || 0;
  const followupDays = parseInt(await sGet(env, "est_followup_days", "4"), 10) || 4;
  for (const r of rows) {
    const n = r.customer_number;
    const variant = (r.sends || 0) === 0 ? "send1" : "followup";
    if (mode === "dry-run") {
      const seen = await env.DB.prepare("SELECT 1 x FROM est_dry WHERE customer_number=? AND variant=?").bind(n, variant).first();
      if (seen) continue;
    } else {
      const cl = await env.DB.prepare("UPDATE est_quotes SET state='sending', updated_at=? WHERE customer_number=? AND state='ready'").bind(nowIso(), n).run();
      if (!(cl.meta && cl.meta.changes === 1)) continue;
    }
    const set = async function (state, flags, extra) {
      if (mode === "dry-run" && state !== "stopped" && state !== "held") return;
      const args = [state, flags ? JSON.stringify(flags) : null, nowIso()].concat(extra ? extra.args : []).concat([n]);
      await env.DB.prepare("UPDATE est_quotes SET state=?, flags=?, updated_at=?" + (extra ? ", " + extra.sql : "") + " WHERE customer_number=?").bind(...args).run();
    };
    try {
      // Re-check right before sending: the office may have converted or lost them since the quote was built.
      const f = await customerFacts(env, n);
      if (f.status !== "3") { await set("stopped", [f.status === "9" ? "converted to customer" : "customer status " + (f.status || "unknown")]); continue; }
      if (r.expires_at && r.expires_at <= nowIso()) { await set("expired", ["price expired before sending"]); continue; }
      const q = JSON.parse(r.quote);
      const m = render(ct, variant, f, q, r.expires_at);

      if (mode === "dry-run") {
        await env.DB.prepare("INSERT INTO est_dry (at, customer_number, variant, recipient, subject, total, html) VALUES (?,?,?,?,?,?,?)")
          .bind(nowIso(), n, variant, f.email, m.subject, m.total, m.html).run();
        continue;
      }
      const liveSent = (await env.DB.prepare("SELECT COUNT(*) c FROM sent_messages WHERE job='estimate' AND mode='live'").first()).c;
      const pid = await mail(env, f.email, m.subject, m.html, m.text, liveSent < bccFirst ? ALERT_TO : null, "estimate");
      await archive(env, "live", n, f.email, m.subject, m.html, pid);
      const sends = (r.sends || 0) + 1;
      if (sends === 1) {
        let next = new Date(Date.now() + followupDays * 86400000).toISOString();
        // Never follow up after the price has already expired.
        if (r.expires_at && next >= r.expires_at) next = new Date(Date.parse(r.expires_at) - 2 * 86400000).toISOString();
        await set("ready", null, { sql: "sends=?, last_sent_at=?, next_due=?", args: [sends, nowIso(), next] });
      } else {
        await set("done", null, { sql: "sends=?, last_sent_at=?, next_due=?", args: [sends, nowIso(), null] });
      }
    } catch (e) {
      if (mode !== "dry-run") await set("ready", ["error: " + String(e).slice(0, 150)], { sql: "next_due=?", args: [new Date(Date.now() + 3600000).toISOString()] });
    }
  }
}

// Expires open quotes, and stops anyone who has left status 3. A few checks per tick, each row at most once a day.
async function sweep(env) {
  await env.DB.prepare("UPDATE est_quotes SET state='expired', updated_at=? WHERE state='ready' AND expires_at IS NOT NULL AND expires_at <= ?").bind(nowIso(), nowIso()).run();
  const cutoff = new Date(Date.now() - 24 * 3600000).toISOString();
  const rows = (await env.DB.prepare("SELECT customer_number FROM est_quotes WHERE state IN ('ready','held') AND (last_check IS NULL OR last_check < ?) ORDER BY last_check LIMIT 3").bind(cutoff).all()).results;
  for (const r of rows) {
    const n = r.customer_number;
    try {
      const c = await api(env, "/Customer/" + n);
      const st = trim(c.statusCharacter || c.status || "");
      if (st !== "3") {
        await env.DB.prepare("UPDATE est_quotes SET state='stopped', flags=?, last_check=?, updated_at=? WHERE customer_number=?")
          .bind(JSON.stringify([st === "9" ? "converted to customer" : "customer status " + (st || "unknown")]), nowIso(), nowIso(), n).run();
      } else {
        await env.DB.prepare("UPDATE est_quotes SET last_check=?, updated_at=? WHERE customer_number=?").bind(nowIso(), nowIso(), n).run();
      }
    } catch (e) {
      await env.DB.prepare("UPDATE est_quotes SET last_check=?, updated_at=? WHERE customer_number=?").bind(nowIso(), nowIso(), n).run();
    }
  }
}

// One summary email a day while anything is held or erroring.
async function alerts(env) {
  const last = await sGet(env, "est_alert_last", "");
  if (last && Date.now() - Date.parse(last) < 24 * 3600000) return;
  const held = (await env.DB.prepare("SELECT customer_number, flags FROM est_quotes WHERE state='held' OR flags LIKE '%error:%' LIMIT 50").all()).results;
  if (!held.length) return;
  const body = "<p>Quote emails waiting on you:</p><ul>" + held.map(function (h) { return "<li>Customer " + h.customer_number + ": " + esc(h.flags || "") + "</li>"; }).join("") +
    "</ul><p>Fix the record in RealGreen, then tell Claude to release them.</p>";
  await mail(env, ALERT_TO, "Quote emails held: " + held.length + " customer(s)", body, null, null, "estimate-alert");
  await sSet(env, "est_alert_last", nowIso());
}
