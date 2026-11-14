/**
 * Cloudflare Worker: secure proxy for Ozon Seller API.
 * Required bindings/secrets:
 *   OZON_CLIENT_ID (secret)
 *   OZON_API_KEY   (secret)
 *   APP_TOKEN      (secret; long random password shared only with the app)
 *   APP_ORIGIN     (text; e.g. https://rdp21242-art.github.io)
 */
const OZON = 'https://api-seller.ozon.ru';

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.APP_ORIGIN || '').replace(/\/$/, '');
  const ok = !!allowed && origin === allowed;
  return {
    'Access-Control-Allow-Origin': ok ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function json(data, status, cors) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors } });
}
async function ozon(env, path, body) {
  const response = await fetch(OZON + path, {
    method: 'POST',
    headers: {
      'Client-Id': env.OZON_CLIENT_ID,
      'Api-Key': env.OZON_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body || {})
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!response.ok) {
    const message = data?.message || data?.error || raw || `Ozon HTTP ${response.status}`;
    throw new Error(`Ozon ${response.status}: ${message}`);
  }
  if (data?.error || (data?.code && Number(data.code) !== 0)) {
    throw new Error(data.message || data.error || 'Ozon API вернул ошибку');
  }
  return data;
}
function resultOf(data) { return data?.result || data || {}; }
function arrOf(data, ...keys) {
  const root = resultOf(data);
  for (const key of keys) {
    if (Array.isArray(root?.[key])) return root[key];
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
}
async function getWarehouses(env) {
  let cursor = '';
  const all = [];
  for (let page = 0; page < 20; page++) {
    const data = await ozon(env, '/v2/warehouse/list', { limit: 100, cursor });
    const root = resultOf(data);
    const items = arrOf(data, 'warehouses', 'items');
    all.push(...items);
    const next = root.cursor || data.cursor || '';
    const hasNext = root.has_next ?? data.has_next ?? !!next;
    if (!hasNext || !next || next === cursor || items.length === 0) break;
    cursor = next;
  }
  return all.map(w => ({
    warehouse_id: Number(w.warehouse_id || w.id),
    name: w.name || w.warehouse_name || `Склад ${w.warehouse_id || w.id}`,
    is_rfbs: !!w.is_rfbs,
    is_3pl: !!w.is_3pl,
    status: w.status || ''
  })).filter(w => Number.isFinite(w.warehouse_id) && w.warehouse_id > 0);
}
async function getAllProducts(env) {
  let lastId = '';
  const basic = [];
  for (let page = 0; page < 100; page++) {
    const data = await ozon(env, '/v3/product/list', {
      filter: { visibility: 'ALL' },
      limit: 1000,
      last_id: lastId
    });
    const root = resultOf(data);
    const items = arrOf(data, 'items');
    basic.push(...items);
    const next = root.last_id || data.last_id || '';
    if (!next || next === lastId || items.length === 0 || items.length < 1000) break;
    lastId = next;
  }
  const valid = basic.filter(p => p && p.offer_id && (p.product_id || p.id));
  const details = [];
  for (let i = 0; i < valid.length; i += 1000) {
    const ids = valid.slice(i, i + 1000).map(p => Number(p.product_id || p.id)).filter(Number.isFinite);
    if (!ids.length) continue;
    const data = await ozon(env, '/v3/product/info/list', { product_id: ids });
    details.push(...arrOf(data, 'items'));
  }
  const detailById = new Map(details.map(d => [String(d.id || d.product_id), d]));
  const merged = valid.map(p => {
    const id = Number(p.product_id || p.id);
    const d = detailById.get(String(id)) || {};
    return {
      product_id: id,
      offer_id: String(p.offer_id || d.offer_id || ''),
      sku: Number(p.sku || d.sku || 0),
      name: d.name || p.name || p.offer_id,
      archived: !!(p.archived || d.is_archived || d.archived),
      has_fbs_stocks: !!p.has_fbs_stocks,
      is_discounted: !!(p.is_discounted || d.is_discounted)
    };
  }).filter(p => p.offer_id && p.product_id && !p.archived);
  // offer_id is the seller's article and must uniquely identify a scanned label.
  const seen = new Set();
  for (const p of merged) {
    if (seen.has(p.offer_id)) throw new Error(`В каталоге Ozon повторяется артикул ${p.offer_id}. Синхронизация остановлена для безопасности.`);
    seen.add(p.offer_id);
  }
  return merged;
}
async function getFbsStocks(env, skus) {
  const all = [];
  const unique = [...new Set(skus.map(Number).filter(n => Number.isFinite(n) && n > 0))];
  for (let i = 0; i < unique.length; i += 1000) {
    const batch = unique.slice(i, i + 1000);
    if (!batch.length) continue;
    const data = await ozon(env, '/v2/product/info/stocks-by-warehouse/fbs', { sku: batch });
    all.push(...arrOf(data, 'products', 'items', 'stocks'));
  }
  return all;
}
async function catalog(env) {
  const [warehouses, products] = await Promise.all([getWarehouses(env), getAllProducts(env)]);
  if (!warehouses.length) throw new Error('Ozon не вернул склады FBS. Проверь права API-ключа и настройки склада.');
  const stocks = await getFbsStocks(env, products.map(p => p.sku));
  const stockByKey = new Map();
  for (const s of stocks) {
    const key = `${Number(s.warehouse_id)}:${Number(s.sku || s.product_id)}`;
    stockByKey.set(key, {
      present: Number(s.present ?? s.stock ?? 0),
      reserved: Number(s.reserved ?? 0),
      free_stock: Number(s.free_stock ?? Math.max(0, Number(s.present ?? s.stock ?? 0) - Number(s.reserved ?? 0)))
    });
  }
  const productOut = products.map(p => ({ ...p, warehouse_stocks: Object.fromEntries(warehouses.map(w => {
    const s = stockByKey.get(`${w.warehouse_id}:${p.sku}`) || { present: 0, reserved: 0, free_stock: 0 };
    return [String(w.warehouse_id), s];
  })) }));
  return { warehouses, products: productOut, fetched_at: new Date().toISOString() };
}
async function updateStocks(env, body) {
  const warehouseId = Number(body?.warehouse_id);
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!warehouseId || !items.length) throw new Error('Не указан склад или список товаров для обновления.');
  if (items.length > 5000) throw new Error('Слишком много товаров в одной операции.');
  for (const p of items) {
    if (!p.offer_id || !Number(p.product_id) || !Number.isInteger(Number(p.quantity)) || Number(p.quantity) < 0) {
      throw new Error('В списке есть товар с некорректным артикулом, ID или количеством. Отправка отменена.');
    }
  }
  // Re-read current reserved quantities immediately before writing. Ozon's stock field is the free-to-sell quantity;
  // reserved units are already included in physical present and must not be added a second time.
  const stockRows = await getFbsStocks(env, items.map(p => p.sku));
  const reservedBySku = new Map();
  for (const s of stockRows) {
    if (Number(s.warehouse_id) === warehouseId) reservedBySku.set(Number(s.sku || s.product_id), Number(s.reserved || 0));
  }
  const prepared = items.map(p => {
    const reserved = reservedBySku.get(Number(p.sku)) || 0;
    const physical = Number(p.quantity);
    const available = Math.max(0, physical - reserved);
    return {
      offer_id: String(p.offer_id),
      product_id: Number(p.product_id),
      stock: available,
      warehouse_id: warehouseId,
      physical_count: physical,
      reserved,
      reserved_exceeds_count: reserved > physical
    };
  });
  const results = [];
  for (let i = 0; i < prepared.length; i += 100) {
    const batch = prepared.slice(i, i + 100);
    const data = await ozon(env, '/v2/products/stocks', {
      stocks: batch.map(({ offer_id, product_id, stock, warehouse_id }) => ({ offer_id, product_id, stock, warehouse_id }))
    });
    const returned = arrOf(data, 'result', 'items');
    if (returned.length) {
      for (const r of returned) {
        const sent = batch.find(x => (r.offer_id && r.offer_id === x.offer_id) || (r.product_id && Number(r.product_id) === x.product_id));
        results.push({
          offer_id: r.offer_id || sent?.offer_id || '',
          product_id: Number(r.product_id || sent?.product_id || 0),
          quantity: sent?.physical_count ?? null,
          sent_stock: sent?.stock ?? null,
          reserved: sent?.reserved ?? 0,
          updated: !!r.updated && !(r.errors || []).length,
          errors: r.errors || [],
          reserved_exceeds_count: !!sent?.reserved_exceeds_count
        });
      }
      for (const sent of batch) if (!results.some(r => r.offer_id === sent.offer_id)) results.push({ offer_id: sent.offer_id, product_id: sent.product_id, quantity: sent.physical_count, sent_stock: sent.stock, reserved: sent.reserved, updated: false, errors: ['Ozon не вернул результат для товара'], reserved_exceeds_count: sent.reserved_exceeds_count });
    } else {
      // Never report success just because the HTTP request returned 200 without per-item confirmation.
      for (const sent of batch) results.push({ offer_id: sent.offer_id, product_id: sent.product_id, quantity: sent.physical_count, sent_stock: sent.stock, reserved: sent.reserved, updated: false, errors: ['В ответе Ozon отсутствует список результатов'], reserved_exceeds_count: sent.reserved_exceeds_count });
    }
  }
  return { warehouse_id: warehouseId, total: results.length, updated: results.filter(r => r.updated).length, failed: results.filter(r => !r.updated).length, results };
}
export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.APP_ORIGIN || '').replace(/\/$/, '');
    if (request.method === 'OPTIONS') return new Response(null, { status: origin === allowed && allowed ? 204 : 403, headers: cors });
    if (!allowed || origin !== allowed) return json({ error: 'Недопустимый источник запроса. Проверь APP_ORIGIN в Cloudflare.' }, 403, cors);
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404, cors);
    if (!env.OZON_CLIENT_ID || !env.OZON_API_KEY || !env.APP_TOKEN) return json({ error: 'Не заданы секреты OZON_CLIENT_ID, OZON_API_KEY или APP_TOKEN в Cloudflare.' }, 500, cors);
    if (request.headers.get('X-App-Token') !== env.APP_TOKEN) return json({ error: 'Неверный пароль доступа к приложению.' }, 401, cors);
    try {
      if (request.method === 'GET' && url.pathname === '/api/health') return json({ ok: true, service: 'ozon-inventory-api' }, 200, cors);
      if (request.method === 'POST' && url.pathname === '/api/catalog') return json(await catalog(env), 200, cors);
      if (request.method === 'POST' && url.pathname === '/api/stocks/update') {
        const body = await request.json();
        return json(await updateStocks(env, body), 200, cors);
      }
      return json({ error: 'Not found' }, 404, cors);
    } catch (e) {
      return json({ error: e?.message || 'Внутренняя ошибка Worker' }, 400, cors);
    }
  }
};
