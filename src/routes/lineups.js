import { Router } from 'express';
import { cached } from '../cache/manager.js';
import { aggregateLeague } from '../scrapers/aggregator.js';
import { scrapeLineups as besoccer } from '../scrapers/besoccer.js';
import { logger } from '../index.js';

const router = Router();
const LEAGUES = ['serie_a','premier_league','la_liga','bundesliga','ligue_1','champions_league'];

router.get('/', async (req, res) => {
  const { league = 'serie_a' } = req.query;
  if (!LEAGUES.includes(league))
    return res.status(400).json({ error: `League '${league}' non supportata`, supported: LEAGUES });

  try {
    const data = await cached('lineups', league, () => buildLeagueData(league));
    res.json({ league, ...data });
  } catch (err) {
    logger.error(`[/lineups] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

async function buildLeagueData(league) {
  // Prova prima l'aggregatore (sosfanta, fantacalcio, fplitalia)
  const aggregated = await aggregateLeague(league);

  // Prendi sempre i dati BeSoccer freschi
  let bsMatches = [];
  try {
    bsMatches = await besoccer(league);
    logger.info(`[lineups] BeSoccer directo: ${bsMatches.length} matches for ${league}`);
  } catch (err) {
    logger.warn(`[lineups] BeSoccer failed: ${err.message}`);
  }

  if (bsMatches.length === 0) {
    // BeSoccer non ha dati, usa solo aggregatore
    return aggregated;
  }

  // Costruisci mappa dei match aggregati per confronto
  const aggMap = new Map();
  for (const m of aggregated.matches) {
    const key = normKey(m.home, m.away);
    aggMap.set(key, m);
  }

  // Merge: per ogni partita BeSoccer, arricchisci con dati aggregatore se disponibili
  const matches = bsMatches.map(bm => {
    const key = normKey(bm.home, bm.away);
    const agg = aggMap.get(key);

    // Converti formato BeSoccer → formato frontend
    const homeData = buildTeamData(bm.homeData, agg?.homeData);
    const awayData = buildTeamData(bm.awayData, agg?.awayData);

    return {
      id:           `${league}_${key}`,
      league,
      home:         bm.home,
      away:         bm.away,
      date:         bm.date  || agg?.date  || '',
      time:         bm.time  || agg?.time  || '',
      staticStatus: bm.staticStatus || agg?.staticStatus || 'scheduled',
      score:        bm.score || agg?.score,
      conf:         homeData.players.length >= 11 ? 90 : agg ? 75 : 60,
      homeColor:    '#1a5276',
      awayColor:    '#922b21',
      homeData,
      awayData,
    };
  });

  // Aggiungi partite che l'aggregatore ha ma BeSoccer non ha
  for (const [key, agg] of aggMap) {
    if (!matches.find(m => normKey(m.home, m.away) === key)) {
      matches.push(agg);
    }
  }

  return {
    matches,
    sources: [
      { id: 'besoccer', name: 'BeSoccer', ok: bsMatches.length > 0, count: bsMatches.length, error: null },
      ...aggregated.sources.filter(s => s.id !== 'besoccer'),
    ],
    scrapedAt: new Date().toISOString(),
  };
}

function buildTeamData(bsTeam, aggTeam) {
  // Se BeSoccer ha i giocatori, usali come base
  const bsPlayers = bsTeam?.players || [];
  const aggPlayers = aggTeam?.players || [];

  // Preferisci BeSoccer se ha giocatori, altrimenti usa aggregatore
  const players = bsPlayers.length >= 11 ? bsPlayers : 
                  aggPlayers.length > 0  ? aggPlayers : bsPlayers;

  const formation = bsTeam?.form || aggTeam?.form || 'N/D';

  // Costruisci lineup per righe basandosi sul modulo
  const lineup = players.length > 0 ? buildLineup(players, formation) : (aggTeam?.lineup || []);

  // Unisci sources
  const sources = [];
  if (bsTeam?.sources?.length) sources.push(...bsTeam.sources);
  if (aggTeam?.sources?.length) {
    for (const s of aggTeam.sources) {
      if (!sources.find(x => x.id === s.id)) sources.push(s);
    }
  }

  return {
    form:    formation,
    lineup,
    bench:   bsTeam?.bench || aggTeam?.bench || [],
    sources,
    players,
  };
}

function buildLineup(players, formation) {
  const parts = (formation || '').split('-').map(Number).filter(n => n > 0);
  const tokens = players.map(p => ({
    n:     p.n || p.name || 'N/D',
    num:   p.num || 0,
    p:     p.p || p.prob || 80,
    pos:   p.pos || p.role || 'N/D',
    shirt: '#1a5276',
  }));

  if (parts.length >= 3 && tokens.length >= 11) {
    const rows = [tokens.slice(0, 1)]; // portiere
    let idx = 1;
    for (const count of parts) {
      rows.push(tokens.slice(idx, idx + count));
      idx += count;
    }
    return rows.filter(r => r.length > 0);
  }

  // Fallback: dividi in 4 righe
  const rows = [];
  const chunk = Math.ceil(tokens.length / 4);
  for (let i = 0; i < tokens.length; i += chunk) {
    rows.push(tokens.slice(i, i + chunk));
  }
  return rows;
}

function normKey(a, b) {
  if (!a || !b) return `${Date.now()}`;
  const n = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  return `${n(a)}_${n(b)}`;
}

router.get('/sources', (req, res) => res.json({ sources: [
  { id:'sosfanta',     name:'SosFanta',        league:'serie_a',        url:'https://www.sosfanta.com' },
  { id:'fantacalcio',  name:'Fantacalcio.it',   league:'serie_a',        url:'https://www.fantacalcio.it' },
  { id:'fplitalia',    name:'FPL Italia',        league:'premier_league', url:'https://fplitalia.com' },
  { id:'besoccer',     name:'BeSoccer',          league:'multi',          url:'https://lineups.besoccer.com' },
]}));

export default router;
