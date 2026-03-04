/**
 * API-Football (api-sports.io) — Livello 1: Ground Truth
 *
 * Fornisce:
 * - Rose ufficiali aggiornate (players/squads)
 * - Infortuni e squalifiche (injuries)
 * - Lineup confermate il giorno partita (fixtures)
 *
 * Endpoint base: https://v3.football.api-sports.io
 * Header: x-apisports-key: {API_FOOTBALL_KEY}
 * Free plan: 100 req/day, 10 req/min
 *
 * STRATEGIA DI RISPARMIO RICHIESTE:
 * - Rose: cache 24h (cambiano raramente)
 * - Infortuni: cache 2h
 * - Lineup confermate: cache 1h
 */

import { fetchJSON } from './http.js';
import { logger } from '../index.js';

const BASE = 'https://v3.football.api-sports.io';

// League IDs API-Football
const LEAGUE_IDS = {
  serie_a:          135,
  premier_league:   39,
  la_liga:          140,
  bundesliga:       78,
  ligue_1:          61,
  champions_league: 2,
};

const SEASON = 2025; // stagione corrente

// Cache in memoria
const squadCache  = new Map(); // teamId → { players, expiresAt }
const injuryCache = new Map(); // fixtureId → { injuries, expiresAt }
const fixtureCache = new Map(); // leagueId_round → { fixtures, expiresAt }

const SQUAD_TTL   = 24 * 60 * 60 * 1000; // 24h
const INJURY_TTL  =  2 * 60 * 60 * 1000; //  2h
const FIXTURE_TTL =  1 * 60 * 60 * 1000; //  1h

function apiGet(endpoint, params = {}) {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) throw new Error('API_FOOTBALL_KEY not set');

  const qs = new URLSearchParams(params).toString();
  const url = `${BASE}/${endpoint}${qs ? '?' + qs : ''}`;

  return fetchJSON(url, {
    headers: {
      'x-apisports-key': apiKey,
    },
  });
}

// ── ROSE SQUADRA ──────────────────────────────────────────────────────────────
export async function getSquad(teamId) {
  const key = String(teamId);
  const cached = squadCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.players;

  try {
    logger.info(`[API-Football] Fetching squad for team ${teamId}`);
    const data = await apiGet('players/squads', { team: teamId });
    const squad = data?.response?.[0]?.players || [];

    const players = squad.map(p => ({
      id:       p.id,
      name:     p.name,
      age:      p.age,
      number:   p.number,
      position: normalizePosition(p.position),
      photo:    p.photo,
    }));

    squadCache.set(key, { players, expiresAt: Date.now() + SQUAD_TTL });
    logger.info(`[API-Football] Squad team ${teamId}: ${players.length} players`);
    return players;
  } catch (err) {
    logger.error(`[API-Football] Squad error team ${teamId}: ${err.message}`);
    return [];
  }
}

// ── INFORTUNI PER FIXTURE ─────────────────────────────────────────────────────
export async function getInjuries(fixtureId) {
  const key = String(fixtureId);
  const cached = injuryCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.injuries;

  try {
    logger.info(`[API-Football] Fetching injuries for fixture ${fixtureId}`);
    const data = await apiGet('injuries', { fixture: fixtureId });
    const injuries = (data?.response || []).map(i => ({
      player:   i.player?.name,
      team:     i.team?.name,
      type:     i.player?.type,   // 'Injured' | 'Suspended'
      reason:   i.player?.reason,
    }));

    injuryCache.set(key, { injuries, expiresAt: Date.now() + INJURY_TTL });
    return injuries;
  } catch (err) {
    logger.error(`[API-Football] Injuries error fixture ${fixtureId}: ${err.message}`);
    return [];
  }
}

// ── FIXTURE PROSSIMO TURNO CON LINEUP ────────────────────────────────────────
// Restituisce le partite della prossima giornata con lineup se già confermate
export async function getUpcomingFixtures(league) {
  const leagueId = LEAGUE_IDS[league];
  if (!leagueId) return [];

  const key = `${leagueId}_upcoming`;
  const cached = fixtureCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.fixtures;

  try {
    logger.info(`[API-Football] Fetching upcoming fixtures for ${league}`);
    const data = await apiGet('fixtures', {
      league: leagueId,
      season: SEASON,
      next:   10, // prossime 10 partite
    });

    const fixtures = (data?.response || []).map(f => ({
      fixtureId:  f.fixture?.id,
      date:       f.fixture?.date?.slice(0, 10),
      time:       f.fixture?.date?.slice(11, 16),
      venue:      f.fixture?.venue?.name,
      city:       f.fixture?.venue?.city,
      homeTeam:   f.teams?.home?.name,
      homeTeamId: f.teams?.home?.id,
      awayTeam:   f.teams?.away?.name,
      awayTeamId: f.teams?.away?.id,
      status:     f.fixture?.status?.short,
      lineup:     f.lineups?.length > 0 ? f.lineups : null,
    }));

    fixtureCache.set(key, { fixtures, expiresAt: Date.now() + FIXTURE_TTL });
    logger.info(`[API-Football] ${league}: ${fixtures.length} upcoming fixtures`);
    return fixtures;
  } catch (err) {
    logger.error(`[API-Football] Fixtures error ${league}: ${err.message}`);
    return [];
  }
}

// ── SQUAD COME FONTE LINEUPS (compatibile con aggregator) ────────────────────
// Cerca le squadre per nome e restituisce la rosa in formato aggregator
export async function scrapeLineups(league) {
  const leagueId = LEAGUE_IDS[league];
  if (!leagueId) return [];

  try {
    // Prendi le prossime partite
    const fixtures = await getUpcomingFixtures(league);
    if (!fixtures.length) return [];

    const matches = [];

    for (const f of fixtures.slice(0, 10)) {
      // Se la lineup è già confermata usala
      if (f.lineup && f.lineup.length === 2) {
        const homeLineup = f.lineup.find(l => l.team?.id === f.homeTeamId);
        const awayLineup = f.lineup.find(l => l.team?.id === f.awayTeamId);

        if (homeLineup && awayLineup) {
          matches.push({
            source:      'apifootball',
            league,
            homeTeam:    f.homeTeam,
            awayTeam:    f.awayTeam,
            date:        f.date,
            time:        f.time,
            venue:       f.venue,
            city:        f.city,
            fixtureId:   f.fixtureId,
            formation:   homeLineup.formation || 'N/D',
            homePlayers: homeLineup.startXI?.map(p => ({
              name: p.player?.name,
              num:  p.player?.number,
              role: normalizePosition(p.player?.pos),
              prob: 99, // lineup confermata = certezza 99%
            })) || [],
            awayPlayers: awayLineup.startXI?.map(p => ({
              name: p.player?.name,
              num:  p.player?.number,
              role: normalizePosition(p.player?.pos),
              prob: 99,
            })) || [],
            scrapedAt: new Date().toISOString(),
          });
          continue;
        }
      }

      // Lineup non ancora confermata: usa la rosa come base
      const [homeSquad, awaySquad] = await Promise.allSettled([
        getSquad(f.homeTeamId),
        getSquad(f.awayTeamId),
      ]);

      const homePlayers = (homeSquad.value || []).map(p => ({
        name: p.name,
        num:  p.number,
        role: p.position,
        prob: 60, // rosa = 60% (non sappiamo chi gioca)
      }));

      const awayPlayers = (awaySquad.value || []).map(p => ({
        name: p.name,
        num:  p.number,
        role: p.position,
        prob: 60,
      }));

      if (homePlayers.length > 0) {
        matches.push({
          source:      'apifootball',
          league,
          homeTeam:    f.homeTeam,
          awayTeam:    f.awayTeam,
          date:        f.date,
          time:        f.time,
          venue:       f.venue,
          city:        f.city,
          fixtureId:   f.fixtureId,
          formation:   'N/D',
          homePlayers,
          awayPlayers,
          scrapedAt:   new Date().toISOString(),
        });
      }

      // Pausa tra richieste per rispettare rate limit (10 req/min)
      await new Promise(r => setTimeout(r, 1500));
    }

    logger.info(`[API-Football] ${league}: ${matches.length} matches with squads`);
    return matches;
  } catch (err) {
    logger.error(`[API-Football] scrapeLineups error ${league}: ${err.message}`);
    return [];
  }
}

function normalizePosition(pos = '') {
  const p = pos?.toUpperCase()?.trim();
  if (!p) return 'N/D';
  if (p === 'G' || p === 'GK' || p === 'GOALKEEPER' || p === 'POR') return 'POR';
  if (p === 'D' || p === 'DEF' || p === 'DEFENDER' || p === 'DIF') return 'DIF';
  if (p === 'M' || p === 'MID' || p === 'MIDFIELDER' || p === 'CEN') return 'CEN';
  if (p === 'F' || p === 'FWD' || p === 'FORWARD' || p === 'ATT') return 'ATT';
  return 'N/D';
}
