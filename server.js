const http = require('node:http');
const { URL } = require('node:url');
const { LocalizationSearchEngine } = require('./search-engine');
const { MongoLocalizationStore } = require('./mongo-store');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const REFRESH_INTERVAL_MS = Math.max(
  60 * 1000,
  Number(process.env.REFRESH_INTERVAL_MS) || 60 * 60 * 1000,
);

const store = new MongoLocalizationStore({
  uri: process.env.MONGODB_URI,
  dbName: process.env.MONGODB_DB,
  charactersCollectionName: process.env.MONGODB_COLLECTION_CHARACTERS || 'characters',
  localizationsCollectionName:
    process.env.MONGODB_COLLECTION_LOCALIZATIONS
    || process.env.MONGODB_COLLECTION
    || 'characterlocalizations',
});

const state = {
  engine: new LocalizationSearchEngine([]),
  lastLoadedAt: null,
  lastRefreshStartedAt: null,
  lastRefreshFinishedAt: null,
  lastRefreshReason: null,
  lastRefreshError: null,
  reloadInFlight: null,
};

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function getValidatedSearchInput(query, locale, limitRaw) {
  const queryText = String(query || '');
  if (!queryText.trim()) {
    return {
      ok: false,
      error: 'Missing query parameter `q`',
      example: '/search?q=mafia&locale=pt-BR&limit=10',
    };
  }

  return {
    ok: true,
    query: queryText,
    locale: String(locale || ''),
    limit: Number(limitRaw || 20),
  };
}

async function reloadIndex(reason = 'manual') {
  if (state.reloadInFlight) return state.reloadInFlight;

  state.lastRefreshStartedAt = new Date().toISOString();
  state.lastRefreshReason = reason;
  state.lastRefreshError = null;

  state.reloadInFlight = (async () => {
    const rows = await store.fetchAllSearchDocuments();
    const nextEngine = new LocalizationSearchEngine(rows);
    state.engine = nextEngine;
    state.lastLoadedAt = new Date().toISOString();
    state.lastRefreshFinishedAt = state.lastLoadedAt;
    return {
      size: nextEngine.size,
      lastLoadedAt: state.lastLoadedAt,
    };
  })();

  try {
    return await state.reloadInFlight;
  } catch (error) {
    state.lastRefreshError = error.message;
    throw error;
  } finally {
    state.reloadInFlight = null;
  }
}

function scheduleRefresh() {
  return setInterval(async () => {
    try {
      await reloadIndex('scheduled');
      // eslint-disable-next-line no-console
      console.log('[search-api] Scheduled MongoDB refresh finished');
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[search-api] Scheduled MongoDB refresh failed: ${error.message}`);
    }
  }, REFRESH_INTERVAL_MS);
}

function runSearch(res, query, locale, limit) {
  const engine = state.engine;
  if (!query.trim()) {
    return sendJson(res, 400, {
      error: 'Missing query parameter `q`',
      example: '/search?q=mafia&locale=pt-BR&limit=10',
    });
  }

  const started = process.hrtime.bigint();
  const results = engine.search(query, { locale, limit });
  const elapsedNs = process.hrtime.bigint() - started;
  const tookMs = Number(elapsedNs) / 1_000_000;

  return sendJson(res, 200, {
    query,
    locale: locale || null,
    total: results.length,
    tookMs: Number(tookMs.toFixed(3)),
    lastLoadedAt: state.lastLoadedAt,
    results,
  });
}

function handleSearchGet(res, requestUrl) {
  const input = getValidatedSearchInput(
    requestUrl.searchParams.get('q'),
    requestUrl.searchParams.get('locale'),
    requestUrl.searchParams.get('limit'),
  );
  if (!input.ok) return sendJson(res, 400, input);
  return runSearch(res, input.query, input.locale, input.limit);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large (max 1MB)'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', (error) => reject(error));
  });
}

async function handleSearchPost(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }

  const input = getValidatedSearchInput(body.q, body.locale, body.limit);
  if (!input.ok) return sendJson(res, 400, input);
  return runSearch(res, input.query, input.locale, input.limit);
}

async function handleReload(res) {
  try {
    const result = await reloadIndex('manual');
    return sendJson(res, 200, {
      ok: true,
      message: 'Index reloaded from MongoDB',
      size: result.size,
      lastLoadedAt: result.lastLoadedAt,
    });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      error: error.message,
      lastLoadedAt: state.lastLoadedAt,
    });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && requestUrl.pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      size: state.engine.size,
      dataSource: 'mongodb',
      mongoDb: process.env.MONGODB_DB || null,
      mongoCollections: {
        characters: process.env.MONGODB_COLLECTION_CHARACTERS || 'characters',
        localizations:
          process.env.MONGODB_COLLECTION_LOCALIZATIONS
          || process.env.MONGODB_COLLECTION
          || 'characterlocalizations',
      },
      refreshIntervalMs: REFRESH_INTERVAL_MS,
      lastLoadedAt: state.lastLoadedAt,
      lastRefreshStartedAt: state.lastRefreshStartedAt,
      lastRefreshFinishedAt: state.lastRefreshFinishedAt,
      lastRefreshReason: state.lastRefreshReason,
      lastRefreshError: state.lastRefreshError,
      reloading: Boolean(state.reloadInFlight),
    });
  }

  if (req.method === 'GET' && requestUrl.pathname === '/search') {
    return handleSearchGet(res, requestUrl);
  }

  if (req.method === 'POST' && requestUrl.pathname === '/search') {
    return handleSearchPost(req, res);
  }

  if ((req.method === 'POST' || req.method === 'GET') && requestUrl.pathname === '/reload') {
    return handleReload(res);
  }

  return sendJson(res, 404, {
    error: 'Not Found',
    endpoints: [
      'GET /health',
      'GET /search?q=keyword&locale=xx&limit=10',
      'POST /search { q, locale?, limit? }',
      'POST /reload',
    ],
  });
});

async function start() {
  await reloadIndex('startup');
  scheduleRefresh();

  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`[search-api] Listening on http://${HOST}:${PORT}`);
    // eslint-disable-next-line no-console
    console.log(
      `[search-api] Loaded ${state.engine.size} records from MongoDB ${process.env.MONGODB_DB}.${process.env.MONGODB_COLLECTION_CHARACTERS || 'characters'} + ${process.env.MONGODB_DB}.${process.env.MONGODB_COLLECTION_LOCALIZATIONS || process.env.MONGODB_COLLECTION || 'characterlocalizations'}`,
    );
  });
}

async function shutdown(signal) {
  // eslint-disable-next-line no-console
  console.log(`[search-api] Received ${signal}, closing MongoDB connection`);
  server.close(async () => {
    await store.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((error) => {
    // eslint-disable-next-line no-console
    console.error(`[search-api] Shutdown failed: ${error.message}`);
    process.exit(1);
  });
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => {
    // eslint-disable-next-line no-console
    console.error(`[search-api] Shutdown failed: ${error.message}`);
    process.exit(1);
  });
});

start().catch(async (error) => {
  // eslint-disable-next-line no-console
  console.error(`[search-api] Failed to start: ${error.message}`);
  await store.close();
  process.exit(1);
});
