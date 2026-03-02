import { logger } from '../index.js';
import { scrapeLineups as sosfanta }    from './sosfanta.js';
import { scrapeLineups as fantacalcio } from './fantacalcio.js';
import { scrapeLineups as fplitalia }   from './fplitalia.js';
import { scrapeLineups as besoccer }    from './besoccer.js';

const SCRAPERS = {
  serie_a:        [{ name:'sosfanta', fn: sosfanta }, { name:'fantacalcio', fn: fantacalcio }, { name:'besoccer', fn: () => besoccer('serie_a') }],
  premier_league: [{ name:'fplitalia', fn: fplitalia }, { name:'besoccer', fn: () => besoccer('premier_league') }],
  la_liga:        [{ name:'besoccer', fn: () => besoccer('la_liga') }],
  bundesliga:     [{ name:'besoccer', fn: () => besoccer('bundesliga') }],
  ligue_1:        [{ name:'besoccer', fn: () => besoccer('ligue_1') }],
  champions_league:[{ name:'besoccer', fn: () => besoccer('champions_league') }],
};

export async function aggregateLeague(league) {
  const scrapers = SCRAPERS[league];
  if (!scrapers) return { matches: [], sources: [], scrapedAt: new Date().toISOString() };

  const results = await Promise.allSettled(
    scrapers.map(async s => {
      try { const data = await s.fn(); return { name: s.name, data, ok: true }; }
      catch (err) { logger.error(`[${s.name}] FAILED: ${err.message}`); return { name: s.name, data: [], ok: false, error: err.message }; }
    })
  );

  const all = results.map(r => r.value || r.reason);
  const matches = mergeMatches(all, league);
  const sources = all.map(s => ({ id: s.name, name: sourceName(s.name), ok: s.ok, count: s.data?.length || 0 }));

  logger.info(`[Aggregator] ${league}: ${matches.length} matches from ${sources.filter(s=>s.ok).length} sources`);
  return { matches, sources, scrapedAt: new Date().toISOString() };
}

function mergeMatches(results, league) {
  const map = new Map();
  for (const r of results) {
    if (!r.ok || !r.data?.length) continue;
    for (const item of r.data) {
      const key = normalizeKey(item.homeTeam, item.awayTeam);
      if (!key) continue;
      if (!map.has(key)) map.set(key, createMatch(item, league));
      addSource(map.get(key), item, r.name);
    }
  }
  return Array.from(map.values()).map(m => ({ ...m, confidence: calcConf(m) }));
}

function createMatch(item, league) {
  return {
    id: `${league}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
    league, home: item.homeTeam, away: item.awayTeam,
    date: '', time: '',
    homeData: { form: item.formation || 'N/D', lineup: normLineup(item.homePlayers||[]), bench: item.bench||[], sources: [], players: [] },
    awayData: { form: 'N/D', lineup: [], bench: [], sources: [], players: [] },
    staticStatus: 'scheduled', score: { home: 0, away: 0 }, conf: 60,
  };
}

function addSource(match, item, name) {
  const players = item.homePlayers || item.starters || [];
  match.homeData.sources.push({
    id: name, name: sourceName(name), form: item.formation || 'N/D',
    time: timeAgo(item.scrapedAt),
    players: players.map(p => p.name || p),
    conf: players.filter(p => (p.prob||0) >= 90).map(p => p.name||p),
    doubt: players.filter(p => (p.prob||0) < 70 && (p.prob||0) > 0).map(p => p.name||p),
  });
  if (players.length > match.homeData.lineup.length) match.homeData.lineup = normLineup(players);
}

function normLineup(players) {
  return players.slice(0,11).map((p,i) => ({ n: typeof p==='string'?p:(p.name||'N/D'), num: i+1, p: p.prob||80, pos: p.role||'N/D', shirt: '#1a5276' }));
}

function calcConf(match) {
  const n = match.homeData.sources.length;
  return Math.min(95, 50 + n * 15);
}

function normalizeKey(a, b) {
  if (!a || !b) return null;
  const n = s => s.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,8);
  return `${n(a)}_${n(b)}`;
}

function timeAgo(iso) {
  if (!iso) return 'N/D';
  const m = Math.floor((Date.now() - new Date(iso)) / 60000);
  return m < 60 ? `${m}m fa` : `${Math.floor(m/60)}h fa`;
}

function sourceName(id) {
  return { sosfanta:'SosFanta', fantacalcio:'Fantacalcio.it', fplitalia:'FPL Italia', besoccer:'BeSoccer' }[id] || id;
}
