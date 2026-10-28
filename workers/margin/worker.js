// lawndoctor-margin: collects completed RealGreen services for margin reporting (Ty 2026-10-27).
// Read-only against RealGreen. Sends nothing to customers.
// Tables: mg_services (one row per completed service: price, size, man hours, technician, products used),
//         mg_products (RealGreen product list), mg_units (unit codes).
// Backfill: pages /Service/Search?ServiceStatus=S&StartDateMinValue=<mg_from> 500 at a time until done (settings mg_backfill).
// Daily refresh: the last 10 days of completed services are re-read and upserted.
// Settings (prefix mg_): mg_mode off|on, mg_from (default 2026-01-01), mg_backfill JSON {offset, done}, mg_last_tick,
//   mg_recompute=1 forces the allocation step on the next tick.
// Each night after the pull it also refreshes customer names (mg_customers) and re-runs the cost allocation:
//   material: each product's season invoice spend (mg_product_cost) spread over that product's recorded uses;
//   labor: each day's Gusto cost incl. workers comp (mg_labor_day, loaded by Claude after each payroll) split
//   by stop (customer+day) half evenly, half by lawn size, within a stop by price; non-visit days pooled by revenue.
//   Material per unit is capped at the invoice unit cost; leftover spend is stock (settings.mg_stock).
//   mg_labor_day.owner = owner labor at replacement cost (Terra 10/14 to 10/25 in Hunter's place, Kasin's hours x $27.86).

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
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS mg_customers (id INTEGER PRIMARY KEY, name TEXT, status TEXT, updated_at TEXT)").run();
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
        await refreshCustomers(env, key);
        await recompute(env);
        await sSet(env, "mg_daily_at", today);
        note += "daily " + tot + " ";
      } else if ((await sGet(env, "mg_recompute", "")) === "1") {
        await sSet(env, "mg_recompute", "");
        await refreshCustomers(env, key);
        await recompute(env);
        note += "recomputed ";
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

// Customer names for the margin report (first and last name only).
async function refreshCustomers(env, key) {
  const now = new Date().toISOString();
  let off = 0, n = 0;
  do {
    const list = await api(key, "/Customer/Search?CustomerStatusMinValue=0&CustomerStatusMaxValue=9&Records=" + PAGE + "&Offset=" + off);
    const rows = Array.isArray(list) ? list : [];
    n = rows.length; off += n;
    const st = rows.filter(function (c) { return c && (c.customerNumber || c.id); }).map(function (c) {
      const nm = (String(c.firstName || "").trim() + " " + String(c.lastName || "").trim()).trim() || String(c.companyName || "").trim();
      return env.DB.prepare("INSERT INTO mg_customers (id, name, status, updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, status=excluded.status, updated_at=excluded.updated_at").bind(Number(c.customerNumber || c.id), nm, String(c.statusCharacter || "").trim(), now);
    });
    for (let i = 0; i < st.length; i += 50) await env.DB.batch(st.slice(i, i + 50));
  } while (n === PAGE && off < 20000);
}

// Re-runs the material and labor allocation over every collected service.
async function recompute(env) {
  const db = env.DB;
  await db.prepare("CREATE TABLE IF NOT EXISTS mg_labor_alloc (service_id INTEGER PRIMARY KEY, labor_day REAL, labor_pool REAL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS mg_material_alloc (service_id INTEGER PRIMARY KEY, material REAL, material_unpriced_uses INTEGER)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS mg_labor_day (day TEXT PRIMARY KEY, cost REAL, minutes REAL, source TEXT, wc REAL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS mg_product_cost (product_id INTEGER PRIMARY KEY, pool_id INTEGER, spend_2026 REAL, unit_cost REAL, note TEXT)").run();
  try { await db.prepare("ALTER TABLE mg_labor_day ADD COLUMN owner REAL").run(); } catch (e) {}
  try { await db.prepare("ALTER TABLE mg_material_alloc ADD COLUMN material_est INTEGER").run(); } catch (e) {}
  await db.prepare("CREATE TABLE IF NOT EXISTS mg_time_override (customer_number INTEGER PRIMARY KEY, crew_minutes REAL, note TEXT)").run();
  await db.batch([
    db.prepare("DELETE FROM mg_material_alloc"),
    // Visits with no product recorded get estimated uses (Ty 2026-10-27): the typical amount per 1,000 sq ft of each product
    // on that same service code (products seen on 5+ visits), times the lawn size; service calls get T-Zone at 1.2 oz per 1,000.
    // Estimated uses join the same spend pools, so season material totals do not change; they only move to the right visits.
    // Grass seed (Ty 2026-10-28): RealGreen records a default 7 lb per 1,000 on some seed jobs and nothing on others, so recorded
    // seed (product 58) is ignored and every seeding service gets 3 lb per 1,000 sq ft x lawn size.
    db.prepare("WITH ru0 AS (SELECT s.id sid, s.service_code code, CAST(json_extract(j.value,'$.id') AS INT) pid, CAST(json_extract(j.value,'$.amt') AS REAL) amt, CAST(json_extract(j.value,'$.area') AS REAL) area FROM mg_services s, json_each(s.products) j WHERE s.is_reversed=0), " +
      "ru AS (SELECT sid, code, pid, amt, area FROM ru0 WHERE pid <> 58 UNION ALL SELECT id, service_code, 58, 3.0 * COALESCE(size,0), COALESCE(size,0) FROM mg_services WHERE is_reversed=0 AND service_code IN ('COF','CAO','OVS','PSF','PSS','SSF','SSS')), " +
      "ref AS (SELECT code, pid, SUM(amt) / NULLIF(SUM(area),0) rt FROM ru0 WHERE amt > 0 AND pid <> 58 GROUP BY code, pid HAVING COUNT(DISTINCT sid) >= 5), " +
      "vu AS (SELECT s.id sid, ref.pid, COALESCE(s.size,0) * ref.rt amt, COALESCE(s.size,0) area FROM mg_services s JOIN ref ON ref.code = s.service_code WHERE s.is_reversed=0 AND s.products='[]' AND s.service_code NOT LIKE 'SC%' " +
      "UNION ALL SELECT s.id, 1071, COALESCE(s.size,0) * 1.2, COALESCE(s.size,0) FROM mg_services s WHERE s.is_reversed=0 AND s.products='[]' AND s.service_code LIKE 'SC%'), " +
      "au AS (SELECT sid, pid, amt, area, 0 est FROM ru UNION ALL SELECT sid, pid, amt, area, 1 est FROM vu), " +
      "u AS (SELECT au.sid, COALESCE(c.pool_id, -1) pool, au.amt, au.area, au.est FROM au LEFT JOIN mg_product_cost c ON c.product_id = au.pid), " +
      "r AS (SELECT pool, SUM(CASE WHEN amt>0 THEN amt ELSE 0 END) / NULLIF(SUM(CASE WHEN amt>0 THEN area ELSE 0 END),0) rate FROM u GROUP BY pool), " +
      "w AS (SELECT u.sid, u.pool, u.est, CASE WHEN u.amt>0 THEN u.amt WHEN r.rate IS NOT NULL THEN COALESCE(u.area,0)*r.rate ELSE COALESCE(u.area,0) END wt FROM u JOIN r ON r.pool=u.pool), " +
      "t AS (SELECT pool, SUM(wt) tw FROM w GROUP BY pool) " +
      "INSERT INTO mg_material_alloc (service_id, material, material_unpriced_uses, material_est) SELECT s.id, COALESCE((SELECT SUM(w.wt * MIN(pc.spend_2026 / NULLIF(t.tw,0), COALESCE(pc.unit_cost, 1e9))) FROM w JOIN t ON t.pool=w.pool JOIN mg_product_cost pc ON pc.product_id=w.pool WHERE w.sid=s.id AND w.pool<>-1),0), (SELECT COUNT(*) FROM w WHERE w.sid=s.id AND w.pool=-1), COALESCE((SELECT MAX(w.est) FROM w WHERE w.sid=s.id),0) FROM mg_services s WHERE s.is_reversed=0"),
    db.prepare("DELETE FROM mg_labor_alloc"),
    // Large properties (Ty approved 2026-10-28): stops with a known crew time (mg_time_override, from Hunter) or 20,000+ sq ft
    // (estimated crew minutes = 50 + 2.92 per 1,000 sq ft) get crew minutes x that day's cost per paid minute, capped at 90% of
    // the day when other stops exist. The rest of the day is split over the other stops: half per stop, half by lawn size.
    db.prepare("INSERT INTO mg_labor_alloc (service_id, labor_day, labor_pool) " +
      "WITH st AS (SELECT done_date, customer_number, MAX(COALESCE(size,0)) sz, SUM(COALESCE(total_amount,0)) amt, COUNT(*) cnt, SUM(CASE WHEN COALESCE(total_amount,0) <= 0 THEN 1 ELSE 0 END) z FROM mg_services WHERE is_reversed=0 GROUP BY done_date, customer_number), " +
      "st2 AS (SELECT st.*, COALESCE(o.crew_minutes, CASE WHEN st.sz >= 20 THEN 50 + 2.92 * st.sz END) cm FROM st LEFT JOIN mg_time_override o ON o.customer_number = st.customer_number), " +
      "dl AS (SELECT day, cost + COALESCE(wc,0) + COALESCE(owner,0) tot, COALESCE(minutes,0) + COALESCE(owner,0) / 27.86 * 60 mins FROM mg_labor_day), " +
      "dy AS (SELECT done_date, SUM(CASE WHEN cm IS NULL THEN 1 ELSE 0 END) ns, SUM(CASE WHEN cm IS NULL THEN sz ELSE 0 END) k, SUM(COALESCE(cm,0)) km FROM st2 GROUP BY done_date), " +
      "dz AS (SELECT dy.*, dl.tot, dl.mins, CASE WHEN dy.km = 0 OR dl.mins IS NULL OR dl.mins = 0 THEN 0 WHEN dy.ns = 0 THEN dl.mins / dy.km ELSE MIN(1.0, 0.9 * dl.mins / dy.km) END sc FROM dy LEFT JOIN dl ON dl.day = dy.done_date), " +
      "sl AS (SELECT st2.done_date, st2.customer_number, st2.amt, st2.cnt, st2.z, CASE WHEN dz.tot IS NULL THEN NULL WHEN st2.cm IS NOT NULL THEN st2.cm * dz.sc * dz.tot / NULLIF(dz.mins,0) " +
      "ELSE (dz.tot - COALESCE(dz.km * dz.sc * dz.tot / NULLIF(dz.mins,0), 0)) * (0.5 / dz.ns + 0.5 * COALESCE(st2.sz / NULLIF(dz.k,0), 1.0 / dz.ns)) END lab FROM st2 JOIN dz ON dz.done_date = st2.done_date) " +
      // Within a stop (Ty 2026-10-28): $0 services (free spot seed, a service call during a visit) get an even share; paid services split the rest by price.
      "SELECT s.id, sl.lab * (CASE WHEN sl.amt <= 0 THEN 1.0 / sl.cnt WHEN COALESCE(s.total_amount,0) <= 0 THEN 1.0 / sl.cnt ELSE (1.0 - 1.0 * sl.z / sl.cnt) * s.total_amount / sl.amt END), 0 " +
      "FROM mg_services s JOIN sl ON sl.done_date=s.done_date AND sl.customer_number=s.customer_number WHERE s.is_reversed=0"),
    db.prepare("UPDATE mg_labor_alloc SET labor_pool = (SELECT COALESCE(SUM(cost + COALESCE(wc,0) + COALESCE(owner,0)),0) FROM mg_labor_day WHERE day NOT IN (SELECT DISTINCT done_date FROM mg_services WHERE is_reversed=0)) * (SELECT COALESCE(total_amount,0) FROM mg_services WHERE id=service_id) / (SELECT SUM(COALESCE(total_amount,0)) FROM mg_services WHERE is_reversed=0 AND done_date <= (SELECT MAX(day) FROM mg_labor_day)) WHERE service_id IN (SELECT id FROM mg_services WHERE done_date <= (SELECT MAX(day) FROM mg_labor_day))")
  ]);
  // Spend not used up at invoice unit cost is product still in stock (Ty 2026-10-27: never charge more per unit than the invoice price).
  const sp = await db.prepare("SELECT COALESCE(SUM(spend_2026),0) s FROM mg_product_cost").first();
  const al = await db.prepare("SELECT COALESCE(SUM(material),0) m FROM mg_material_alloc").first();
  await sSet(env, "mg_stock", JSON.stringify({ spend: Math.round(sp.s * 100) / 100, used: Math.round(al.m * 100) / 100, stock: Math.round((sp.s - al.m) * 100) / 100, at: new Date().toISOString() }));
  await sSet(env, "mg_recomputed_at", new Date().toISOString());
}
