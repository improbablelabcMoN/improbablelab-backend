/**
 * /api/social — Social/X news per partita
 * Endpoint separato e indipendente da /api/analysis
 * Chiama Perplexity con un prompt focalizzato solo su notizie X/social pre-partita
 * Cache: 30 min (stesso TTL di analysis)
 */

import { Router } from 'express';
import { logger } from '../index.js';

const router = Router();

const PERPLEXITY_API = 'https://api.perplexity.ai/chat/completions';
const MODEL = 'sonar';
const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_ANALYSIS) || 1800) * 1000;

const doneCache = new Map();
const jobStatus = new Map();

// ── Mappa account X per squadra (Premier League) ─────────────────────────────
const SOCIAL_SOURCES = {
  premier_league: {
    _generic: ['@FFScoutCity', '@OptaJoe'],
    'Arsenal': ['@afcstuff'],
    'Manchester City': ['@City_Xtra'],
    'Liverpool': ['@thisisanfield'],
    'Chelsea': ['@AbsoluteChelsea'],
    'Manchester United': ['@UtdDistrict'],
    'Tottenham': ['@thespursweb'],
    'Aston Villa': ['@villareport'],
    'Newcastle': ['@NUFC360'],
    'West Ham': ['@ExWHUEmployee'],
    'Everton': ['@toffeetvefc'],
    'Brighton': ['@BHAFCxtra'],
    'Nottingham Forest': ['@ForestReport'],
    'Fulham': ['@FulhamFC_News'],
    'Wolves': ['@WolvesXtra'],
    'Crystal Palace': ['@PalaceXtra'],
    'Brentford': ['@BrentfordTweet'],
    'Bournemouth': ['@AFCBxtra'],
    'Ipswich': ['@IpswichExtra'],
    'Leeds': ['@LUFC_News'],
    'Sunderland': ['@SunderlandEcho'],
    'Burnley': ['@BurnleyFCNews'],
    'Leicester': ['@FoxesExtra'],
  },
};

function getSocialAccounts(league, home, away) {
  const map = SOCIAL_SOURCES[league];
  if (!map) return [];
  const accounts = [...(map._generic || [])];
  for (const [team, accs] of Object.entries(map)) {
    if (team === '_generic') continue;
    const t = team.toLowerCase();
    const h = home.toLowerCase();
    const a = away.toLowerCase();
    // match parziale: "Man City" trova "Manchester City" e viceversa
    if (h.includes(t) || t.includes(h) || h.includes(t.split(' ')[0])) accounts.push(...accs);
    if (a.includes(t) || t.includes(a) || a.includes(t.split(' ')[0])) accounts.push(...accs);
  }
  return [...new Set(accounts)];
}

// ── Cache helpers ─────────────────────────────────────────────────────────────
function cacheGet(key) {
  const entry = doneCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { doneCache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data) {
  doneCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ── Chiamata Perplexity dedicata al sociale ────────────────────────────────────
async function fetchSocialUpdates({ home, away, league, date }) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error('PERPLEXITY_API_KEY not set');

  const accounts = getSocialAccounts(league, home, away);
  const accountHint = accounts.length
    ? `Cerca su X/Twitter privilegiando questi account: ${accounts.join(', ')}.`
    : 'Cerca su X/Twitter e fonti sportive affidabili.';

  const systemPrompt = `Sei un esperto di calcio. Rispondi SOLO con un array JSON valido, senza testo prima o dopo, senza markdown, senza backtick.`;

  const userPrompt = `Partita: ${home} vs ${away} — ${league}, ${date}.

${accountHint}

Trova 4-6 aggiornamenti recenti (ultimi 5 giorni) rilevanti per questa partita specifica.
Focalizzati su: infortuni confermati, squalifiche, dichiarazioni di allenatori/giocatori, indisponibili, possibili titolari, forma recente.

Restituisci SOLO questo array JSON:

[
  {
    "account": "@handle o nome fonte",
    "team": "nome squadra (${home} o ${away}) o null se generico",
    "text": "testo dell'aggiornamento, specifico e informativo",
    "type": "injury|suspension|lineup|statement|form|other",
    "published_at": "YYYY-MM-DDTHH:MM:SSZ"
  }
]

Regole:
- Usa dati reali e verificabili, non inventare
- Se non trovi tweet specifici degli account indicati, usa qualsiasi fonte affidabile (Sky Sports, BBC Sport, The Athletic ecc.)
- Ogni item deve essere direttamente rilevante per questa partita
- published_at deve essere una data reale degli ultimi 5 giorni`;

  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 1200,
    temperature: 0.1,
    search_recency_filter: 'week',
    return_citations: false,
  };

  const call = async () => {
    const res = await fetch(PERPLEXITY_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      logger.warn('[social] rate limit — retry in 30s');
      await new Promise(r => setTimeout(r, 30000));
      const retry = await fetch(PERPLEXITY_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      if (!retry.ok) throw new Error(`Perplexity ${retry.status}`);
      return retry.json();
    }
    if (!res.ok) throw new Error(`Perplexity ${res.status}: ${await res.text()}`);
    return res.json();
  };

  const data = await call();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('No response from Perplexity');

  // Pulisce markdown e trova l'array JSON
  const raw = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const start = raw.indexOf('[');
  const end   = raw.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No JSON array in response');
  return JSON.parse(raw.slice(start, end + 1));
}

// ── Job runner async (stesso pattern di analysis.js) ─────────────────────────
function startJob(cacheKey, params) {
  if (jobStatus.get(cacheKey) === 'pending') return;
  jobStatus.set(cacheKey, 'pending');
  logger.info(`[social] CACHE MISS ${cacheKey} — fetching...`);

  fetchSocialUpdates(params)
    .then(updates => {
      cacheSet(cacheKey, updates);
      jobStatus.delete(cacheKey);
      logger.info(`[social] CACHE SET ${cacheKey} — ${updates.length} items`);
    })
    .catch(err => {
      jobStatus.set(cacheKey, `error:${err.message}`);
      logger.error(`[social] error ${cacheKey}: ${err.message}`);
      setTimeout(() => jobStatus.delete(cacheKey), 30000);
    });
}

// ── Route GET /api/social ──────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const { home, away, league, date } = req.query;
  if (!home || !away || !league || !date) {
    return res.status(400).json({ error: 'Missing required params: home, away, league, date' });
  }

  const cacheKey = `social__${league}__${home}__${away}__${date}`
    .toLowerCase().replace(/\s+/g, '_');

  const cached = cacheGet(cacheKey);
  if (cached) {
    logger.info(`[social] CACHE HIT ${cacheKey}`);
    return res.json({ ok: true, status: 'done', updates: cached });
  }

  const status = jobStatus.get(cacheKey);
  if (status?.startsWith('error:')) {
    return res.status(500).json({ ok: false, status: 'error', error: status.slice(6) });
  }

  startJob(cacheKey, { home, away, league, date });
  return res.status(202).json({ ok: true, status: 'pending', jobId: cacheKey });
});

export default router;
