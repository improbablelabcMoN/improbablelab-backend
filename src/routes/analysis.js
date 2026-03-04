/**
 * /api/analysis  — AI-powered match analysis
 * Uses Claude claude-sonnet-4-20250514 + web_search
 * Cache: 30 min in-memory Map (no external dependencies)
 */

import { Router } from 'express';
import { logger } from '../index.js';

const router = Router();

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';
const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_ANALYSIS) || 1800) * 1000;

// Simple in-memory cache: key → { data, expiresAt }
const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { cache.delete(key); return null; }
  return entry.data;
}

function cacheSet(key, data) {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function generateAnalysis({ home, away, league, date, time }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in environment');

  const prompt = `Sei un analista calcistico esperto. Analizza la partita: ${home} vs ${away} — ${league}, ${date} ore ${time || 'TBD'}.

Cerca informazioni aggiornate su questa partita e restituisci SOLO un oggetto JSON valido, senza testo prima o dopo, con questa struttura:

{
  "stadium": {
    "name": "nome stadio",
    "city": "città",
    "capacity": 12345,
    "surface": "erba naturale",
    "note": "breve nota atmosfera/tifoseria"
  },
  "news": [
    { "type": "injury|suspension|form|transfer|other", "team": "nome squadra", "player": "nome giocatore o null", "text": "testo notizia breve", "impact": "high|medium|low" }
  ],
  "lineup_reasoning": {
    "home": "2-3 frasi sul probabile modulo e scelte tattiche della squadra di casa",
    "away": "2-3 frasi sul probabile modulo e scelte tattiche della squadra ospite"
  },
  "tactical_analysis": "3-4 frasi sull'analisi tattica della partita: punti di forza, debolezze, matchup chiave",
  "forecast": {
    "home_win": 45,
    "draw": 28,
    "away_win": 27,
    "reasoning": "1-2 frasi che spiegano il pronostico",
    "key_factor": "il fattore decisivo della partita in una frase"
  },
  "last_meetings": [
    { "date": "YYYY-MM-DD", "result": "2-1", "winner": "home|away|draw" }
  ],
  "generated_at": "${new Date().toISOString()}"
}

Sii preciso, usa dati reali cercati sul web. Per le percentuali forecast assicurati che sommino a 100.`;

  const response = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${err}`);
  }

  const data = await response.json();

  const textBlock = data.content?.find(b => b.type === 'text');
  if (!textBlock?.text) throw new Error('No text response from Claude');

  const raw = textBlock.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON found in Claude response');

  return JSON.parse(raw.slice(start, end + 1));
}

router.get('/', async (req, res) => {
  const { home, away, league, date, time } = req.query;

  if (!home || !away || !league || !date) {
    return res.status(400).json({ error: 'Missing required params: home, away, league, date' });
  }

  const cacheKey = `${league}__${home}__${away}__${date}`.toLowerCase().replace(/\s+/g, '_');

  const cached = cacheGet(cacheKey);
  if (cached) {
    logger.info(`CACHE HIT [analysis] ${cacheKey}`);
    return res.json({ ok: true, analysis: cached });
  }

  logger.info(`CACHE MISS [analysis] ${cacheKey} — fetching from Claude...`);

  try {
    const analysis = await generateAnalysis({ home, away, league, date, time });
    cacheSet(cacheKey, analysis);
    res.json({ ok: true, analysis });
  } catch (err) {
    logger.error(`Analysis error [${cacheKey}]: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
