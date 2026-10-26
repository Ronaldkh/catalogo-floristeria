import express from 'express';
import { google } from 'googleapis';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = {
  port: Number(process.env.PORT || 3000),
  sheetId: (process.env.SHEET_ID || '').trim(),
  sheetTab: (process.env.SHEET_TAB || 'catalogo').trim(),
  sheetRange: (process.env.SHEET_RANGE || 'A:Z').trim(),
  pollIntervalMs: Math.max(15000, Number(process.env.POLL_INTERVAL_MS || 45000)),
  credentialsPath:
    process.env.GOOGLE_APPLICATION_CREDENTIALS || '/run/secrets/gcp_service_account',
};

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

const POSITIONAL_COLUMNS = new Map([
  ['id', 0],
  ['nombre', 1],
  ['categoria', 2],
  ['precio', 3],
  ['descripcion', 4],
  ['imagen', 5],
  ['disponible', 6],
]);

const HEADER_ALIASES = {
  id: ['id', 'codigo', 'sku'],
  nombre: ['nombre', 'producto', 'titulo'],
  categoria: ['categoria', 'tipo'],
  precio: ['precio', 'valor', 'price'],
  descripcion: ['descripcion', 'detalle'],
  imagen: ['imagen', 'foto', 'url', 'image'],
  disponible: ['disponible', 'activo', 'estado'],
};

const state = {
  products: [],
  signature: null,
  updatedAt: null,
  lastCheckedAt: null,
  stale: false,
  lastError: null,
  lastAttemptAt: null,
  loading: false,
};

let server = null;
let timer = null;
let sheetsClient = null;

function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function buildHeaderMap(headerRow) {
  const normalized = headerRow.map(normalize);
  const map = new Map();
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const index = normalized.findIndex((header) => aliases.includes(header));
    if (index !== -1) map.set(key, index);
  }
  return map;
}

function parseDisponible(value) {
  const normalized = normalize(value);
  if (!normalized) return true;
  return !['no', 'false', '0', 'agotado', 'inactivo'].includes(normalized);
}

function mapRow(row, headerMap, rowNumber) {
  const get = (key) => {
    const index = headerMap.get(key);
    return index === undefined ? '' : (row[index] ?? '');
  };

  const nombre = String(get('nombre')).trim();
  if (!nombre) return null;

  return {
    id: String(get('id')).trim() || String(rowNumber),
    nombre,
    categoria: String(get('categoria')).trim(),
    precio: String(get('precio')).trim(),
    descripcion: String(get('descripcion')).trim(),
    imagen: String(get('imagen')).trim(),
    disponible: parseDisponible(get('disponible')) ? 'si' : 'no',
  };
}

function parseRows(rows) {
  if (rows.length === 0) return [];

  const headerMap = buildHeaderMap(rows[0]);
  const hasHeader = headerMap.has('nombre');
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const columns = hasHeader ? headerMap : POSITIONAL_COLUMNS;

  return dataRows
    .map((row, index) => mapRow(row, columns, index + 1))
    .filter(Boolean);
}

function getSheetsClient() {
  if (!sheetsClient) {
    const auth = new google.auth.GoogleAuth({
      keyFile: config.credentialsPath,
      scopes: [SHEETS_SCOPE],
    });
    sheetsClient = google.sheets({ version: 'v4', auth });
  }
  return sheetsClient;
}

async function fetchCatalog() {
  if (!config.sheetId) {
    throw new Error('SHEET_ID no configurado en .env');
  }

  const range = `${config.sheetTab}!${config.sheetRange}`;
  const response = await getSheetsClient().spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range,
    valueRenderOption: 'FORMATTED_VALUE',
  });

  return parseRows(response.data.values || []);
}

async function refresh({ reason = 'poll' } = {}) {
  if (state.loading) return;
  state.loading = true;
  state.lastAttemptAt = new Date().toISOString();

  try {
    const products = await fetchCatalog();
    const signature = JSON.stringify(products);
    const contentChanged = signature !== state.signature || !state.updatedAt;

    state.products = products;
    state.signature = signature;
    state.lastCheckedAt = new Date().toISOString();
    state.stale = false;
    state.lastError = null;

    if (contentChanged) {
      state.updatedAt = state.lastCheckedAt;
      console.log(`[catalogo] ${products.length} producto(s) actualizados (${reason}).`);
    }
  } catch (error) {
    state.lastError = error.message;
    if (state.products.length > 0) state.stale = true;
    console.error(`[catalogo] Error al leer la hoja (${reason}):`, error.message);
  } finally {
    state.loading = false;
  }
}

function cacheAgeSeconds() {
  if (!state.updatedAt) return null;
  return Math.round((Date.now() - Date.parse(state.updatedAt)) / 1000);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: Boolean(state.updatedAt),
    count: state.products.length,
    updatedAt: state.updatedAt,
    lastCheckedAt: state.lastCheckedAt,
    ageSeconds: cacheAgeSeconds(),
    stale: state.stale,
    loading: state.loading,
    lastAttemptAt: state.lastAttemptAt,
    lastError: state.lastError,
    sheetConfigured: Boolean(config.sheetId),
    pollIntervalMs: config.pollIntervalMs,
  });
});

app.get('/api/catalogo', (req, res) => {
  if (!state.updatedAt) {
    return res.status(503).json({
      data: [],
      updatedAt: null,
      stale: true,
      error: state.lastError || 'Catálogo todavía no disponible',
    });
  }

  const etag = `W/"${Date.parse(state.updatedAt)}-${state.products.length}"`;
  res.setHeader('Cache-Control', 'public, max-age=30');
  res.setHeader('ETag', etag);

  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }

  return res.json({
    data: state.products,
    updatedAt: state.updatedAt,
    stale: state.stale,
    count: state.products.length,
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

app.use(
  express.static(path.join(__dirname, 'public'), {
    index: 'index.html',
    etag: true,
    dotfiles: 'deny',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }
    },
  }),
);

app.use((req, res) => {
  res.status(404).send('No encontrado');
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function start() {
  console.log(`[catalogo] Iniciando backend en el puerto ${config.port}.`);

  if (!config.sheetId) {
    state.lastError = 'SHEET_ID no configurado en .env';
    console.warn(
      '[catalogo] SHEET_ID vacío: completa .env, coloca la clave de servicio y reinicia.',
    );
  } else {
    await Promise.race([refresh({ reason: 'inicio' }), delay(10000)]);
  }

  server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`[catalogo] Escuchando en http://0.0.0.0:${config.port}.`);
    console.log(`[catalogo] Relectura de la hoja cada ${config.pollIntervalMs} ms.`);
  });

  if (config.sheetId) {
    timer = setInterval(() => {
      void refresh({ reason: 'poll' });
    }, config.pollIntervalMs);
  }
}

function shutdown(signal) {
  console.log(`[catalogo] ${signal} recibido, cerrando.`);
  if (timer) clearInterval(timer);
  if (!server) {
    process.exit(0);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

void start();
