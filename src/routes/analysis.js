/**
 * /api/analysis — AI-powered match analysis
 * Uses Perplexity sonar (web search nativo, aggiornato in tempo reale)
 * Cache: 30 min in-memory Map
 */

import { Router } from 'express';
import { logger } from '../index.js';

const router = Router();

const PERPLEXITY_API = 'https://api.perplexity.ai/chat/completions';
const MODEL = 'sonar';
const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_ANALYSIS) || 1800) * 1000;

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
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error('PERPLEXITY_API_KEY not set in environment');

  const systemPrompt = `Sei un analista calcistico esperto con accesso alle notizie più recenti. Il tuo compito principale è trovare TUTTI gli infortuni, squalifiche e assenze certe o probabili per la partita richiesta. Rispondi SOLO con un oggetto JSON valido, senza testo prima o dopo, senza markdown, senza backtick.`;

  const userPrompt = `Analizza la partita: ${home} vs ${away} (${league}), ${date} ore ${time || 'TBD'}.

PRIORITA ASSOLUTA - cerca notizie di OGGI e degli ultimi 2 giorni su:
1. Infortuni confermati o sospetti (chi si e allenato, chi no, chi e in dubbio)
2. Squalifiche (diffide, espulsioni nelle partite precedenti)
3. Giocatori rientrati da infortuni (potrebbero non essere al 100%)
4. Dichiarazioni dell'allenatore in conferenza stampa
5. Solo dopo: notizie di forma generale, mercato, precedenti

Per ogni giocatore assente o in dubbio, specifica se e CERTO (confirmed_out) o DUBBIO (doubt).

Restituisci SOLO questo JSON:

{
  "stadium": {
    "name": "nome stadio",
    "city": "citta",
    "capacity": 12345,
    "surface": "erba naturale",
    "note": "breve nota atmosfera"
  },
  "news": [
    {
      "type": "injury|suspension|doubt|return|form|tactical|transfer|other",
      "team": "nome squadra",
      "player": "nome giocatore o null",
      "status": "confirmed_out|doubt|returning|available|suspended",
      "text": "notizia precisa, cita la fonte se possibile",
      "impact": "high|medium|low",
      "source_hint": "es: conferenza stampa 05/03, Sky Sport, Gazzetta"
    }
  ],
  "absences_summary": {
    "${home}": ["lista nomi giocatori CERTI assenti"],
    "${away}": ["lista nomi giocatori CERTI assenti"]
  },
  "doubts_summary": {
    "${home}": ["lista nomi giocatori IN DUBBIO"],
    "${away}": ["lista nomi giocatori IN DUBBIO"]
  },
  "lineup_reasoning": {
    "home": "2-3 frasi sul probabile modulo tenendo conto degli infortuni e dichiarazioni",
    "away": "2-3 frasi sul probabile modulo tenendo conto degli infortuni e dichiarazioni"
  },
  "tactical_analysis": "3-4 frasi: punti di forza, debolezze, matchup chiave",
  "forecast": {
    "home_win": 45,
    "draw": 28,
    "away_win": 27,
    "reasoning": "1-2 frasi pronostico considerando gli assenti e la forma recente",
    "key_factor": "il fattore decisivo della partita in una frase"
  },
  "last_meetings": [
    { "date": "YYYY-MM-DD", "result": "2-1", "winner": "home|away|draw" }
  ],
  "generated_at": "${new Date().toISOString()}"
}

Ordina le news per impatto (high prima, poi medium, poi low). Le news su infortuni e squalifiche vengono prima di tutto. Le percentuali forecast devono sommare a 100 esatti.`;

  const response = await fetch(PERPLEXITY_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 1500,
      temperature: 0.2,
      search_recency_filter: 'day',
      return_citations: false,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    if (response.status === 429) {
      logger.warn(`Perplexity rate limit — waiting 30s before retry...`);
      await new Promise(r => setTimeout(r, 30000));
      const retry = await fetch(PERPLEXITY_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 2000,
          temperature: 0.1,
          search_recency_filter: 'day',
          return_citations: true,
        }),
      });
      if (!retry.ok) {
        const retryErr = await retry.text();
        throw new Error(`Perplexity API error ${retry.status}: ${retryErr}`);
      }
      const retryData = await retry.json();
      return parseResponse(retryData);
    }
    throw new Error(`Perplexity API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return parseResponse(data);
}

function parseResponse(data) {
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('No text response from Perplexity');
  const raw = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON found in Perplexity response');
  return JSON.parse(raw.slice(start, end + 1));
}

function startJob(cacheKey, params) {
  if (jobStatus.get(cacheKey) === 'pending') return;
  jobStatus.set(cacheKey, 'pending');
  logger.info(`CACHE MISS [analysis] ${cacheKey} — fetching from Perplexity...`);

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

router.get('/', (req, res) => {
  const { home, away, league, date, time } = req.query;
  if (!home || !away || !league || !date) {
    return res.status(400).json({ error: 'Missing required params' });
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
