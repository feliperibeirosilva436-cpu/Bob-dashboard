'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || process.env.DASHBOARD_PORT || 3847);
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const VIEW_KEY = process.env.VIEW_KEY || process.env.DASHBOARD_VIEW_KEY || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'tenants.json');
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (_) {}
  return { tenants: {}, ingestKeys: {} };
}
function save(db) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
let DB = load();

function json(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Ingest-Key, X-Admin-Key, X-View-Key, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
function headerKey(req, name) {
  const h = req.headers[name.toLowerCase()] || req.headers.authorization || '';
  return String(h).replace(/^Bearer\s+/i, '').trim();
}
function isOnline(t, maxSec = 180) {
  if (!t?.lastSeen) return false;
  return Date.now() - Number(t.lastSeen) < maxSec * 1000;
}
function publicTenant(t) {
  if (!t) return null;
  const online = isOnline(t);
  const status = t.manutencao ? 'manutencao' : online ? 'online' : 'offline';
  return {
    id: t.id, nome: t.nome || t.id, status, online: status === 'online',
    manutencao: Boolean(t.manutencao), servidoresAtivos: Number(t.servidoresAtivos || 0),
    lastSeen: t.lastSeen || null, avatar: t.avatar || null, botTag: t.botTag || null,
    metrics: t.metrics || null,
  };
}
function checkView(req, url) {
  if (!VIEW_KEY) return true;
  const vk = headerKey(req, 'x-view-key') || url.searchParams.get('viewKey') || url.searchParams.get('key') || '';
  return vk === VIEW_KEY;
}

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Ingest-Key, X-Admin-Key, X-View-Key, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (p === '/api/ingest' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const key = headerKey(req, 'x-ingest-key') || String(body.key || '').trim();
      const tenantId = String(body.tenantId || body.id || '').trim().slice(0, 64);
      if (!tenantId || !key) return json(res, 400, { ok: false, error: 'tenantId e key obrigatórios' });
      const known = DB.ingestKeys[tenantId];
      if (known && known !== key) return json(res, 401, { ok: false, error: 'invalid_key' });
      if (!known) DB.ingestKeys[tenantId] = key;
      const prev = DB.tenants[tenantId] || { id: tenantId };
      DB.tenants[tenantId] = {
        ...prev, id: tenantId,
        nome: body.nome || body.nomeLoja || prev.nome || tenantId,
        manutencao: Boolean(body.manutencao),
        servidoresAtivos: Number(body.servidoresAtivos ?? body.guilds ?? prev.servidoresAtivos ?? 0),
        avatar: body.avatar || prev.avatar || null,
        botTag: body.botTag || prev.botTag || null,
        botId: body.botId || prev.botId || null,
        metrics: body.metrics || prev.metrics || null,
        lastSeen: Date.now(),
        updatedAt: new Date().toISOString(),
      };
      save(DB);
      return json(res, 200, { ok: true, tenantId });
    } catch (e) {
      return json(res, 400, { ok: false, error: String(e.message || e) });
    }
  }

  if (p === '/api/register' && req.method === 'POST') {
    if (ADMIN_KEY) {
      const admin = headerKey(req, 'x-admin-key');
      if (admin !== ADMIN_KEY) return json(res, 401, { ok: false, error: 'admin_only' });
    }
    try {
      const body = await readBody(req);
      const tenantId = String(body.tenantId || '').trim().slice(0, 64);
      if (!tenantId) return json(res, 400, { ok: false, error: 'tenantId' });
      const key = String(body.key || crypto.randomBytes(16).toString('hex'));
      DB.ingestKeys[tenantId] = key;
      if (!DB.tenants[tenantId]) DB.tenants[tenantId] = { id: tenantId, nome: body.nome || tenantId, lastSeen: 0 };
      save(DB);
      return json(res, 200, { ok: true, tenantId, key });
    } catch (e) {
      return json(res, 400, { ok: false, error: String(e.message || e) });
    }
  }

  if (p === '/api/health') {
    return json(res, 200, { ok: true, tenants: Object.keys(DB.tenants).length });
  }
  if (p === '/api/auth/config') {
    return json(res, 200, { ok: true, needsViewKey: Boolean(VIEW_KEY) });
  }

  if (p === '/api/overview' || p === '/api/tenants') {
    if (!checkView(req, url)) return json(res, 401, { ok: false, error: 'view_key_required' });
    const list = Object.values(DB.tenants).map(publicTenant);
    let receita = 0, pedidos = 0, produtos = 0, servers = 0;
    for (const t of list) {
      const m = t.metrics || {};
      receita += Number(m.faturamentoTotal || 0);
      pedidos += Number(m.pedidosAprovados ?? m.pedidosEntregues ?? 0);
      produtos += Number(m.produtosEntregues || 0);
      servers += Number(t.servidoresAtivos || 0);
    }
    const tenantQ = url.searchParams.get('tenant');
    let serie = [];
    if (tenantQ && DB.tenants[tenantQ]?.metrics?.serieDiaria) {
      serie = DB.tenants[tenantQ].metrics.serieDiaria;
    } else {
      const map = {};
      for (const t of Object.values(DB.tenants)) {
        for (const d of t.metrics?.serieDiaria || []) {
          if (!map[d.dia]) map[d.dia] = { dia: d.dia, receita: 0, pedidos: 0 };
          map[d.dia].receita += Number(d.receita || 0);
          map[d.dia].pedidos += Number(d.pedidos || 0);
        }
      }
      serie = Object.values(map).sort((a, b) => String(a.dia).localeCompare(String(b.dia)));
    }
    const focus = tenantQ && DB.tenants[tenantQ] ? publicTenant(DB.tenants[tenantQ]) : null;
    const mFocus = focus?.metrics;
    return json(res, 200, {
      ok: true,
      tenants: list,
      totals: {
        faturamentoTotal: focus ? Number(mFocus?.faturamentoTotal || 0) : receita,
        pedidosAprovados: focus ? Number(mFocus?.pedidosAprovados ?? mFocus?.pedidosEntregues ?? 0) : pedidos,
        produtosEntregues: focus ? Number(mFocus?.produtosEntregues || 0) : produtos,
        servidoresAtivos: focus ? Number(focus.servidoresAtivos || 0) : servers,
      },
      periodo: focus?.metrics?.periodo || null,
      serieDiaria: serie,
      selected: focus,
    });
  }

  if (p.startsWith('/api/tenant/')) {
    if (!checkView(req, url)) return json(res, 401, { ok: false, error: 'view_key_required' });
    const id = decodeURIComponent(p.slice('/api/tenant/'.length));
    const t = publicTenant(DB.tenants[id]);
    if (!t) return json(res, 404, { ok: false, error: 'not_found' });
    return json(res, 200, { ok: true, tenant: t });
  }
  return json(res, 404, { ok: false, error: 'not_found' });
}

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.js')) return 'application/javascript; charset=utf-8';
  return 'application/octet-stream';
}
function handleStatic(req, res, url) {
  const root = path.join(__dirname, 'public');
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(root, rel);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': contentType(file) });
  fs.createReadStream(file).pipe(res);
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    return handleStatic(req, res, url);
  } catch (e) {
    console.error(e);
    json(res, 500, { ok: false, error: 'internal' });
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`[dashboard] http://0.0.0.0:${PORT}`);
  if (VIEW_KEY) console.log('[dashboard] senha de visitante (VIEW_KEY) ativa');
});
