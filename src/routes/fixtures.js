/**
 * /api/fixtures — Calendario ufficiale partite da API-Football
 * Fornisce: date/orari ufficiali, giornata/round, forma squadre,
 *           risultati recenti, stato live, punteggi in corso
 *
 * Cache TTL dinamico:
 *   - partite live in corso      → 60s
 *   - giorno di partita (<12h)   → 300s (5 min)
 *   - settimana corrente (<7gg)  → 900s (15 min)
 *   - future (>7gg)              → 3600s (1h)
 */

import { Router } from 'express';
import { fetchJSON } from '../scrapers/http.js';
import { logger } from '../index.js';

const router = Router();

const LEAGUE_IDS = {
  serie_a:          135,
  premier_league:   39,
  la_liga:          140,
  bundesliga:       78,
  ligue_1:          61,
  champions_league: 2,
  europa_league:    3,
};

const SEASON = 2025;
// UCL e UEL: stagione 2024 = 2024/25 (ancora in corso a marzo 2026)
// Le leghe domestiche usano season 2025 = 2025/26
const LEAGUE_SEASON = {
  champions_league: 2024,
  europa_league:    2024,
};
function getSeasonFor(leagueKey) {
  return LEAGUE_SEASON[leagueKey] || SEASON;
}
const BASE = 'https://v3.football.api-sports.io';

// ── Cache in-memory con TTL dinamico ─────────────────────────────────────
const cache = new Map();

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { cache.delete(key); return null; }
  return entry.data;
}

function setCached(key, data, ttlMs) {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

function getDynamicTTL(fixtures) {
  const now = Date.now();
  // Controlla se ci sono partite live
  const hasLive = fixtures.some(f =>
    f.fixture.status.short === '1H' ||
    f.fixture.status.short === '2H' ||
    f.fixture.status.short === 'HT' ||
    f.fixture.status.short === 'ET' ||
    f.fixture.status.short === 'P'
  );
  if (hasLive) return 60 * 1000; // 1 min se live

  // Controlla se ci sono partite oggi
  const today = new Date().toISOString().slice(0, 10);
  const hasToday = fixtures.some(f => f.fixture.date?.slice(0, 10) === today);
  if (hasToday) return 5 * 60 * 1000; // 5 min se oggi

  // Partite nei prossimi 7 giorni
  const in7days = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const hasSoon = fixtures.some(f => new Date(f.fixture.date).getTime() < in7days);
  if (hasSoon) return 15 * 60 * 1000; // 15 min

  return 60 * 60 * 1000; // 1h per partite lontane
}

// ── Fetch fixtures da API-Football ───────────────────────────────────────
async function fetchFixtures(leagueId, apiKey, leagueKey = '', season = SEASON) {
  // Prendi finestra temporale: 14 giorni fa → 21 giorni futuri
  const from = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const to   = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const url = `${BASE}/fixtures?league=${leagueId}&season=${season}&from=${from}&to=${to}`;
  const data = await fetchJSON(url, {
    headers: { 'x-apisports-key': apiKey }
  });

  return data.response || [];
}

// ── Fetch forma squadra (ultime 5) ───────────────────────────────────────
async function fetchTeamForm(teamId, leagueId, apiKey, season = SEASON) {
  const url = `${BASE}/fixtures?team=${teamId}&league=${leagueId}&season=${season}&last=5`;
  const data = await fetchJSON(url, {
    headers: { 'x-apisports-key': apiKey }
  });
  const results = (data.response || []).map(f => {
    const isHome = f.teams.home.id === teamId;
    const gs = isHome ? f.goals.home : f.goals.away;
    const gc = isHome ? f.goals.away : f.goals.home;
    const won  = gs > gc;
    const draw = gs === gc;
    return {
      date:   f.fixture.date?.slice(0, 10),
      result: won ? 'W' : draw ? 'D' : 'L',
      score:  `${gs}-${gc}`,
      opponent: isHome ? f.teams.away.name : f.teams.home.name,
    };
  });
  const formStr = results.map(r => r.result).join('');
  return { form: formStr, recent: results };
}

// ── Normalizza stato partita ──────────────────────────────────────────────
function normalizeStatus(apiStatus) {
  const short = apiStatus?.short;
  if (['1H','2H','HT','ET','P','BT'].includes(short)) return 'live';
  if (['FT','AET','PEN'].includes(short))              return 'final';
  if (short === 'PST')                                  return 'postponed';
  if (short === 'CANC')                                 return 'cancelled';
  return 'scheduled';
}

// ── Trasforma fixture API → formato frontend ──────────────────────────────
function transformFixture(f) {
  // API-Football returns ISO with timezone offset e.g. "2026-03-08T20:45:00+01:00"
  // Estraiamo data e ora LOCALI dalla stringa ISO direttamente (non convertiamo in UTC)
  // così evitiamo problemi di timezone nel frontend
  const rawDate = f.fixture.date || '';
  let date = rawDate.slice(0, 10);
  let time = '00:00';
  const timePart = rawDate.match(/T(\d{2}:\d{2})/);
  if (timePart) time = timePart[1];
  // Fallback: se non c'è timezone info usiamo UTC
  if (!rawDate.includes('+') && !rawDate.includes('Z') === false) {
    const dt = new Date(rawDate);
    date = dt.toISOString().slice(0, 10);
    time = `${String(dt.getUTCHours()).padStart(2,'0')}:${String(dt.getUTCMinutes()).padStart(2,'0')}`;
  }
  const status  = normalizeStatus(f.fixture.status);
  const elapsed = f.fixture.status.elapsed || null;

  return {
    fixtureId:    f.fixture.id,
    round:        f.league.round || 'N/D',
    date,
    time,
    staticStatus: status,
    elapsed,
    home: {
      id:     f.teams.home.id,
      name:   f.teams.home.name,
      logo:   f.teams.home.logo,
      winner: f.teams.home.winner,
    },
    away: {
      id:     f.teams.away.id,
      name:   f.teams.away.name,
      logo:   f.teams.away.logo,
      winner: f.teams.away.winner,
    },
    score: {
      home:    f.goals.home ?? null,
      away:    f.goals.away ?? null,
      ht_home: f.score?.halftime?.home ?? null,
      ht_away: f.score?.halftime?.away ?? null,
    },
    venue: f.fixture.venue?.name || null,
    referee: f.fixture.referee || null,
  };
}

// ── Raggruppa per round/giornata ──────────────────────────────────────────
function groupByRound(fixtures) {
  const rounds = {};
  for (const f of fixtures) {
    const r = f.round;
    if (!rounds[r]) rounds[r] = [];
    rounds[r].push(f);
  }
  // Ordina i round cronologicamente (per data prima partita del round)
  return Object.entries(rounds)
    .map(([round, matches]) => ({
      round,
      matches: matches.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`)),
      firstDate: matches[0]?.date || '',
    }))
    .sort((a, b) => a.firstDate.localeCompare(b.firstDate));
}

// ── Route principale ──────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { league = 'serie_a', withForm = 'false' } = req.query;
  const leagueId = LEAGUE_IDS[league];

  if (!leagueId)
    return res.status(400).json({ error: `League '${league}' non supportata`, supported: Object.keys(LEAGUE_IDS) });

  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey)
    return res.status(503).json({ error: 'API_FOOTBALL_KEY non configurata nel backend' });

  const cacheKey = `fixtures_${league}`;
  const cached = getCached(cacheKey);
  if (cached) {
    logger.info(`CACHE HIT [fixtures] ${league}`);
    return res.json(cached);
  }

  try {
    logger.info(`[Fixtures] Fetching ${league} (id=${leagueId}) season=${getSeasonFor(league)} from API-Football...`);
    const raw = await fetchFixtures(leagueId, apiKey, league, getSeasonFor(league));

    if (!raw.length) {
      return res.json({ league, season: SEASON, rounds: [], fixtures: [], scrapedAt: new Date().toISOString() });
    }

    const fixtures = raw.map(transformFixture);
    const rounds   = groupByRound(fixtures);

    // Forma squadre (solo se richiesta esplicitamente per risparmiare chiamate API)
    let teamForms = {};
    if (withForm === 'true') {
      const teamIds = [...new Set(raw.flatMap(f => [f.teams.home.id, f.teams.away.id]))];
      logger.info(`[Fixtures] Fetching form for ${teamIds.length} teams...`);
      const formResults = await Promise.allSettled(
        teamIds.map(id => fetchTeamForm(id, leagueId, apiKey).then(form => ({ id, ...form })))
      );
      for (const r of formResults) {
        if (r.status === 'fulfilled') teamForms[r.value.id] = r.value;
      }
    }

    const response = {
      league,
      season:     SEASON,
      fetchedAt:  new Date().toISOString(),
      total:      fixtures.length,
      rounds,       // raggruppati per giornata
      fixtures,     // lista piatta per compatibilità
      teamForms,    // {} se withForm !== 'true'
    };

    const ttl = getDynamicTTL(raw);
    setCached(cacheKey, response, ttl);
    logger.info(`[Fixtures] ${league}: ${fixtures.length} fixtures, TTL=${ttl/1000}s`);

    res.json(response);
  } catch (err) {
    logger.error(`[/fixtures] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Route per singola partita (dati live dettagliati) ─────────────────────
router.get('/live', async (req, res) => {
  const { league = 'serie_a' } = req.query;
  const leagueId = LEAGUE_IDS[league];
  if (!leagueId) return res.status(400).json({ error: 'League non supportata' });

  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) return res.status(503).json({ error: 'API_FOOTBALL_KEY mancante' });

  try {
    const data = await fetchJSON(`${BASE}/fixtures?live=${leagueId}`, {
      headers: { 'x-apisports-key': apiKey }
    });
    const live = (data.response || []).map(transformFixture);
    res.json({ league, live, count: live.length, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Route diagnostica (solo dev) — mostra risposta grezza API-Football ──
router.get('/debug', async (req, res) => {
  const { league = 'la_liga' } = req.query;
  const leagueId = LEAGUE_IDS[league];
  const apiKey   = process.env.API_FOOTBALL_KEY;

  if (!leagueId) return res.status(400).json({ error: 'League non supportata' });
  if (!apiKey)   return res.status(503).json({ error: 'API_FOOTBALL_KEY mancante' });

  const season = getSeasonFor(league);
  const from   = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const to     = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const url    = `${BASE}/fixtures?league=${leagueId}&season=${season}&from=${from}&to=${to}`;

  try {
    const data = await fetchJSON(url, { headers: { 'x-apisports-key': apiKey } });
    res.json({
      debug: true,
      league, leagueId, season, from, to, url,
      apiErrors: data.errors,
      resultsCount: data.results,
      paging: data.paging,
      firstThree: (data.response || []).slice(0, 3).map(f => ({
        id: f.fixture.id,
        date: f.fixture.date,
        status: f.fixture.status,
        home: f.teams.home.name,
        away: f.teams.away.name,
        round: f.league.round,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message, url });
  }
});

export default router;
