// Margin tab data (D1 tables written by lawndoctor-margin). Added 2026-10-27.
async function marginView(env) {
  const DB = env.DB;
  const sv = async function (k, d) { const r = await DB.prepare("SELECT v FROM settings WHERE k=?").bind(k).first(); return r && r.v ? r.v : d; };
  const thru = await sv("mg_labor_through", "2026-10-25");
  let rc = { royalty_pct: 9.98, card_pct: 3.53 };
  try { rc = Object.assign(rc, JSON.parse(await sv("mg_rev_costs", "{}"))); } catch (e) {}
  const feeK = (Number(rc.royalty_pct) + Number(rc.card_pct)) / 100;
  const base = " FROM mg_services s JOIN mg_labor_alloc a ON a.service_id=s.id JOIN mg_material_alloc m ON m.service_id=s.id WHERE s.is_reversed=0 AND s.done_date <= ?";
  const cols = "COUNT(*) n, SUM(COALESCE(s.total_amount,0)) rev, SUM(m.material) mat, SUM(COALESCE(a.labor_day,0)+a.labor_pool) lab, SUM(m.material_unpriced_uses>0) unp";
  const grp = "CASE WHEN s.service_code IN ('M1','M2','M3','M4','M5','M6') THEN 'Lawn Maintainer ' || substr(s.service_code,2) WHEN s.service_code IN ('GCP','GCN','GCC') THEN 'Grub control' WHEN s.service_code IN ('COF','CAF','CAS','CAO','OVS') THEN 'Aeration and seed' WHEN s.service_code LIKE 'PP%' THEN 'Perimeter pest' WHEN s.service_code LIKE 'HG%' THEN 'Hydraguard' WHEN s.service_code LIKE 'OL%' OR s.service_code LIKE 'OW%' THEN 'Off-lawn weed' WHEN s.service_code LIKE 'BW%' THEN 'Bed weed' WHEN s.service_code LIKE 'TS%' THEN 'Tree and shrub' WHEN s.service_code LIKE 'MC%' THEN 'Mosquito' WHEN s.service_code LIKE 'SC%' THEN 'Service calls (no charge)' WHEN s.service_code='SBO' THEN 'Sprinkler blowout' ELSE 'Other' END";
  const all = async function (sql) { return (await DB.prepare(sql).bind(thru).all()).results; };
  const fin = function (r) { const rev = r.rev || 0, fees = rev * feeK, mg = rev - (r.mat || 0) - (r.lab || 0) - fees; return Object.assign({}, r, { fees: fees, margin: mg, pct: rev > 0 ? mg / rev : null }); };
  const total = fin((await all("SELECT " + cols + base))[0]);
  const byService = (await all("SELECT " + grp + " g, " + cols + base + " GROUP BY g ORDER BY rev DESC")).map(fin);
  const byMonth = (await all("SELECT substr(s.done_date,1,7) g, " + cols + base + " GROUP BY g ORDER BY g")).map(fin);
  const sizeRows = (await all("SELECT CASE WHEN k < 4 THEN '1|Under 4,000 sq ft' WHEN k < 6 THEN '2|4,000 to 6,000' WHEN k < 8 THEN '3|6,000 to 8,000' WHEN k < 12 THEN '4|8,000 to 12,000' ELSE '5|12,000 and up' END g, COUNT(*) n, SUM(rev) rev, SUM(mat) mat, SUM(lab) lab FROM (SELECT s.customer_number c, MAX(s.size) k, SUM(COALESCE(s.total_amount,0)) rev, SUM(m.material) mat, SUM(COALESCE(a.labor_day,0)+a.labor_pool) lab" + base + " AND s.service_code IN ('M1','M2','M3','M4','M5','M6') GROUP BY c HAVING rev > 0) GROUP BY g ORDER BY g")).map(fin);
  const cust = (await all("SELECT s.customer_number c, MAX(s.size) k, " + cols + base + " GROUP BY c HAVING rev > 0")).map(fin);
  const r2 = function (x) { return x === null || x === undefined ? x : Math.round(x * 100) / 100; };
  const cs = (await all("SELECT s.customer_number c, " + grp + " g, " + cols + base + " GROUP BY c, g")).map(fin);
  const byC = {};
  cs.forEach(function (r) { (byC[r.c] = byC[r.c] || []).push({ g: r.g, n: r.n, rev: r2(r.rev), mat: r2(r.mat), lab: r2(r.lab), fees: r2(r.fees), margin: r2(r.margin), pct: r.pct === null ? null : Math.round(r.pct * 10000) / 10000, unp: r.unp }); });
  cust.forEach(function (r) { r.svc = byC[r.c] || []; });
  let names = {};
  try { names = JSON.parse((await env.DASHBOARD.get(NAME_CACHE_KEY)) || "{}"); } catch (e) {}
  let sd = null; try { sd = JSON.parse((await env.DASHBOARD.get(SEGMENT_DETAIL_KEY)) || "null"); } catch (e) {}
  cust.forEach(function (r) { const info = sd && sd.customers ? sd.customers[r.c] : null; r.name = (info && info.n) || names[r.c] || ("#" + r.c); });
  const svcCalls = byService.find(function (r) { return /^Service calls/.test(r.g); }) || null;
  const unpricedUses = (await DB.prepare("SELECT SUM(material_unpriced_uses) u FROM mg_material_alloc a JOIN mg_services s ON s.id=a.service_id WHERE s.done_date <= ?").bind(thru).first()).u || 0;
  const note = await sv("mg_labor_note", "");
  return { thru: thru, rates: rc, total: total, byService: byService, byMonth: byMonth, bySize: sizeRows, customers: cust, serviceCalls: svcCalls, unpricedUses: unpricedUses, laborNote: note, generatedAt: new Date().toISOString() };
}
