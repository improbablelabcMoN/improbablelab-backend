import NodeCache from 'node-cache';
import { logger } from '../index.js';

const caches = {
  lineups:   new NodeCache({ stdTTL: Number(process.env.CACHE_TTL_LINEUPS)   || 900  }),
  standings: new NodeCache({ stdTTL: Number(process.env.CACHE_TTL_STANDINGS) || 3600 }),
  stats:     new NodeCache({ stdTTL: Number(process.env.CACHE_TTL_STATS)     || 1800 }),
  news:      new NodeCache({ stdTTL: Number(process.env.CACHE_TTL_NEWS)      || 600  }),
};

export async function cached(type, key, fetcher) {
  const cache = caches[type];
  if (!cache) throw new Error(`Unknown cache type: ${type}`);
  const hit = cache.get(key);
  if (hit !== undefined) { logger.info(`CACHE HIT [${type}] ${key}`); return hit; }
  logger.info(`CACHE MISS [${type}] ${key} — fetching...`);
  const data = await fetcher();
  cache.set(key, data);
  return data;
}

export function invalidate(type, key) { caches[type]?.del(key); }
