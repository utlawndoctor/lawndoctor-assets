// lawndoctor-calllog: writes RealGreen call-log entries for messages sent by the job Workers (billing, before-service, caw).
// After-service entries are written by the sender itself (logPass) and are not touched here.
// One entry per customer per job per Denver day: the email and text from the same send are combined, logged 10+ minutes after sending.
// Reason: Email (32, status E) when an email went out; the RealGreen "Text" reason (found by name) for text-only sends.
// Only messages sent at or after settings.cl_from are logged (no back-fill). Up to 3 tries per entry, then one alert to Ty.
// Never blocks or delays a message. Settings: cl_mode off|live, cl_from, cl_jobs (comma list).

const BASE = "https://saapi.realgreen.com";
const ALERT_TO = "ty@utlawndoctor.com";
const TZ = "America/Denver";
const LABEL = { "billing": "Billing reminder", "before-service": "Visit heads-up", "caw": "Customer portal invite" };

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(tick(env)); },
  async fetch() { return new Response("Not found", { status: 404 }); }
};

async function tick(env) {
  let err = "", note = "";
  try {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS calllog_items (sent_id INTEGER PRIMARY KEY, job TEXT, customer_number INTEGER, day TEXT)").run();
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS calllog_groups (job TEXT, customer_number INTEGER, day TEXT, state TEXT, tries INTEGER DEFAULT 0, err TEXT, note TEXT, written_at TEXT, PRIMARY KEY (job, customer_number, day))").run();
    if ((await sGet(env, "cl_mode", "off")) !== "live") return;
    note += "grouped " + (await group(env)) + " ";
    note += "written " + (await write(env));
  } catch (e) { err = String(e).slice(0, 300); }
  await sSet(env, "cl_last_tick", new Date().toISOString() + " " + note + (err ? " ERR " + err : " ok"));
}

async function sGet(env, k, d) { const r = await env.DB.prepare("SELECT v FROM settings WHERE k=?").bind(k).first(); return r && r.v !== null && r.v !== "" ? r.v : d; }
async function sSet(env, k, v) { await env.DB.prepare("INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(k, String(v)).run(); }
function denverDate(d) { return new Date(d).toLocaleDateString("en-CA", { timeZone: TZ }); }
function usDate(ymd) { const p = ymd.split("-"); return Number(p[1]) + "/" + Number(p[2]) + "/" + p[0]; }

// Puts newly sent live messages into groups (job + customer + Denver day).
async function group(env) {
  const from = await sGet(env, "cl_from", "");
  if (!from) return 0;
  const jobs = (await sGet(env, "cl_jobs", "billing,before-service,caw")).split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  if (!jobs.length) return 0;
  const marks = jobs.map(function () { return "?"; }).join(",");
  const rows = (await env.DB.prepare("SELECT m.id, m.job, m.customer_number, m.sent_at FROM sent_messages m LEFT JOIN calllog_items c ON c.sent_id = m.id WHERE c.sent_id IS NULL AND m.mode = 'live' AND m.kind IN ('email','sms') AND m.job IN (" + marks + ") AND m.sent_at >= ? AND m.sent_at <= ? ORDER BY m.id LIMIT 100")
    .bind(...jobs.concat([from, new Date(Date.now() - 10 * 60000).toISOString()])).all()).results;
  const stmts = [];
  for (const r of rows) {
    const day = denverDate(r.sent_at);
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO calllog_items (sent_id, job, customer_number, day) VALUES (?,?,?,?)").bind(r.id, r.job, r.customer_number, day));
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO calllog_groups (job, customer_number, day, state) VALUES (?,?,?, 'pending')").bind(r.job, r.customer_number, day));
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return rows.length;
}

// Finds the RealGreen "Text" call reason by name, refreshed daily.
async function textReason(env, key) {
  try { const c = JSON.parse(await sGet(env, "cl_text_reason", "{}")); if (c.at && Date.now() - Date.parse(c.at) < 86400000) return c.id ? c : null; } catch (e) {}
  let out = { at: new Date().toISOString() };
  try {
    const r = await fetch(BASE + "/CallReason", { headers: { apiKey: key, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    const list = r.ok ? await r.json() : [];
    const hit = (Array.isArray(list) ? list : []).find(function (x) { return /^\s*(text|texts|text message|sms)\s*$/i.test(String(x.actionReason || "")); })
      || (Array.isArray(list) ? list : []).find(function (x) { return /\b(text|sms)\b/i.test(String(x.actionReason || "")); });
    if (hit) out = { at: out.at, id: hit.actionReasonID, status: hit.status, name: hit.actionReason };
  } catch (e) {}
  await sSet(env, "cl_text_reason", JSON.stringify(out));
  return out.id ? out : null;
}

async function write(env) {
  const groups = (await env.DB.prepare("SELECT * FROM calllog_groups WHERE state='pending' AND COALESCE(tries,0) < 3 ORDER BY day, customer_number LIMIT 10").all()).results;
  if (!groups.length) return 0;
  const key = await env.SAAPI_KEY.get();
  let n = 0;
  for (const g of groups) {
    const cl = await env.DB.prepare("UPDATE calllog_groups SET state='claiming' WHERE job=? AND customer_number=? AND day=? AND state='pending'").bind(g.job, g.customer_number, g.day).run();
    if (!(cl.meta && cl.meta.changes === 1)) continue;
    const msgs = (await env.DB.prepare("SELECT m.kind, m.subject, m.body, m.recipient, m.sent_at FROM calllog_items c JOIN sent_messages m ON m.id = c.sent_id WHERE c.job=? AND c.customer_number=? AND c.day=? ORDER BY m.id").bind(g.job, g.customer_number, g.day).all()).results;
    const email = msgs.find(function (m) { return m.kind === "email"; });
    const text = msgs.find(function (m) { return m.kind === "sms"; });
    let reason = { id: 32, status: "E" }, prefix = "";
    if (!email && text) { const tr = await textReason(env, key); if (tr) reason = tr; else prefix = "TEXT: "; }
    const what = email && text ? "Email + text sent" : email ? "Email sent" : "Text sent";
    let note = prefix + what + " " + usDate(g.day) + " | " + (LABEL[g.job] || g.job);
    if (email && email.subject) note += " | Subject: " + email.subject;
    else if (text && text.body) note += " | Text: " + String(text.body).replace(/\s+/g, " ").slice(0, 200);
    note = (note + " | Automated").slice(0, 400);
    const phone = text && text.recipient ? String(text.recipient).replace(/^\+1/, "") : "";
    try {
      const r = await fetch(BASE + "/CallLog/AddCallLog", { method: "POST", headers: { apiKey: key, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ cust_no: Number(g.customer_number), emp_id: "TY", actionReasonID: reason.id, status: reason.status, note: note, auditEmployeeID: "TY", name: "", phoneNumber: phone }), signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error("HTTP " + r.status + " " + (await r.text()).slice(0, 150));
      await env.DB.prepare("UPDATE calllog_groups SET state='written', note=?, written_at=?, err=NULL WHERE job=? AND customer_number=? AND day=?").bind(note, new Date().toISOString(), g.job, g.customer_number, g.day).run();
      n++;
    } catch (e) {
      const tries = (g.tries || 0) + 1;
      await env.DB.prepare("UPDATE calllog_groups SET state=?, tries=?, err=? WHERE job=? AND customer_number=? AND day=?").bind(tries >= 3 ? "failed" : "pending", tries, String(e).slice(0, 200), g.job, g.customer_number, g.day).run();
      if (tries >= 3) { try { await alert(env, g, String(e).slice(0, 200)); } catch (e2) {} }
    }
  }
  return n;
}

async function alert(env, g, err) {
  const key = await env.MAILGUN_KEY.get();
  const fd = new FormData();
  fd.append("from", "Lawn Doctor <support@utlawndoctor.com>");
  fd.append("to", ALERT_TO);
  fd.append("subject", "RealGreen call log write failed (customer " + g.customer_number + ")");
  fd.append("text", "The " + (LABEL[g.job] || g.job) + " message on " + g.day + " was sent, but the RealGreen call log entry failed 3 times. Last error: " + err + ". No more retries.");
  await fetch("https://api.mailgun.net/v3/utlawndoctor.com/messages", { method: "POST", headers: { Authorization: "Basic " + btoa("api:" + key) }, body: fd, signal: AbortSignal.timeout(20000) });
}
