// ===== WELCOME MODULE (runs inside saapi-after-service; own tables, own switch) =====
// Settings (table settings): w_cutoff (YYYY-MM-DD, nothing runs until set), w_seed ('done' when history seeded),
// w_mode ('live' to send; anything else = prepare only), w_approve_first (default 3), w_daily_cap (default 25),
// w_test (JSON for a test send to TEST_EMAIL), w_last (status of last run).
const W_RAW = "../welcome/";
const W_SETTLE_MIN = 10, W_MAX_EVAL = 3, W_MAX_SEND = 3;
const W_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS wprog (program_id INTEGER PRIMARY KEY, customer_number INTEGER, program_code_id INTEGER, date_sold TEXT, first_seen_at TEXT, event_id INTEGER)",
  "CREATE TABLE IF NOT EXISTS wcust (customer_number INTEGER PRIMARY KEY, seeded INTEGER DEFAULT 0, first_seen_at TEXT, welcomed_at TEXT)",
  "CREATE TABLE IF NOT EXISTS wevents (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_number INTEGER, kind TEXT, state TEXT, program_ids TEXT, created_at TEXT, to_email TEXT, subject TEXT, email_html TEXT, flags TEXT, first_name TEXT, approved INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0, sent_at TEXT, send_log TEXT)"
];

async function wSet(env, k, v) { await env.DB.prepare("INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(k, String(v)).run(); }
async function wGet(env, k, d) { const r = await env.DB.prepare("SELECT v FROM settings WHERE k=?").bind(k).first(); return r ? r.v : d; }

async function wCode(env, id) {
  const key = "pc:" + id;
  const row = await env.DB.prepare("SELECT body FROM content WHERE k=?").bind(key).first();
  if (row) return row.body;
  const r = await api(env, "/ProgramCode/" + id);
  if (!r.ok || !r.json || !r.json.programCode) return null;
  const code = trim(r.json.programCode);
  await env.DB.prepare("INSERT INTO content (k, fetched_at, body) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET body=excluded.body, fetched_at=excluded.fetched_at").bind(key, new Date().toISOString(), code).run();
  return code;
}

async function wSeed(env, cutoff) {
  let off = parseInt(await wGet(env, "w_seed_off", "0"), 10) || 0, pages = 0;
  while (pages < 6) {
    const r = await api(env, "/Program/Search?DateSoldMinValue=2000-01-01T00:00:00&DateSoldMaxValue=" + cutoff + "T00:00:00&Records=200&Offset=" + off);
    if (!r.ok || !Array.isArray(r.json)) throw new Error("seed HTTP " + r.status + " " + r.text);
    if (!r.json.length && off === 0) throw new Error("seed returned no programs on the first page");
    if (!r.json.length) { await wSet(env, "w_seed", "done"); return "seed done"; }
    for (const p of r.json) {
      if (p.dateSold && String(p.dateSold).slice(0, 10) < cutoff) {
        await env.DB.prepare("INSERT OR IGNORE INTO wcust (customer_number, seeded, first_seen_at) VALUES (?,1,?)").bind(p.customerNumber, new Date().toISOString()).run();
      }
    }
    off += r.json.length; pages++;
    await wSet(env, "w_seed_off", off);
  }
  return "seeding at offset " + off;
}

async function wPoll(env, cutoff) {
  const from = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10) + "T00:00:00";
  let off = 0, added = 0;
  for (let page = 0; page < 5; page++) {
    const r = await api(env, "/Program/Search?Status=9&DateSoldMinValue=" + from + "&Records=200&Offset=" + off);
    if (!r.ok || !Array.isArray(r.json)) throw new Error("poll HTTP " + r.status + " " + r.text);
    for (const p of r.json) {
      if (!p.dateSold || String(p.dateSold).slice(0, 10) < cutoff) continue;
      const res = await env.DB.prepare("INSERT OR IGNORE INTO wprog (program_id, customer_number, program_code_id, date_sold, first_seen_at) VALUES (?,?,?,?,?)")
        .bind(p.id, p.customerNumber, p.programCodeId, String(p.dateSold).slice(0, 10), new Date().toISOString()).run();
      if (res.meta && res.meta.changes === 1) added++;
    }
    if (r.json.length < 200) break;
    off += r.json.length;
  }
  return added;
}

const money = (n) => "$" + (Math.round(Number(n) * 100) / 100).toFixed(2);

// pure renderer: progs = [{name, blurb, std, price, n, code}]
function wMoneyC(c) { var s = (Math.round(Number(c) || 0) / 100).toFixed(2).split("."); return "$" + s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + s[1]; }
function wPer(p) { return (p.perService != null ? wMoneyC(p.perService) : money(p.std)) + "/service"; }
function wYr(p) { return (p.net != null ? wMoneyC(p.net) : money(p.price)) + "/yr"; }
function wDiscChip(p) {
  if (!p || !(Number(p.discount) > 0)) return "";
  return '<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr><td style="background:#f0f8f3;border-radius:6px;padding:5px 10px;color:#00623a;font-size:12px;font-weight:bold;">Discount applied: &#8722;' + wMoneyC(p.discount) + '</td></tr></table>';
}
// Prepay offer: 5% off the season total, calculated here because RealGreen does not store it.
// Hidden when the customer has already prepaid, and when no program has priced service rows.
function wPrepayBlock(progs, opts) {
  if (opts && opts.prepaid) return "";
  var net = 0, have = false;
  for (var i = 0; i < progs.length; i++) { if (progs[i].net != null) { net += Number(progs[i].net); have = true; } }
  if (!have || !(net > 0)) return "";
  var pre = Math.round(net * 95 / 100);
  return '<tr><td style="padding:16px 32px 6px 32px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0f8f3;border:2px solid #008349;border-radius:14px;"><tr><td style="padding:18px 22px;">' +
    '<div style="color:#231f20;font-size:15px;font-weight:bold;margin-bottom:4px;">&#128176; Prefer to prepay? Save 5%</div>' +
    '<div style="color:#555555;font-size:13px;line-height:1.45;margin-bottom:10px;">Pay for the season up front and it is <strong>' + wMoneyC(pre) + '</strong> instead of ' + wMoneyC(net) + ', a saving of ' + wMoneyC(net - pre) + '.</div>' +
    '<div style="color:#555555;font-size:13px;line-height:1.45;">Call or text 385-463-2430 and we will switch you over. Nothing changes otherwise.</div>' +
    '</td></tr></table></td></tr>';
}

function wRender(kind, tpl, first, address, progs, opts) {
  let h = tpl;
  const rowM = h.match(/PROGRAM_ROW_REFERENCE_START[\s\S]*?(<table[\s\S]*<\/table>)\s*PROGRAM_ROW_REFERENCE_END/);
  if (!rowM) throw new Error("row template not found");
  const rowT = rowM[1];
  const rows = progs.map(function (p) {
    let r = rowT;
    const single = p.n != null ? Number(p.n) === 1 : Math.abs(Number(p.std) - Number(p.price)) < 0.005;
    if (single) r = r.replace(/<div style="color:#888888[^>]*>\{\{ProgramPriceTotal\}\}<\/div>/, "");
    return r.replace(/\{\{ProgramName\}\}/g, function () { return esc(p.name); })
      .replace(/\{\{ProgramPricePerService\}\}/g, function () { return wPer(p); })
      .replace(/\{\{ProgramPriceTotal\}\}/g, function () { return wYr(p); })
      .replace(/\{\{ProgramDiscount\}\}/g, function () { return wDiscChip(p); })
      .replace(/\{\{ProgramDescription\}\}/g, function () { return wDescHtml(p.blurb); });
  }).join("\n");
  h = h.replace(/<!-- PROGRAM_ROW_REFERENCE_START[\s\S]*?PROGRAM_ROW_REFERENCE_END -->/, "");
  h = h.replace("{{PROGRAM_ROWS}}", function () { return rows; });
  const hasLmp = progs.some(function (p) { return p.code === "LMP" || p.code === "M1"; });
  if (hasLmp) h = h.replace(/<!-- LMP_SCHEDULE_BLOCK_START[\s\S]*?-->/, "").replace("<!-- LMP_SCHEDULE_BLOCK_END -->", "");
  else h = h.replace(/<!-- LMP_SCHEDULE_BLOCK_START[\s\S]*?<!-- LMP_SCHEDULE_BLOCK_END -->/, "");
  h = h.replace(/<!-- PROGRAM_SECTION_NOTE[\s\S]*?-->/, "");
  h = h.replace("{{PREPAY_BLOCK}}", function () { return wPrepayBlock(progs, opts); });
  h = h.replace(/\{\{FirstName\}\}/g, function () { return esc(first); }).replace(/\{\{ServiceAddress\}\}/g, function () { return esc(address); });
  return h;
}

function wDescFor(md, code, name) {
  if (!md) return null;
  const parts = md.split(/\n(?=\*\*)/);
  const blocks = [];
  for (const b of parts) {
    const m = b.match(/^\*\*(.+?)\*\*([^\n]*)\n([\s\S]*)$/);
    if (!m) continue;
    const tm = m[2].match(/\(([A-Z0-9\/]+)/);
    blocks.push({ head: m[1].trim(), codes: tm ? tm[1].split("/") : null, body: m[3].trim() });
  }
  for (const b of blocks) if (b.codes && b.codes.indexOf(code) >= 0) return b.body;
  if (!name) return null;
  for (const b of blocks) if (!b.codes && b.head === name) return b.body;
  for (const b of blocks) if (!b.codes && (b.head + " Program" === name || name + " Program" === b.head)) return b.body;
  return null;
}

function wDescHtml(t) {
  const items = []; let para = [];
  const flush = function () { if (para.length) { items.push({ t: "p", h: esc(para.join(" ")) }); para = []; } };
  const lines = String(t).split("\n");
  lines.forEach(function (ln, i) {
    if (!ln.trim()) { flush(); return; }
    if (/^- /.test(ln)) { flush(); items.push({ t: "b", h: "&bull; " + esc(ln.slice(2).trim()) }); return; }
    if (/^\s+\S/.test(ln) && !para.length && items.length && items[items.length - 1].t === "b") { items[items.length - 1].h += " " + esc(ln.trim()); return; }
    para.push(ln.trim());
    if (i === 0 && ln.trim().length < 60 && !/[.:!?]$/.test(ln.trim())) flush();
  });
  flush();
  return items.map(function (it, i) { return (i === 0 ? "" : (items[i - 1].t === "b" && it.t === "b" ? "<br>" : "<br><br>")) + it.h; }).join("");
}

async function wContent(env) {
  const tpls = {
    welcome: await getText(env, "w_tpl_welcome", W_RAW + "welcome_template.html", false),
    addon: await getText(env, "w_tpl_addon", W_RAW + "new_service_template.html", false)
  };
  const names = await getText(env, "w_names", W_RAW + "service_code_map.json", true);
  const blurbs = await getText(env, "w_desc", W_RAW + "service_descriptions.md", false);
  if (!tpls.welcome || !tpls.addon || !names || !blurbs) throw new Error("welcome content unavailable");
  return { tpls: tpls, names: names, blurbs: blurbs };
}

function wImages(html) {
  const out = []; let m; const re = /cid:([\w.\-]+)/g;
  while ((m = re.exec(html))) if (out.indexOf(m[1]) < 0) out.push(m[1]);
  return out;
}

async function wMail(env, to, subject, html, bcc) {
  const fd = new FormData();
  fd.append("from", "Lawn Doctor <support@utlawndoctor.com>");
  fd.append("to", to);
  if (bcc) fd.append("bcc", bcc);
  fd.append("subject", subject);
  fd.append("html", html);
  for (const n of wImages(html)) {
    const ir = await fetch("https://raw.githubusercontent.com/utlawndoctor/lawndoctor-assets/main/images/email/" + n);
    if (!ir.ok) throw new Error("image " + n + " HTTP " + ir.status);
    fd.append("inline", new Blob([await ir.arrayBuffer()], { type: /\.jpe?g$/.test(n) ? "image/jpeg" : "image/png" }), n);
  }
  const r = await fetch("https://api.mailgun.net/v3/utlawndoctor.com/messages", { method: "POST", headers: { Authorization: "Basic " + btoa("api:" + env.MAILGUN_KEY) }, body: fd });
  const t = await r.text();
  if (!r.ok) throw new Error("Mailgun HTTP " + r.status + " " + t.slice(0, 160));
  try { return JSON.parse(t).id || "ok"; } catch (e) { return "ok"; }
}

async function wTest(env) {
  const raw = await wGet(env, "w_test", "");
  if (!raw) return;
  await wSet(env, "w_test", "");
  const t = JSON.parse(raw);
  const ct = await wContent(env);
  const progs = t.programs.map(function (p) {
    return { code: p.code, name: ct.names[p.code] || p.code, blurb: wDescFor(ct.blurbs, p.code, ct.names[p.code]) || "", std: p.std, price: p.price };
  });
  const kind = t.kind === "addon" ? "addon" : "welcome";
  const html = wRender(kind, ct.tpls[kind], t.first || "Ty", t.address || "123 Example Street, Provo", progs);
  const subj = "[TEST] " + (kind === "welcome" ? "Welcome to Lawn Doctor, " : "You are all set, ") + (t.first || "Ty") + "!";
  const left = html.match(/\{\{[^}]*\}\}/g);
  const id = await wMail(env, TEST_EMAIL, subj, html, null);
  await wSet(env, "w_test_last", new Date().toISOString() + " sent " + id + (left ? " LEFTOVER " + left.join(",") : " clean"));
}

async function wEvaluate(env, ct, cutoff, custNum) {
  const now = new Date().toISOString();
  const flags = [];
  const cust = await api(env, "/Customer/" + custNum);
  if (!cust.ok || !cust.json) throw new Error("Customer " + custNum + " HTTP " + cust.status);
  const c = cust.json, prefs = c.contactPreferences || {};
  const pr = await api(env, "/Program/Search?CustomerNumber=" + custNum + "&Records=200&Offset=0");
  if (!pr.ok || !Array.isArray(pr.json)) throw new Error("Programs " + custNum + " HTTP " + pr.status);
  const progs = pr.json;
  const sent = new Set((await env.DB.prepare("SELECT program_id FROM wprog WHERE customer_number=? AND event_id IS NOT NULL").bind(custNum).all()).results.map(function (r) { return r.program_id; }));
  const pending = new Set((await env.DB.prepare("SELECT program_id FROM wprog WHERE customer_number=? AND event_id IS NULL").bind(custNum).all()).results.map(function (r) { return r.program_id; }));
  const ds = function (p) { return p.dateSold ? String(p.dateSold).slice(0, 10) : ""; };
  const known = await env.DB.prepare("SELECT 1 x FROM wcust WHERE customer_number=?").bind(custNum).first();
  const evPrior = await env.DB.prepare("SELECT 1 x FROM wevents WHERE customer_number=? AND kind='welcome' AND state IN ('ready','sending','sent','held')").bind(custNum).first();
  // Same email on another account (a second property) = existing customer, so they get the new-service email, not a welcome (Ty 2026-10-22).
  const em = String(c.preferredEmail || c.email || "").trim().toLowerCase();
  const sameEmail = em ? await env.DB.prepare("SELECT 1 x FROM bill_day WHERE lower(email)=? AND customer_number<>? UNION SELECT 1 FROM sent_messages WHERE lower(recipient)=? AND customer_number<>? AND mode='live' LIMIT 1").bind(em, custNum, em, custNum).first() : null;
  const prior = !!known || !!evPrior || !!sameEmail || progs.some(function (p) { return ds(p) && ds(p) < cutoff; });
  const kind = prior ? "addon" : "welcome";
  const active = progs.filter(function (p) { return String(p.status) === "9" && ds(p) >= cutoff && !sent.has(p.id); });
  const use = kind === "welcome" ? active : active.filter(function (p) { return pending.has(p.id); });
  for (const p of use) await env.DB.prepare("INSERT OR IGNORE INTO wprog (program_id, customer_number, program_code_id, date_sold, first_seen_at) VALUES (?,?,?,?,?)").bind(p.id, custNum, p.programCodeId, ds(p), now).run();
  const done = async function (ids, evId) { for (const id of ids) await env.DB.prepare("UPDATE wprog SET event_id=? WHERE program_id=?").bind(evId, id).run(); };
  // programs no longer active are closed out silently
  const gone = Array.from(pending).filter(function (id) { return !use.some(function (p) { return p.id === id; }); });
  const keep = [], renewals = [];
  for (const p of use) {
    const isRenewal = kind === "addon" && progs.some(function (o) { return o.id !== p.id && o.programCodeId === p.programCodeId && ds(o) && ds(o) < ds(p); });
    (isRenewal ? renewals : keep).push(p);
  }
  if (gone.length) await done(gone, -1);
  if (renewals.length) await done(renewals.map(function (p) { return p.id; }), -2);
  if (!keep.length) return "nothing to send";
  const svR = await api(env, "/Service/Search?CustomerNumber=" + custNum + "&Records=300");
  const svAll = (svR.ok && Array.isArray(svR.json)) ? svR.json : [];
  const prepaid = Number(c.prepayBalance) > 0 || svAll.some(function (s) { return Number(s.prepayAmount) > 0 || s.prepayId; });
  const rows = [];
  for (const p of keep) {
    const code = await wCode(env, p.programCodeId);
    const name = code ? ct.names[code] : null, blurb = code ? wDescFor(ct.blurbs, code, name) : null;
    if (!code) { flags.push("program code id " + p.programCodeId + " not found in RealGreen"); continue; }
    if (!name) flags.push("service code " + code + " missing from service_code_map.json");
    if (!blurb) flags.push("service code " + code + " has no description in service_descriptions.md");
    const sRows = svAll.filter(function (s) { return Number(s.programID) === Number(p.id) && !s.isReversed; });
    let gC = 0, nC = 0;
    for (const s of sRows) { gC += Math.round((Number(s.price) || 0) * 100); nC += Math.round((Number(s.totalAmount) || 0) * 100); }
    const std = Number(p.standardPrice), price = Number(p.price);
    if (!(price > 0) || !(std > 0)) { if (!(code === "GCC" && !(price > 0))) flags.push(code + " has a $0 price (" + money(price) + ")"); }
    if (code === "GCC" && price > 0) flags.push("GCC has a charge above $0 (" + money(price) + ")");
    rows.push({ code: code, name: name || code, blurb: blurb || "", std: std, price: price, n: sRows.length || null, net: (sRows.length && nC > 0) ? nC : null, gross: sRows.length ? gC : null, discount: (sRows.length && gC > nC) ? (gC - nC) : 0, perService: (sRows.length && nC > 0) ? Math.round(nC / sRows.length) : null });
  }
  const fn = String(c.firstName || "").trim();
  const nok = await env.DB.prepare("SELECT 1 x FROM name_ok WHERE customer_number=?").bind(custNum).first();
  if (!nok && (!fn || /[\s&\d\/,+]/.test(fn) || /\band\b/i.test(fn))) flags.push("name needs review: first name is empty or more than one word");
  const to = trim(c.preferredEmail || c.email);
  const a = c.address || {};
  const address = trim(a.addressLine1) ? trim(a.addressLine1) + (trim(a.city) ? ", " + trim(a.city) : "") : "";
  if (!address) flags.push("service address is blank");
  let html = null, subject = null;
  if (!flags.length || flags.every(function (f) { return /^name needs review|^service address/.test(f); })) {
    try {
      html = wRender(kind, ct.tpls[kind], fn, address, rows, { prepaid: prepaid });
      const left = html.match(/\{\{[^}]*\}\}/g);
      if (left) { flags.push("unreplaced placeholders: " + left.join(",")); html = null; }
    } catch (e) { flags.push("compose failed: " + String(e).slice(0, 100)); }
  }
  subject = kind === "welcome" ? "Welcome to Lawn Doctor, " + fn + "!" : "You are all set, " + fn + "!";
  let state = "ready";
  if (!to) { flags.push("no email address on file"); }
  if (prefs.dontEmail) { flags.length = 0; flags.push("customer is set to dontEmail (skipped)"); state = "skipped"; }
  else if (flags.length || !html) state = "held";
  const ins = await env.DB.prepare("INSERT INTO wevents (customer_number, kind, state, program_ids, created_at, to_email, subject, email_html, flags, first_name, send_log) VALUES (?,?,?,?,?,?,?,?,?,?,'[]')")
    .bind(custNum, kind, state, JSON.stringify(keep.map(function (p) { return p.id; })), now, to || null, subject, html, JSON.stringify(flags), fn).run();
  const evId = ins.meta.last_row_id;
  await done(keep.map(function (p) { return p.id; }), evId);
  return kind + " " + state;
}

async function wSend(env) {
  if ((await wGet(env, "w_mode", "")) !== "live") return 0;
  const af = parseInt(await wGet(env, "w_approve_first", "3"), 10);
  const cap = parseInt(await wGet(env, "w_daily_cap", "25"), 10);
  const hr = denverHour();
  if (hr < SEND_START || hr >= SEND_END) return 0;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });
  const sentRows = (await env.DB.prepare("SELECT sent_at FROM wevents WHERE state='sent'").all()).results;
  let sentN = sentRows.length;
  let sentToday = sentRows.filter(function (r) { return new Date(r.sent_at).toLocaleDateString("en-CA", { timeZone: "America/Denver" }) === today; }).length;
  const rows = (await env.DB.prepare("SELECT * FROM wevents WHERE state='ready' AND email_html IS NOT NULL ORDER BY id LIMIT 10").all()).results;
  let n = 0;
  for (const ev of rows) {
    if (n >= W_MAX_SEND) break;
    if (sentToday >= cap) break;
    if (sentN < af && !ev.approved) continue;
    const cl = await env.DB.prepare("UPDATE wevents SET state='sending' WHERE id=? AND state='ready'").bind(ev.id).run();
    if (!(cl.meta && cl.meta.changes === 1)) continue;
    const log = JSON.parse(ev.send_log || "[]");
    try {
      const id = await wMail(env, ev.to_email, ev.subject, ev.email_html, BCC);
      const at = new Date().toISOString();
      await env.DB.prepare("UPDATE wevents SET state='sent', sent_at=? WHERE id=?").bind(at, ev.id).run();
      log.push({ at: at, kind: "email", id: id });
      await env.DB.prepare("UPDATE wevents SET send_log=? WHERE id=?").bind(JSON.stringify(log), ev.id).run();
      await env.DB.prepare("INSERT INTO wcust (customer_number, seeded, first_seen_at, welcomed_at) VALUES (?,0,?,?) ON CONFLICT(customer_number) DO UPDATE SET welcomed_at=COALESCE(welcomed_at, excluded.welcomed_at)").bind(ev.customer_number, at, at).run();
      try { await env.DB.prepare("INSERT INTO sent_messages (sent_at, mode, kind, customer_number, done_date, recipient, subject, body, provider_id, job) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(at, "live", "email", ev.customer_number, null, ev.to_email, ev.subject, ev.email_html, String(id), ev.kind === "welcome" ? "welcome" : "new-service").run(); } catch (e) {}
      n++; sentN++; sentToday++;
    } catch (e) {
      log.push({ at: new Date().toISOString(), kind: "email", err: String(e).slice(0, 160) });
      const att = (ev.attempts || 0) + 1;
      await env.DB.prepare("UPDATE wevents SET state=?, attempts=?, send_log=? WHERE id=?").bind(att >= 3 ? "error" : "ready", att, JSON.stringify(log), ev.id).run();
    }
  }
  return n;
}

async function welcomePass(env) {
  const cutoff = await wGet(env, "w_cutoff", "");
  if (!cutoff) return;
  for (const s of W_SCHEMA) await env.DB.prepare(s).run();
  let info = [];
  try { await wTest(env); } catch (e) { info.push("test: " + String(e).slice(0, 150)); await wSet(env, "w_test_last", new Date().toISOString() + " ERR " + String(e).slice(0, 200)); }
  if ((await wGet(env, "w_seed", "")) !== "done") { info.push(await wSeed(env, cutoff)); await wSet(env, "w_last", new Date().toISOString() + " " + info.join("; ")); return; }
  info.push("added " + (await wPoll(env, cutoff)));
  const ct = await wContent(env);
  const cutoffT = new Date(Date.now() - W_SETTLE_MIN * 60000).toISOString();
  const due = (await env.DB.prepare("SELECT customer_number, MAX(first_seen_at) m FROM wprog WHERE event_id IS NULL GROUP BY customer_number HAVING m <= ? LIMIT ?").bind(cutoffT, W_MAX_EVAL).all()).results;
  for (const d of due) {
    try { info.push("#" + d.customer_number + " " + await wEvaluate(env, ct, cutoff, d.customer_number)); }
    catch (e) { info.push("#" + d.customer_number + " ERR " + String(e).slice(0, 100)); }
  }
  info.push("sent " + (await wSend(env)));
  await wSet(env, "w_last", new Date().toISOString() + " " + info.join("; "));
}

// True only 15+ minutes after the send window opens and before it closes, so overnight ready emails do not alert.
function wInWindow15() {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date());
  const h = parseInt(p.find(function (x) { return x.type === "hour"; }).value, 10) % 24;
  const m = parseInt(p.find(function (x) { return x.type === "minute"; }).value, 10);
  return h * 60 + m >= SEND_START * 60 + 15 && h < SEND_END;
}

async function wIssues(env) {
  const out = {};
  const cutoff = await wGet(env, "w_cutoff", "");
  if (!cutoff) return out;
  const last = await wGet(env, "w_last", "");
  if (!last || Date.now() - Date.parse(last.slice(0, 24)) > 20 * 60000) out["w-stale"] = "The welcome email module has not completed a run in 20+ minutes (last: " + (last || "never") + ").";
  const rows = (await env.DB.prepare("SELECT id, customer_number, kind, state, flags, created_at, approved, to_email FROM wevents WHERE state IN ('held','error','sending','ready')").all()).results;
  const af = parseInt(await wGet(env, "w_approve_first", "3"), 10);
  const sentN = (await env.DB.prepare("SELECT COUNT(*) c FROM wevents WHERE state='sent'").first()).c;
  const live = (await wGet(env, "w_mode", "")) === "live";
  for (const r of rows) {
    const age = Date.now() - Date.parse(r.created_at), who = "customer #" + r.customer_number + " (" + r.kind + ")";
    let fl = []; try { fl = JSON.parse(r.flags || "[]"); } catch (e) {}
    if (r.state === "held") out["w-held:" + r.id] = who + ": welcome email held: " + fl.join("; ");
    else if (r.state === "error") out["w-err:" + r.id] = who + ": welcome email failed 3 times.";
    else if (r.state === "sending" && age > 20 * 60000) out["w-send:" + r.id] = who + ": stuck in sending for 20+ minutes. Check Mailgun before retrying so it is not sent twice.";
    else if (r.state === "ready" && live && wInWindow15() && age > 60 * 60000) out["w-ready:" + r.id] = who + ": ready 60+ minutes ago but not sent" + (sentN < af && !r.approved ? " (waiting for your approval)" : "") + ".";
  }
  return out;
}
// ===== END WELCOME MODULE =====
