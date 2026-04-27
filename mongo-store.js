const { MongoClient } = require('mongodb');

const SEARCH_PROJECTION = {
  uuid: 1,
  locale: 1,
  name: 1,
  original_name: 1,
  personality: 1,
  bio: 1,
  greeting: 1,
  description: 1,
  updatedAt: 1,
};

class MongoLocalizationStore {
  constructor(config = {}) {
    this.uri = config.uri;
    this.dbName = config.dbName;
    this.collectionName = config.collectionName;
    this.client = null;
    this.collection = null;
  }

  async connect() {
    if (!this.uri) {
      throw new Error('Missing MONGODB_URI');
    }
    if (!this.dbName) {
      throw new Error('Missing MONGODB_DB');
    }
    if (!this.collectionName) {
      throw new Error('Missing MONGODB_COLLECTION');
    }

    if (this.collection) return this.collection;

    this.client = new MongoClient(this.uri, {
      maxPoolSize: 10,
      minPoolSize: 1,
    });

    await this.client.connect();
    this.collection = this.client.db(this.dbName).collection(this.collectionName);
    return this.collection;
  }

  async fetchAllLocalizations() {
    const collection = await this.connect();
    return collection
      .find({}, { projection: SEARCH_PROJECTION })
      .sort({ updatedAt: -1, _id: 1 })
      .toArray();
  }

  async close() {
    if (this.client) {
      await this.client.close();
    }
    this.client = null;
    this.collection = null;
  }
}

module.exports = {
  MongoLocalizationStore,
};
