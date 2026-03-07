/**
 * API-Football (api-sports.io) — Livello 1: Arricchimento dati
 *
 * NON viene usato per scoprire le partite (lo fa BeSoccer).
 * Viene usato per ARRICCHIRE le partite già trovate con:
 * - Infortuni e squalifiche ufficiali
 * - Lineup confermate il giorno partita
 * - IDs fixture per query future
 *
 * Endpoint: https://v3.football.api-sports.io
 * Header:   x-apisports-key
 * Free:     100 req/day, 10 req/min
 */

import { fetchJSON } from './http.js';
import { logger } from '../index.js';

const BASE = 'https://api-football-v1.p.rapidapi.com/v3';

const LEAGUE_IDS = {
  serie_a:          135,
  premier_league:   39,
  la_liga:          140,
  bundesliga:       78,
  ligue_1:          61,
  champions_league: 2,
};

const SEASON_BY_LEAGUE = {
  serie_a: 2024, premier_league: 2024, la_liga: 2024,
  bundesliga: 2024, ligue_1: 2024, champions_league: 2024, europa_league: 2024,
};
function getSeason(leagueId) {
  // Mappa leagueId → slug per trovare la stagione
  const idToSlug = { 135:'serie_a', 39:'premier_league', 140:'la_liga', 78:'bundesliga', 61:'ligue_1', 2:'champions_league', 3:'europa_league' };
  const slug = idToSlug[leagueId];
  return SEASON_BY_LEAGUE[slug] || 2024;
}

// Cache
const fixtureMapCache = new Map(); // leagueId → { map: {normalizedKey → fixture}, expiresAt }
const injuryCache     = new Map(); // fixtureId → { injuries, expiresAt }

const FIXTURE_TTL = 6  * 60 * 60 * 1000; // 6h
const INJURY_TTL  = 2  * 60 * 60 * 1000; // 2h

function apiGet(endpoint, params = {}) {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) throw new Error('API_FOOTBALL_KEY not set');
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE}/${endpoint}${qs ? '?' + qs : ''}`;
  return fetchJSON(url, { headers: {
    'x-rapidapi-key': apiKey,
    'x-rapidapi-host': 'api-football-v1.p.rapidapi.com',
  } });
}

function normalizeTeamName(name = '') {
  return name.toLowerCase()
    .replace(/\s+(fc|cf|ac|sc|ssc|afc|asd|utd|united|city|calcio)$/i, '')
    .replace(/^(fc|cf|ac|sc|ssc|afc)\s+/i, '')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 10);
}

// Carica tutte le fixture della settimana per una lega → mappa normalizzata
async function loadFixtureMap(league) {
  const leagueId = LEAGUE_IDS[league];
  if (!leagueId) return new Map();

  const cached = fixtureMapCache.get(league);
  if (cached && Date.now() < cached.expiresAt) return cached.map;

  try {
    logger.info(`[API-Football] Loading fixture map for ${league}`);
    const season = getSeason(leagueId);
    logger.info(`[API-Football] loadFixtureMap ${league} leagueId=${leagueId} season=${season}`);
    const data = await apiGet('fixtures', {
      league: leagueId,
      season: season,
      next:   50,
    });
    logger.info(`[API-Football] fixtures response: ${data?.results} results, errors=${JSON.stringify(data?.errors)}`);

    const map = new Map();
    for (const f of (data?.response || [])) {
      const home = normalizeTeamName(f.teams?.home?.name);
      const away = normalizeTeamName(f.teams?.away?.name);
      const key  = `${home}_${away}`;
      map.set(key, {
        fixtureId:  f.fixture?.id,
        date:       f.fixture?.date?.slice(0, 10),
        time:       f.fixture?.date?.slice(11, 16),
        venue:      f.fixture?.venue?.name,
        city:       f.fixture?.venue?.city,
        homeTeamId: f.teams?.home?.id,
        awayTeamId: f.teams?.away?.id,
        homeName:   f.teams?.home?.name,
        awayName:   f.teams?.away?.name,
        status:     f.fixture?.status?.short,
      });
    }

    fixtureMapCache.set(league, { map, expiresAt: Date.now() + FIXTURE_TTL });
    logger.info(`[API-Football] ${league}: ${map.size} fixtures loaded`);
    return map;
  } catch (err) {
    logger.error(`[API-Football] loadFixtureMap error ${league}: ${err.message}`);
    return new Map();
  }
}

// Lista tutte le fixture in cache (per debug)
export async function listFixtures(league) {
  const map = await loadFixtureMap(league);
  return [...map.entries()].map(([key, v]) => ({ key, home: v.homeName, away: v.awayName, date: v.date, fixtureId: v.fixtureId }));
}

// Cerca il fixtureId di una partita dato home/away (fuzzy match)
export async function findFixture(league, homeTeam, awayTeam) {
  const map = await loadFixtureMap(league);
  const homeKey = normalizeTeamName(homeTeam);
  const awayKey = normalizeTeamName(awayTeam);
  const key = `${homeKey}_${awayKey}`;

  // Match esatto
  if (map.has(key)) return map.get(key);

  // Match parziale (es. "Manchester City" → "manchestercity" vs "mancity")
  for (const [k, v] of map.entries()) {
    const [h, a] = k.split('_');
    if (homeKey.includes(h) || h.includes(homeKey)) {
      if (awayKey.includes(a) || a.includes(awayKey)) {
        return v;
      }
    }
  }

  return null;
}

// Infortuni e squalifiche per una partita
export async function getInjuries(fixtureId) {
  if (!fixtureId) return [];
  const key = String(fixtureId);
  const cached = injuryCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.injuries;

  try {
    const data = await apiGet('injuries', { fixture: fixtureId });
    const injuries = (data?.response || []).map(i => ({
      player: i.player?.name,
      team:   i.team?.name,
      type:   i.player?.type,
      reason: i.player?.reason,
    }));
    injuryCache.set(key, { injuries, expiresAt: Date.now() + INJURY_TTL });
    return injuries;
  } catch (err) {
    logger.error(`[API-Football] Injuries error ${fixtureId}: ${err.message}`);
    return [];
  }
}

// Lineup confermata per una partita (disponibile ~1h prima del fischio)
export async function getConfirmedLineup(fixtureId) {
  if (!fixtureId) return null;
  try {
    const data = await apiGet('fixtures/lineups', { fixture: fixtureId });
    if (!data?.response?.length) return null;
    return data.response;
  } catch (err) {
    logger.error(`[API-Football] Lineup error ${fixtureId}: ${err.message}`);
    return null;
  }
}

export function normalizePosition(pos = '') {
  const p = pos?.toUpperCase()?.trim();
  if (!p) return 'N/D';
  if (['G','GK','GOALKEEPER','POR'].includes(p)) return 'POR';
  if (['D','DEF','DEFENDER','DIF','CB','LB','RB','WB'].includes(p)) return 'DIF';
  if (['M','MID','MIDFIELDER','CEN','CM','DM','AM'].includes(p)) return 'CEN';
  if (['F','FWD','FORWARD','ATT','ST','LW','RW'].includes(p)) return 'ATT';
  return 'N/D';
}

// ── Statistiche giocatori per squadra (stagione corrente) ──────────────────
const playerStatsCache = new Map(); // teamId_leagueId → { stats: Map<normalizedName, obj>, expiresAt }
const PLAYER_STATS_TTL = 24 * 60 * 60 * 1000; // 24h — dati lenti a cambiare

function normalizePlayerName(name = '') {
  return name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 12);
}

export async function getPlayerStats(teamId, leagueId) {
  if (!teamId || !leagueId) return new Map();
  const cacheKey = `${teamId}_${leagueId}`;
  const cached = playerStatsCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.stats;

  try {
    const season = getSeason(leagueId);
    const data = await apiGet('players', { team: teamId, league: leagueId, season: season });
    const stats = new Map();
    for (const entry of (data?.response || [])) {
      const p = entry.player;
      const s = entry.statistics?.[0];
      if (!p || !s) continue;
      const key = normalizePlayerName(p.name);
      stats.set(key, {
        g:   s.goals?.total   || 0,
        a:   s.goals?.assists || 0,
        app: s.games?.appearences || 0,
        rat: parseFloat(s.games?.rating) || 6.5,
        // Ultime partite: non disponibili qui, lasciamo h:[] per ora
      });
    }
    playerStatsCache.set(cacheKey, { stats, expiresAt: Date.now() + PLAYER_STATS_TTL });
    return stats;
  } catch (err) {
    // Non loggare come errore — API-Football key potrebbe non esserci
    return new Map();
  }
}
