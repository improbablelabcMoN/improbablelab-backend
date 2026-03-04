/**
 * /api/analysis — AI-powered match analysis
 * Uses Gemini 2.0 Flash + Google Search grounding (gratuito)
 * Cache: 30 min in-memory Map
 */

import { Router } from 'express';
import { logger } from '../index.js';

const router = Router();

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_ANALYSIS) || 1800) * 1000;

// Simple in-memory cache
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

async function generateAnalysis({ home, away, league, date, time }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set in environment');

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
    { "type": "injury", "team": "nome squadra", "player": "nome giocatore o null", "text": "testo notizia breve", "impact": "high|medium|low" }
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

Sii preciso, usa dati reali cercati sul web. Le percentuali forecast devono sommare a 100.`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 1500,
    },
  };

  const response = await fetch(`${GEMINI_API}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    // Rate limit → aspetta 30s e riprova
    if (response.status === 429) {
      logger.warn(`Gemini rate limit — waiting 30s before retry...`);
      await new Promise(r => setTimeout(r, 30000));
      const retry = await fetch(`${GEMINI_API}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!retry.ok) {
        const retryErr = await retry.text();
        throw new Error(`Gemini API error ${retry.status}: ${retryErr}`);
      }
      const retryData = await retry.json();
      return parseGeminiResponse(retryData);
    }
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return parseGeminiResponse(data);
}

function parseGeminiResponse(data) {
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('No text response from Gemini');

  const raw = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON found in Gemini response');

  return JSON.parse(raw.slice(start, end + 1));
}

function startJob(cacheKey, params) {
  if (jobStatus.get(cacheKey) === 'pending') return;
  jobStatus.set(cacheKey, 'pending');
  logger.info(`CACHE MISS [analysis] ${cacheKey} — fetching from Gemini...`);

  generateAnalysis(params)
    .then(analysis => {
      cacheSet(cacheKey, analysis);
      jobStatus.delete(cacheKey);
      logger.info(`CACHE SET [analysis] ${cacheKey}`);
    })
    .catch(err => {
      jobStatus.set(cacheKey, `error:${err.message}`);
      logger.error(`Analysis error [${cacheKey}]: ${err.message}`);
      setTimeout(() => jobStatus.delete(cacheKey), 30000);
    });
}

// GET /api/analysis?home=Roma&away=Milan&league=Serie+A&date=2026-03-01&time=20:45
router.get('/', (req, res) => {
  const { home, away, league, date, time } = req.query;

  if (!home || !away || !league || !date) {
    return res.status(400).json({ error: 'Missing required params: home, away, league, date' });
  }

  const cacheKey = `${league}__${home}__${away}__${date}`.toLowerCase().replace(/\s+/g, '_');

  const cached = cacheGet(cacheKey);
  if (cached) {
    logger.info(`CACHE HIT [analysis] ${cacheKey}`);
    return res.json({ ok: true, status: 'done', analysis: cached });
  }

  const status = jobStatus.get(cacheKey);
  if (status?.startsWith('error:')) {
    return res.status(500).json({ ok: false, status: 'error', error: status.slice(6) });
  }

  startJob(cacheKey, { home, away, league, date, time });
  return res.status(202).json({ ok: true, status: 'pending', jobId: cacheKey });
});

export default router;
