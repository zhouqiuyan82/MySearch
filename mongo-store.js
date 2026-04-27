const { Binary, MongoClient, UUID } = require('mongodb');

const COMMON_SEARCH_PROJECTION = {
  uuid: 1,
  name: 1,
  original_name: 1,
  personality: 1,
  bio: 1,
  greeting: 1,
  description: 1,
};

const CHARACTER_SEARCH_PROJECTION = {
  ...COMMON_SEARCH_PROJECTION,
};

const LOCALIZATION_SEARCH_PROJECTION = {
  ...COMMON_SEARCH_PROJECTION,
  uuid: 1,
  locale: 1,
};

const DEFAULT_ENGLISH_LOCALE = 'en';

function normalizeUuid(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value instanceof UUID) return value.toString();
  if (value instanceof Binary && typeof value.toUUID === 'function') {
    return value.toUUID().toString();
  }
  if (typeof value.toUUID === 'function') {
    return value.toUUID().toString();
  }
  return String(value);
}

function normalizeSearchDocument(item, localeFallback = '') {
  return {
    uuid: normalizeUuid(item.uuid),
    locale: String(item.locale || localeFallback || ''),
    name: item.name || '',
    original_name: item.original_name || '',
    personality: Array.isArray(item.personality) ? item.personality : [],
    bio: item.bio || '',
    greeting: item.greeting || '',
    description: item.description || '',
  };
}

function mergeSearchDocuments(existing, incoming) {
  if (!existing) return incoming;

  return {
    uuid: incoming.uuid || existing.uuid,
    locale: incoming.locale || existing.locale,
    name: incoming.name || existing.name,
    original_name: incoming.original_name || existing.original_name,
    personality: incoming.personality.length > 0 ? incoming.personality : existing.personality,
    bio: incoming.bio || existing.bio,
    greeting: incoming.greeting || existing.greeting,
    description: incoming.description || existing.description,
  };
}

class MongoLocalizationStore {
  constructor(config = {}) {
    this.uri = config.uri;
    this.dbName = config.dbName;
    this.charactersCollectionName = config.charactersCollectionName;
    this.localizationsCollectionName = config.localizationsCollectionName;
    this.client = null;
    this.collections = null;
  }

  async connect() {
    if (!this.uri) {
      throw new Error('Missing MONGODB_URI');
    }
    if (!this.dbName) {
      throw new Error('Missing MONGODB_DB');
    }
    if (!this.charactersCollectionName) {
      throw new Error('Missing MONGODB_COLLECTION_CHARACTERS');
    }
    if (!this.localizationsCollectionName) {
      throw new Error('Missing MONGODB_COLLECTION_LOCALIZATIONS');
    }

    if (this.collections) return this.collections;

    this.client = new MongoClient(this.uri, {
      maxPoolSize: 10,
      minPoolSize: 1,
    });

    await this.client.connect();
    const db = this.client.db(this.dbName);
    this.collections = {
      characters: db.collection(this.charactersCollectionName),
      localizations: db.collection(this.localizationsCollectionName),
    };
    return this.collections;
  }

  async fetchAllSearchDocuments() {
    const { characters, localizations } = await this.connect();
    const [characterRows, localizationRows] = await Promise.all([
      characters.find({}, { projection: CHARACTER_SEARCH_PROJECTION }).toArray(),
      localizations.find({}, { projection: LOCALIZATION_SEARCH_PROJECTION }).toArray(),
    ]);

    const merged = new Map();

    for (const row of characterRows) {
      const normalized = normalizeSearchDocument(row, DEFAULT_ENGLISH_LOCALE);
      const key = `${normalized.uuid}::${normalized.locale}`;
      merged.set(key, mergeSearchDocuments(merged.get(key), normalized));
    }

    for (const row of localizationRows) {
      const normalized = normalizeSearchDocument(row);
      const key = `${normalized.uuid}::${normalized.locale}`;
      merged.set(key, mergeSearchDocuments(merged.get(key), normalized));
    }

    return Array.from(merged.values());
  }

  async fetchAllLocalizations() {
    return this.fetchAllSearchDocuments();
  }

  async close() {
    if (this.client) {
      await this.client.close();
    }
    this.client = null;
    this.collections = null;
  }
}

module.exports = {
  MongoLocalizationStore,
};
