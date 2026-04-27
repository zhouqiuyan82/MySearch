const FIELD_WEIGHTS = {
  name: 12,
  original_name: 10,
  personality: 8,
  bio: 5,
  greeting: 4,
  description: 2,
  locale: 1,
};

const SEARCH_FIELDS = Object.keys(FIELD_WEIGHTS);
const CJK_REGEX = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isCjk(text) {
  return CJK_REGEX.test(text);
}

function tokenize(text) {
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const chunks = normalized.match(/\p{L}+|\p{N}+/gu) || [];
  const tokens = [];

  for (const chunk of chunks) {
    if (isCjk(chunk)) {
      const chars = Array.from(chunk);
      for (const char of chars) {
        tokens.push(char);
      }
      if (chars.length > 1) {
        for (let i = 0; i < chars.length - 1; i += 1) {
          tokens.push(chars[i] + chars[i + 1]);
        }
      }
      continue;
    }

    tokens.push(chunk);
    if (chunk.length >= 6) {
      tokens.push(chunk.slice(0, 4));
    }
  }

  return tokens;
}

function tokenBoost(token) {
  if (isCjk(token)) {
    return token.length === 1 ? 0.7 : 1.1;
  }
  if (token.length <= 2) return 0.5;
  if (token.length <= 4) return 0.9;
  return 1.2;
}

function shortText(value, size = 140) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= size) return text;
  return `${text.slice(0, size)}...`;
}

class LocalizationSearchEngine {
  constructor(rows) {
    this.rawRows = Array.isArray(rows) ? rows : [];
    this.docs = [];
    this.invertedIndex = new Map();
    this._buildIndex();
  }

  _buildIndex() {
    const postings = new Map();

    this.docs = this.rawRows.map((item, id) => {
      const doc = {
        id,
        uuid: item.uuid,
        locale: item.locale,
        name: item.name || '',
        original_name: item.original_name || '',
        personality: Array.isArray(item.personality) ? item.personality : [],
        bio: item.bio || '',
        greeting: item.greeting || '',
        description: item.description || '',
      };

      const fieldTexts = {
        name: doc.name,
        original_name: doc.original_name,
        personality: doc.personality.join(' '),
        bio: doc.bio,
        greeting: doc.greeting,
        description: doc.description,
        locale: doc.locale || '',
      };

      doc.normalized = {};
      doc.tokens = {};
      doc.fullText = '';

      for (const field of SEARCH_FIELDS) {
        const text = fieldTexts[field] || '';
        const normalized = normalizeText(text);
        doc.normalized[field] = normalized;
        doc.fullText += ` ${normalized}`;

        const uniqueTokens = new Set(tokenize(normalized));
        doc.tokens[field] = uniqueTokens;
        for (const token of uniqueTokens) {
          if (!postings.has(token)) postings.set(token, []);
          postings.get(token).push({
            id,
            field,
            weight: FIELD_WEIGHTS[field],
          });
        }
      }

      doc.fullText = doc.fullText.trim();
      return doc;
    });

    this.invertedIndex = postings;
  }

  search(query, options = {}) {
    const q = normalizeText(query);
    if (!q) return [];

    const localeFilter = normalizeText(options.locale || '');
    const limit = Math.max(1, Math.min(Number(options.limit) || 20, 100));

    const queryTokens = Array.from(new Set(tokenize(q)));
    const scores = new Map();
    const matchedTokenCounts = new Map();
    const matchedFields = new Map();

    for (const token of queryTokens) {
      const postingList = this.invertedIndex.get(token);
      if (!postingList) continue;

      for (const posting of postingList) {
        const doc = this.docs[posting.id];
        if (!doc) continue;
        if (localeFilter && normalizeText(doc.locale) !== localeFilter) continue;

        const score = scores.get(posting.id) || 0;
        scores.set(posting.id, score + posting.weight * tokenBoost(token));

        const tokenCount = matchedTokenCounts.get(posting.id) || 0;
        matchedTokenCounts.set(posting.id, tokenCount + 1);

        if (!matchedFields.has(posting.id)) matchedFields.set(posting.id, new Set());
        matchedFields.get(posting.id).add(posting.field);
      }
    }

    const results = [];
    for (const [docId, baseScore] of scores.entries()) {
      const doc = this.docs[docId];
      if (!doc) continue;

      let score = baseScore;
      const coverage = (matchedTokenCounts.get(docId) || 0) / (queryTokens.length || 1);
      score *= 0.6 + coverage;

      const nameNorm = doc.normalized.name || '';
      const originalNameNorm = doc.normalized.original_name || '';
      const nameTokens = doc.tokens.name || new Set();

      const isExactName = nameNorm === q;
      const isNamePrefix = !isExactName && nameNorm.startsWith(q);
      const isNameContains = !isExactName && !isNamePrefix && nameNorm.includes(q);

      const isExactOriginalName = originalNameNorm === q;
      const isOriginalNameContains = !isExactOriginalName && originalNameNorm.includes(q);

      let nameTokenHitCount = 0;
      for (const token of queryTokens) {
        if (nameTokens.has(token)) nameTokenHitCount += 1;
      }

      // Name matches should dominate ranking for multilingual aliases.
      if (isExactName) score += 160;
      else if (isNamePrefix) score += 100;
      else if (isNameContains) score += 60;

      if (isExactOriginalName) score += 120;
      else if (isOriginalNameContains) score += 50;

      if (nameTokenHitCount > 0) {
        score += 15 * (nameTokenHitCount / (queryTokens.length || 1));
      }

      if (doc.fullText.includes(q)) score += 10;

      const fields = Array.from(matchedFields.get(docId) || []);
      const snippetBase = doc.bio || doc.greeting || doc.description || doc.name;
      const rankTier = isExactName
        ? 5
        : isNamePrefix
          ? 4
          : isNameContains
            ? 3
            : isExactOriginalName
              ? 2
              : isOriginalNameContains
                ? 1
                : 0;

      results.push({
        uuid: doc.uuid,
        locale: doc.locale,
        name: doc.name,
        original_name: doc.original_name,
        personality: doc.personality,
        score: Number(score.toFixed(2)),
        matchedFields: fields,
        snippet: shortText(snippetBase),
        _rankTier: rankTier,
      });
    }

    results.sort((a, b) => {
      if (b._rankTier !== a._rankTier) return b._rankTier - a._rankTier;
      return b.score - a.score;
    });

    return results.slice(0, limit).map((item) => {
      const { _rankTier, ...rest } = item;
      return rest;
    });
  }

  get size() {
    return this.docs.length;
  }
}

module.exports = {
  LocalizationSearchEngine,
  normalizeText,
  tokenize,
};
