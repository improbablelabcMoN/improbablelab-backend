/**
 * /api/fixtures — Calendario ufficiale partite
 *
 * Fonte A — API-Football  →  Serie A, Premier League  (piano free)
 *   Env: API_FOOTBALL_KEY
 *
 * Fonte B — football-data.org  →  La Liga, Bundesliga, Ligue 1, UCL, UEL  (piano free)
 *   Env: FOOTBALL_DATA_KEY
 */

import { Router } from 'express';
import { fetchJSON } from '../scrapers/http.js';
import { logger } from '../index.js';

const router = Router();

// ── Sorgenti per campionato ───────────────────────────────────────────────
const APF_BASE    = 'https://v3.football.api-sports.io';
const APF_LEAGUES = { serie_a: 135, premier_league: 39 };

const FDO_BASE    = 'https://api.football-data.org/v4';
const FDO_LEAGUES = {
  la_liga:          'PD',
  bundesliga:       'BL1',
  ligue_1:          'FL1',
  champions_league: 'CL',
  europa_league:    'EL',
};

// ── Cache ─────────────────────────────────────────────────────────────────
const cache = new Map();
function getCached(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { cache.delete(k); return null; }
  return e.data;
}
function setCached(k, d, ttl) { cache.set(k, { data: d, expiresAt: Date.now() + ttl }); }
function dynamicTTL(hasLive, hasToday, hasSoon) {
  if (hasLive)  return 60000;
  if (hasToday) return 300000;
  if (hasSoon)  return 900000;
  return 3600000;
}

// ── Stato partita ─────────────────────────────────────────────────────────
function normalizeStatus(s) {
  if (['1H','2H','HT','ET','P','BT','IN_PLAY','PAUSED','IN'].includes(s)) return 'live';
  if (['FT','AET','PEN','FINISHED'].includes(s))  return 'final';
  if (['PST','POSTPONED'].includes(s))             return 'postponed';
  if (['CANC','CANCELLED'].includes(s))            return 'cancelled';
  return 'scheduled';
}

// ── Round grouping ────────────────────────────────────────────────────────
function groupByRound(fixtures) {
  const rounds = {};
  for (const f of fixtures) {
    const r = f.round || 'N/D';
    if (!rounds[r]) rounds[r] = [];
    rounds[r].push(f);
  }
  return Object.entries(rounds)
    .map(([round, matches]) => ({
      round,
      matches: matches.sort((a,b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`)),
      firstDate: matches[0]?.date || '',
    }))
    .sort((a,b) => a.firstDate.localeCompare(b.firstDate));
}

// ════════════════════════════════════════════
//  FONTE A — API-Football
// ════════════════════════════════════════════

function apfTransform(f) {
  const raw  = f.fixture.date || '';
  const date = raw.slice(0,10);
  const tm   = raw.match(/T(\d{2}:\d{2})/);
  const time = tm ? tm[1] : '00:00';
  return {
    fixtureId: String(f.fixture.id),
    round:     f.league.round || 'N/D',
    date, time,
    staticStatus: normalizeStatus(f.fixture.status?.short || ''),
    elapsed:   f.fixture.status?.elapsed || null,
    home: { id: String(f.teams.home.id), name: f.teams.home.name, logo: f.teams.home.logo },
    away: { id: String(f.teams.away.id), name: f.teams.away.name, logo: f.teams.away.logo },
    score: { home: f.goals.home ?? null, away: f.goals.away ?? null },
    venue: f.fixture.venue?.name || null,
  };
}

async function fetchFromApf(league, apiKey) {
  const id   = APF_LEAGUES[league];
  const from = new Date(Date.now() - 21*86400000).toISOString().slice(0,10);
  const to   = new Date(Date.now() + 30*86400000).toISOString().slice(0,10);
  const url  = `${APF_BASE}/fixtures?league=${id}&season=2025&from=${from}&to=${to}`;
  logger.info(`[Fixtures/APF] ${url}`);
  const d = await fetchJSON(url, { headers: { 'x-apisports-key': apiKey } });
  return (d.response || []).map(apfTransform);
}

// ════════════════════════════════════════════
//  FONTE B — football-data.org
// ════════════════════════════════════════════

function fdoTransform(f) {
  // football-data.org → UTC, convertiamo in CET/CEST Italia
  let date = '', time = '00:00';
  if (f.utcDate) {
    const dt     = new Date(f.utcDate);
    // Offset CET (+1) — abbastanza preciso per la stagione corrente
    const local  = new Date(dt.getTime() + 3600000);
    date = local.toISOString().slice(0,10);
    time = local.toISOString().slice(11,16);
  }
  const round = f.matchday
    ? `Regular Season - ${f.matchday}`
    : (f.stage ? f.stage.replace(/_/g,' ') : 'N/D');

  return {
    fixtureId: String(f.id),
    round,
    date, time,
    staticStatus: normalizeStatus(f.status || ''),
    elapsed:   null,
    home: { id: String(f.homeTeam?.id||''), name: f.homeTeam?.name || f.homeTeam?.shortName || '', logo: f.homeTeam?.crest || null },
    away: { id: String(f.awayTeam?.id||''), name: f.awayTeam?.name || f.awayTeam?.shortName || '', logo: f.awayTeam?.crest || null },
    score: { home: f.score?.fullTime?.home ?? null, away: f.score?.fullTime?.away ?? null },
    venue: f.venue || null,
  };
}

async function fetchFromFdo(league, apiKey) {
  const code = FDO_LEAGUES[league];
  const from = new Date(Date.now() - 21*86400000).toISOString().slice(0,10);
  const to   = new Date(Date.now() + 30*86400000).toISOString().slice(0,10);
  const url  = `${FDO_BASE}/competitions/${code}/matches?dateFrom=${from}&dateTo=${to}`;
  logger.info(`[Fixtures/FDO] ${url}`);
  const d = await fetchJSON(url, { headers: { 'X-Auth-Token': apiKey } });
  return (d.matches || []).map(fdoTransform);
}

// ════════════════════════════════════════════
//  ROUTE PRINCIPALE
// ════════════════════════════════════════════

router.get('/', async (req, res) => {
  const { league = 'serie_a' } = req.query;
  const useApf = !!APF_LEAGUES[league];
  const useFdo = !!FDO_LEAGUES[league];
  if (!useApf && !useFdo)
    return res.status(400).json({ error: `League '${league}' non supportata` });

  const apfKey = process.env.API_FOOTBALL_KEY;
  const fdoKey = process.env.FOOTBALL_DATA_KEY;
  if (useApf && !apfKey) return res.status(503).json({ error: 'API_FOOTBALL_KEY mancante' });
  if (useFdo && !fdoKey) return res.status(503).json({ error: 'FOOTBALL_DATA_KEY mancante — aggiungila in Railway' });

  const cacheKey = `fx_${league}`;
  const cached   = getCached(cacheKey);
  if (cached) { logger.info(`CACHE HIT [fixtures] ${league}`); return res.json(cached); }

  try {
    const fixtures = useApf
      ? await fetchFromApf(league, apfKey)
      : await fetchFromFdo(league, fdoKey);

    if (!fixtures.length) {
      logger.warn(`[Fixtures] ${league}: 0 risultati`);
      return res.json({ league, rounds: [], fixtures: [], fetchedAt: new Date().toISOString() });
    }

    const today  = new Date().toISOString().slice(0,10);
    const soon   = Date.now() + 7*86400000;
    const resp   = {
      league,
      source:    useApf ? 'api-football' : 'football-data.org',
      fetchedAt: new Date().toISOString(),
      total:     fixtures.length,
      rounds:    groupByRound(fixtures),
      fixtures,
    };
    setCached(cacheKey, resp, dynamicTTL(
      fixtures.some(f => f.staticStatus === 'live'),
      fixtures.some(f => f.date === today),
      fixtures.some(f => new Date(`${f.date}T${f.time}:00`).getTime() < soon)
    ));
    logger.info(`[Fixtures] ${league}: ${fixtures.length} fixture`);
    res.json(resp);
  } catch (err) {
    logger.error(`[Fixtures] ${league}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Debug ─────────────────────────────────────────────────────────────────
router.get('/debug', async (req, res) => {
  const { league = 'la_liga' } = req.query;
  const fdoKey = process.env.FOOTBALL_DATA_KEY;
  const apfKey = process.env.API_FOOTBALL_KEY;
  try {
    if (APF_LEAGUES[league]) {
      const id   = APF_LEAGUES[league];
      const from = new Date(Date.now()-7*86400000).toISOString().slice(0,10);
      const to   = new Date(Date.now()+14*86400000).toISOString().slice(0,10);
      const url  = `${APF_BASE}/fixtures?league=${id}&season=2025&from=${from}&to=${to}`;
      const d    = await fetchJSON(url, { headers: { 'x-apisports-key': apfKey } });
      return res.json({ source:'api-football', league, count: d.results, errors: d.errors,
        first3: (d.response||[]).slice(0,3).map(f=>({ date:f.fixture.date, home:f.teams.home.name, away:f.teams.away.name })) });
    } else {
      const code = FDO_LEAGUES[league];
      if (!code) return res.status(400).json({ error: 'League non supportata' });
      const from = new Date(Date.now()-7*86400000).toISOString().slice(0,10);
      const to   = new Date(Date.now()+14*86400000).toISOString().slice(0,10);
      const url  = `${FDO_BASE}/competitions/${code}/matches?dateFrom=${from}&dateTo=${to}`;
      const d    = await fetchJSON(url, { headers: { 'X-Auth-Token': fdoKey } });
      return res.json({ source:'football-data.org', league, count: d.matches?.length||0,
        first3: (d.matches||[]).slice(0,3).map(f=>({ date:f.utcDate, home:f.homeTeam?.name, away:f.awayTeam?.name })) });
    }
  } catch(err) { res.status(500).json({ error: err.message }); }
});

export default router;
