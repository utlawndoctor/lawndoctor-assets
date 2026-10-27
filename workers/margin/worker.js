// lawndoctor-margin: collects completed RealGreen services for margin reporting (Ty 2026-10-27).
// Read-only against RealGreen. Sends nothing to customers.
// Tables: mg_services (one row per completed service: price, size, man hours, technician, products used),
//         mg_products (RealGreen product list), mg_units (unit codes).
// Backfill: pages /Service/Search?ServiceStatus=S&StartDateMinValue=<mg_from> 500 at a time until done (settings mg_backfill).
// Daily refresh: the last 10 days of completed services are re-read and upserted.
// Settings (prefix mg_): mg_mode off|on, mg_from (default 2026-01-01), mg_backfill JSON {offset, done}, mg_last_tick.

const BASE = "https://saapi.realgreen.com";
const TZ = "America/Denver";
const PAGE = 500;

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(tick(env)); },
  async fetch() { return new Response("Not found", { status: 404 }); }
};

async function tick(env) {
  let note = "", err = "";
  try {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS mg_services (id INTEGER PRIMARY KEY, customer_number INTEGER, service_code TEXT, program_id INTEGER, round INTEGER, service_year INTEGER, done_date TEXT, size REAL, price REAL, total_amount REAL, production_value REAL, discount REAL, man_hours REAL, est_man_hours REAL, employees TEXT, products TEXT, is_reversed INTEGER, updated_at TEXT)").run();
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS mg_products (id INTEGER PRIMARY KEY, code TEXT, name TEXT, epa TEXT, size TEXT, unit INTEGER, updated_at TEXT)").run();
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS mg_units (id INTEGER PRIMARY KEY, name TEXT)").run();
    if ((await sGet(env, "mg_mode", "off")) !== "on") return;
    const key = await env.SAAPI_KEY.get();
    const from = await sGet(env, "mg_from", "2026-01-01");
    let bf = {}; try { bf = JSON.parse(await sGet(env, "mg_backfill", "{}")); } catch (e) {}
    if (!bf.done) {
      const off = bf.offset || 0;
      const n = await pull(env, key, from, off);
      bf = n < PAGE ? { offset: off + n, done: new Date().toISOString() } : { offset: off + n };
      await sSet(env, "mg_backfill", JSON.stringify(bf));
      note += "backfill +" + n + " ";
      if (bf.done) await refreshLists(env, key);
    } else {
      const last = await sGet(env, "mg_daily_at", "");
      const today = denverDate(Date.now());
      if (last !== today && denverHour() >= 22) {
        let off = 0, n = 0, tot = 0;
        do { n = await pull(env, key, denverDate(Date.now() - 10 * 86400000), off); off += n; tot += n; } while (n === PAGE && off < 5000);
        await refreshLists(env, key);
        await sSet(env, "mg_daily_at", today);
        note += "daily " + tot + " ";
      } else note += "idle ";
    }
  } catch (e) { err = String(e).slice(0, 300); }
  await sSet(env, "mg_last_tick", new Date().toISOString() + " " + note + (err ? "ERR " + err : "ok"));
}

async function sGet(env, k, d) { const r = await env.DB.prepare("SELECT v FROM settings WHERE k=?").bind(k).first(); return r && r.v !== null && r.v !== "" ? r.v : d; }
async function sSet(env, k, v) { await env.DB.prepare("INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(k, String(v)).run(); }
function denverDate(d) { return new Date(d).toLocaleDateString("en-CA", { timeZone: TZ }); }
function denverHour() { return parseInt(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hour12: false }).format(new Date()), 10) % 24; }

async function api(key, path) {
  const r = await fetch(BASE + path, { headers: { apiKey: key, Accept: "application/json" }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error("SAAPI " + r.status + " " + path.split("?")[0]);
  return r.json();
}

function num(x) { const n = Number(x); return isFinite(n) ? n : null; }

// Reads one page of completed services and upserts them. Returns the number of records on the page.
async function pull(env, key, from, offset) {
  const list = await api(key, "/Service/Search?ServiceStatus=S&StartDateMinValue=" + from + "&Records=" + PAGE + "&Offset=" + offset);
  const rows = Array.isArray(list) ? list : [];
  const now = new Date().toISOString();
  const stmts = [];
  for (const s of rows) {
    if (!s || !s.id) continue;
    const prods = (Array.isArray(s.productsUsed) ? s.productsUsed : []).map(function (p) {
      return { id: p.productID, amt: num(p.actAmount), method: p.applicationMethod || "", area: num(p.treatedArea) };
    });
    const emps = (Array.isArray(s.doneByEmployees) ? s.doneByEmployees : []).map(function (e) { return String(e.employeeName || e.employeeID || "").trim(); }).filter(Boolean);
    stmts.push(env.DB.prepare("INSERT INTO mg_services (id, customer_number, service_code, program_id, round, service_year, done_date, size, price, total_amount, production_value, discount, man_hours, est_man_hours, employees, products, is_reversed, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET customer_number=excluded.customer_number, service_code=excluded.service_code, program_id=excluded.program_id, round=excluded.round, service_year=excluded.service_year, done_date=excluded.done_date, size=excluded.size, price=excluded.price, total_amount=excluded.total_amount, production_value=excluded.production_value, discount=excluded.discount, man_hours=excluded.man_hours, est_man_hours=excluded.est_man_hours, employees=excluded.employees, products=excluded.products, is_reversed=excluded.is_reversed, updated_at=excluded.updated_at")
      .bind(s.id, s.customerNumber || null, String(s.serviceCode || "").trim(), s.programID || null, s.round || null, s.serviceYear || null,
        String(s.doneDate || s.startDate || "").slice(0, 10), num(s.size), num(s.price), num(s.totalAmount), num(s.productionValue),
        (num(s.discountAmount) || 0) + (num(s.programDiscountAmount) || 0) + (num(s.prepayAmount) || 0),
        num(s.actualManHours), num(s.estimatedManHours), JSON.stringify(emps), JSON.stringify(prods), s.isReversed ? 1 : 0, now));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return rows.length;
}

async function refreshLists(env, key) {
  const now = new Date().toISOString();
  try {
    const prods = await api(key, "/Products");
    const st = (Array.isArray(prods) ? prods : []).map(function (p) {
      return env.DB.prepare("INSERT INTO mg_products (id, code, name, epa, size, unit, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET code=excluded.code, name=excluded.name, epa=excluded.epa, size=excluded.size, unit=excluded.unit, updated_at=excluded.updated_at")
        .bind(p.id, String(p.code || "").trim(), String(p.desc || p.description || "").trim(), String(p.epa || p.epaNumber || "").trim(), String(p.size || "").trim(), p.unit || p.unitofMeasure || null, now);
    });
    for (let i = 0; i < st.length; i += 50) await env.DB.batch(st.slice(i, i + 50));
  } catch (e) {}
  try {
    const units = await api(key, "/Parameter/UnitCode");
    const st = (Array.isArray(units) ? units : []).map(function (u) {
      return env.DB.prepare("INSERT INTO mg_units (id, name) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name").bind(u.unitCodeID || u.id, String(u.unitDescription || u.description || u.name || "").trim());
    });
    for (let i = 0; i < st.length; i += 50) await env.DB.batch(st.slice(i, i + 50));
  } catch (e) {}
}
