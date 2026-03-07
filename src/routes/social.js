/**
 * /api/social — Social & news updates via Perplexity
 * Endpoint separato, non tocca analysis.js
 * Cache: 30 min in-memory Map
 */

import { Router } from 'express';
import { logger } from '../index.js';

const router = Router();

const PERPLEXITY_API = 'https://api.perplexity.ai/chat/completions';
const MODEL = 'sonar';
const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_SOCIAL) || 1800) * 1000;

const doneCache = new Map();
const jobStatus = new Map();

function cacheGet(key) {
  const entry = doneCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { doneCache.delete(key); return null; }
  return entry.data;
}

function cacheSet(key, data) {
  doneCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// Mappa account X per squadra — Premier League
const SOCIAL_SOURCES = {
  // Premier League
  'Arsenal':           '@afcstuff',
  'Manchester City':   '@City_Xtra',
  'Liverpool':         '@thisisanfield',
  'Chelsea':           '@AbsoluteChelsea',
  'Manchester United': '@UtdDistrict',
  'Tottenham':         '@thespursweb',
  'Aston Villa':       '@villareport',
  'Newcastle':         '@NUFC360',
  'West Ham':          '@ExWHUEmployee',
  'Everton':           '@toffeetvefc',
  'Brighton':          '@BHAFCxtra',
  'Nottm Forest':      '@ForestReport',
  'Crystal Palace':    '@PalaceXtra',
  'Wolves':            '@WolvesXtra',
  'Fulham':            '@FulhamFC_News',
  'Brentford':         '@BrentfordTweet',
  'Bournemouth':       '@AFCBxtra',
};

function getSocialSources(team) {
  if (!team) return null;
  const t = team.toLowerCase();
  for (const [key, handle] of Object.entries(SOCIAL_SOURCES)) {
    if (t.includes(key.toLowerCase()) || key.toLowerCase().includes(t)) {
      return handle;
    }
  }
  return null;
}

async function fetchSocialUpdates({ home, away, league, date }) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error('PERPLEXITY_API_KEY not set');

  const today = new Date().toISOString().slice(0, 10);
  const homeHandle = getSocialSources(home);
  const awayHandle = getSocialSources(away);
  const sourcesHint = [homeHandle, awayHandle].filter(Boolean).join(', ');
  const sourcesLine = sourcesHint
    ? `Cerca anche negli account X: ${sourcesHint}`
    : `Cerca da fonti giornalistiche attendibili per ${league}`;

  const prompt = `Cerca le ultime notizie degli ultimi 7 giorni su ${home} vs ${away} (${league}, ${date}).
${sourcesLine}

Includi: infortuni, squalifiche, rientri, conferenze stampa allenatore, stato di forma, notizie tattiche.
Data oggi: ${today}.

Rispondi SOLO con un array JSON valido, senza testo prima o dopo, senza markdown, senza backtick.
Formato:
[
  {
    "team": "nome squadra",
    "source_name": "nome fonte o account",
    "source_type": "official|journalist|insider|media",
    "reliability": "high|medium",
    "text": "testo notizia in italiano",
    "player": "nome giocatore o null",
    "signal": "injury|starter|doubt|return|tactics|other",
    "published_at": "YYYY-MM-DDTHH:mm:ssZ o null"
  }
]

Produci almeno 3 aggiornamenti se esistono notizie. Se non ci sono notizie rilevanti restituisci [].`;

  const response = await fetch(PERPLEXITY_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1200,
      temperature: 0.1,
      search_recency_filter: 'week',
      return_citations: false,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Perplexity error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content || '';
  const raw = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  return JSON.parse(raw.slice(start, end + 1));
}

function startJob(cacheKey, params) {
  if (jobStatus.get(cacheKey) === 'pending') return;
  jobStatus.set(cacheKey, 'pending');
  logger.info(`CACHE MISS [social] ${cacheKey} — fetching...`);

  fetchSocialUpdates(params)
    .then(updates => {
      cacheSet(cacheKey, updates);
      jobStatus.delete(cacheKey);
      logger.info(`CACHE SET [social] ${cacheKey} — ${updates.length} updates`);
    })
    .catch(err => {
      jobStatus.set(cacheKey, `error:${err.message}`);
      logger.error(`Social error [${cacheKey}]: ${err.message}`);
      setTimeout(() => jobStatus.delete(cacheKey), 30000);
    });
}

router.get('/', (req, res) => {
  const { home, away, league, date } = req.query;
  if (!home || !away || !league || !date) {
    return res.status(400).json({ error: 'Missing required params' });
  }

  const cacheKey = `social__${league}__${home}__${away}__${date}`.toLowerCase().replace(/\s+/g, '_');

  const cached = cacheGet(cacheKey);
  if (cached) {
    logger.info(`CACHE HIT [social] ${cacheKey}`);
    return res.json({ ok: true, status: 'done', updates: cached });
  }

  const status = jobStatus.get(cacheKey);
  if (status?.startsWith('error:')) {
    return res.json({ ok: false, status: 'error', updates: [] });
  }

  startJob(cacheKey, { home, away, league, date });
  return res.status(202).json({ ok: true, status: 'pending', jobId: cacheKey });
});

export default router;
