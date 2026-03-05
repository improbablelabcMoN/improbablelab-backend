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

  const systemPrompt = `Sei un analista calcistico esperto. Rispondi SOLO con un oggetto JSON valido, senza testo prima o dopo, senza markdown, senza backtick. Non includere mai notizie generiche o ovvie — solo fatti concreti, specifici e verificabili.`;

  const userPrompt = `Analizza la partita: ${home} vs ${away} — ${league}, ${date} ore ${time || 'TBD'}.

Cerca informazioni REALI e SPECIFICHE degli ultimi 7 giorni. 

Per il campo "news", inserisci SOLO notizie concrete:
- Infortuni e assenze CONFERMATE con nome giocatore specifico
- Squalifiche (chi ha preso il cartellino rosso o ha raggiunto la diffida)  
- Rientri da infortunio (chi torna disponibile)
- Dichiarazioni dell'allenatore in conferenza stampa su formazione/assenti
- Forma recente (ultime 3-5 partite) SOLO se rilevante per le scelte

NON inserire nelle news: frasi generiche tipo "partita importante", "sfida attesa", 
"match di cartello", orari della partita, o informazioni ovvie. 
Ogni news deve citare un fatto specifico con nome, data o fonte.

Restituisci SOLO questo JSON (struttura identica):

{
  "stadium": {
    "name": "nome stadio",
    "city": "città",
    "capacity": 12345,
    "surface": "erba naturale",
    "note": "breve nota atmosfera/tifoseria"
  },
  "news": [
    { "type": "injury|suspension|form|transfer|other", "team": "nome squadra", "player": "nome giocatore o null", "text": "fatto specifico con dettaglio concreto, es: out per lesione muscolare dal 28/02", "impact": "high|medium|low" }
  ],
  "lineup_reasoning": {
    "home": "2-3 frasi sul probabile modulo e scelte tattiche della squadra di casa basate su dati recenti",
    "away": "2-3 frasi sul probabile modulo e scelte tattiche della squadra ospite basate su dati recenti"
  },
  "tactical_analysis": "3-4 frasi sull'analisi tattica: punti di forza, debolezze, matchup chiave",
  "forecast": {
    "home_win": 45,
    "draw": 28,
    "away_win": 27,
    "reasoning": "1-2 frasi che spiegano il pronostico basato su forma recente e statistiche",
    "key_factor": "il fattore decisivo della partita in una frase"
  },
  "last_meetings": [
    { "date": "YYYY-MM-DD", "result": "2-1", "winner": "home|away|draw" }
  ],
  "generated_at": "${new Date().toISOString()}"
}

Ordina le news per impatto: prima injury e suspension (high), poi form e transfer (medium/low).
Le percentuali forecast devono sommare esattamente a 100.`;

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
      max_tokens: 1800,
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
          max_tokens: 1800,
          temperature: 0.2,
          search_recency_filter: 'day',
          return_citations: false,
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
    const errMsg = status.slice(6);
    logger.warn(`[analysis] returning error to client: ${errMsg}`);
    // Ritorna 200 con flag error invece di 500, il frontend gestisce gracefully
    return res.json({ ok: false, status: 'error', error: errMsg });
  }

  startJob(cacheKey, { home, away, league, date, time });
  return res.status(202).json({ ok: true, status: 'pending', jobId: cacheKey });
});

export default router;
