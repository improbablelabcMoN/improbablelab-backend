import { logger } from '../index.js';
import { scrapeLineups as sosfanta }    from './sosfanta.js';
import { scrapeLineups as fantacalcio } from './fantacalcio.js';
import { scrapeLineups as fplitalia }   from './fplitalia.js';
import { scrapeLineups as besoccer }    from './besoccer.js';
import { scrapeLineups as fantagazzetta } from './fantagazzetta.js';

const SCRAPERS = {
  serie_a:         [
    { name: 'besoccer',    fn: () => besoccer('serie_a') },
    { name: 'sosfanta',    fn: sosfanta },
    { name: 'fantacalcio', fn: fantacalcio },
    { name: 'fantagazzetta', fn: fantagazzetta },
  ],
  premier_league:  [
    { name: 'besoccer',  fn: () => besoccer('premier_league') },
    { name: 'fplitalia', fn: fplitalia },
  ],
  la_liga:         [{ name: 'besoccer', fn: () => besoccer('la_liga') }],
  bundesliga:      [{ name: 'besoccer', fn: () => besoccer('bundesliga') }],
  ligue_1:         [{ name: 'besoccer', fn: () => besoccer('ligue_1') }],
  champions_league:[{ name: 'besoccer', fn: () => besoccer('champions_league') }],
};

// ── Entry point ───────────────────────────────────────────────────────────
export async function aggregateLeague(league) {
  const scrapers = SCRAPERS[league];
  if (!scrapers) return { matches: [], sources: [], scrapedAt: new Date().toISOString() };

  const results = await Promise.allSettled(
    scrapers.map(async s => {
      try {
        const data = await s.fn();
        logger.info(`[${s.name}] OK — ${data.length} matches`);
        return { name: s.name, data, ok: true };
      } catch (err) {
        logger.error(`[${s.name}] FAILED: ${err.message}`);
        return { name: s.name, data: [], ok: false, error: err.message };
      }
    })
  );

  const all     = results.map(r => r.value || r.reason);
  const matches = mergeMatches(all, league);
  const sources = all.map(s => ({
    id:    s.name,
    name:  sourceName(s.name),
    ok:    s.ok,
    count: s.data?.length || 0,
    error: s.error || null,
  }));

  logger.info(`[Aggregator] ${league}: ${matches.length} matches from ${sources.filter(s => s.ok).length}/${sources.length} sources`);
  return { matches, sources, scrapedAt: new Date().toISOString() };
}

// ── Merge partite da più fonti ────────────────────────────────────────────
function mergeMatches(results, league) {
  // Map: chiave normalizzata → match aggregato
  const map = new Map();

  for (const r of results) {
    if (!r.ok || !r.data?.length) {
      continue;
    }


    for (const item of r.data) {
      // Normalizza i campi: BeSoccer usa home/away, altri usano homeTeam/awayTeam
      if (!item.homeTeam && item.home) item.homeTeam = item.home;
      if (!item.awayTeam && item.away) item.awayTeam = item.away;

      const key = normalizeKey(item.homeTeam, item.awayTeam);
      if (!key) continue;

      if (!map.has(key)) {
        map.set(key, initMatch(item, league));
      }

      mergeSourceIntoMatch(map.get(key), item, r.name);
    }
  }

  return Array.from(map.values()).map(m => finalizeMatch(m));
}

// ── Crea struttura match vuota ─────────────────────────────────────────────
function initMatch(item, league) {
  return {
    id:      `${league}_${normalizeKey(item.homeTeam, item.awayTeam)}`,
    league,
    home:    item.homeTeam,
    away:    item.awayTeam,
    date:    item.date    || '',
    time:    item.time    || '',
    staticStatus: 'scheduled',
    score:   { home: 0, away: 0 },
    conf:    0,
    homeColor: '#1a5276',
    awayColor: '#2e4057',
    homeData: {
      form:    'N/D',
      lineup:  [],
      bench:   [],
      sources: [],
      players: [],
      // mappa interna: nome → { prob, sources[], role, num }
      _playerMap: new Map(),
    },
    awayData: {
      form:    'N/D',
      lineup:  [],
      bench:   [],
      sources: [],
      players: [],
      _playerMap: new Map(),
    },
  };
}

// ── Aggiunge una fonte al match ───────────────────────────────────────────
function mergeSourceIntoMatch(match, item, sourceid) {
  // BeSoccer restituisce homeData/awayData già processati
  // Gli altri scraper restituiscono homePlayers/awayPlayers grezzi
  const isBeSoccer = !!item.homeData;

  if (isBeSoccer) {
    // Copia direttamente i dati già processati da BeSoccer
    const hd = item.homeData;
    const ad = item.awayData;

    // Aggiungi giocatori home alla playerMap
    const homePlayers = hd.players || (hd.lineup || []).flat().map(p => ({
      name: p.n, role: p.pos, num: p.num, prob: p.p
    }));
    mergePlayers(match.homeData._playerMap, homePlayers, sourceid);
    match.homeData.sources.push({
      id: sourceid, name: sourceName(sourceid),
      form: hd.form || item.formation || 'N/D',
      time: timeAgo(item.scrapedAt),
      players: homePlayers.map(p => p.name || p.n || p),
      conf:    homePlayers.filter(p => (p.prob || p.p || 0) >= 85).map(p => p.name || p.n || p),
      doubt:   homePlayers.filter(p => { const pr = p.prob || p.p || 0; return pr < 65 && pr > 0; }).map(p => p.name || p.n || p),
    });
    if (match.homeData.form === 'N/D' && hd.form && hd.form !== 'N/D')
      match.homeData.form = hd.form;
    if (hd.bench?.length) match.homeData.bench = hd.bench;

    // Aggiungi giocatori away
    if (ad) {
      const awayPlayers = (ad.players?.length ? ad.players : (ad.lineup || []).flat()).map(p => ({
        name: p.name || p.n || '', role: p.pos || p.role || 'N/D', num: p.num || 0, prob: p.p || p.prob || 80
      })).filter(p => p.name);
      mergePlayers(match.awayData._playerMap, awayPlayers, sourceid);
      match.awayData.sources.push({
        id: sourceid, name: sourceName(sourceid),
        form: ad.form || 'N/D',
        time: timeAgo(item.scrapedAt),
        players: awayPlayers.map(p => p.name || p.n || p),
        conf: [], doubt: [],
      });
      if (match.awayData.form === 'N/D' && ad.form && ad.form !== 'N/D')
        match.awayData.form = ad.form;
    }

    // Dati extra partita
    if (item.date  && !match.date)  match.date  = item.date;
    if (item.time  && !match.time)  match.time  = item.time;
    if (item.score) match.score = item.score;
    if (item.staticStatus) match.staticStatus = item.staticStatus;
    if (item.homeColor) match.homeColor = item.homeColor;
    if (item.awayColor) match.awayColor = item.awayColor;
    return;
  }

  // ── Scraper standard (homePlayers/awayPlayers grezzi) ──
  const homePlayers = item.homePlayers || item.starters || [];
  const awayPlayers = item.awayPlayers || [];

  mergePlayers(match.homeData._playerMap, homePlayers, sourceid);
  const homeSrc = {
    id:      sourceid,
    name:    sourceName(sourceid),
    form:    item.formation || 'N/D',
    time:    timeAgo(item.scrapedAt),
    players: homePlayers.map(p => p.name || p),
    conf:    homePlayers.filter(p => (p.prob || 0) >= 85).map(p => p.name || p),
    doubt:   homePlayers.filter(p => (p.prob || 0) < 65 && (p.prob || 0) > 0).map(p => p.name || p),
  };
  match.homeData.sources.push(homeSrc);
  if (match.homeData.form === 'N/D' && item.formation && item.formation !== 'N/D')
    match.homeData.form = item.formation;
  if (item.bench?.length) match.homeData.bench = item.bench;

  if (awayPlayers.length > 0) {
    mergePlayers(match.awayData._playerMap, awayPlayers, sourceid);
    match.awayData.sources.push({ ...homeSrc, players: awayPlayers.map(p => p.name || p), conf: [], doubt: [] });
  }
}

// ── Calcola probabilità mediata per ogni giocatore ────────────────────────
// QUESTA è la logica chiave che risolve i giocatori obsoleti:
// un giocatore appare SOLO se almeno 1 fonte lo include
// la probabilità cresce col numero di fonti che lo confermano
function mergePlayers(playerMap, players, sourceid) {
  for (const p of players) {
    const rawName = (typeof p === 'object') ? (p.name || p.n || '') : p;
    const name = normalizePlayerName(rawName);
    if (!name || name.length < 2) continue;

    if (!playerMap.has(name)) {
      playerMap.set(name, {
        name,
        originalName: (typeof p === 'object') ? (p.name || p.n || '') : (p || ''),
        role:     p.role || 'N/D',
        num:      p.num  || 0,
        sources:  [],    // quali fonti lo includono
        probs:    [],    // probabilità per fonte
      });
    }

    const entry = playerMap.get(name);
    if (!entry.sources.includes(sourceid)) {
      entry.sources.push(sourceid);
      entry.probs.push(typeof p === 'object' ? (p.prob || 80) : 80);
      if (entry.role === 'N/D' && p.role && p.role !== 'N/D') entry.role = p.role;
      if (!entry.num && p.num) entry.num = p.num;
    }
  }
}

// ── Finalizza il match: calcola prob mediate, costruisce lineup ───────────
function finalizeMatch(match) {
  // Processa homeData
  processTeamData(match.homeData);
  processTeamData(match.awayData);

  // Calcola confidenza globale
  const n        = match.homeData.sources.length;
  match.conf     = Math.min(95, 50 + n * 15);

  // Cleanup: rimuove _playerMap dalla risposta finale
  delete match.homeData._playerMap;
  delete match.awayData._playerMap;

  return match;
}

function processTeamData(teamData) {
  const totalSources = teamData.sources.length || 1;
  const players      = Array.from(teamData._playerMap.values());

  // Calcola probabilità mediata:
  // - base = media delle prob delle fonti che lo includono
  // - bonus = (fonti che lo includono / totale fonti) * 20
  // - se TUTTE le fonti lo includono → prob >= 85 (titolare certo)
  // - se 0 fonti lo includono → non appare proprio
  const scored = players
    .filter(p => p.sources.length > 0)
    .map(p => {
      const avgProb     = p.probs.reduce((a, b) => a + b, 0) / p.probs.length;
      const sourceRatio = p.sources.length / totalSources;
      const finalProb   = Math.min(99, Math.round(avgProb * 0.7 + sourceRatio * 100 * 0.3));
      return { ...p, prob: finalProb, sourceRatio };
    })
    .sort((a, b) => b.prob - a.prob);

  // Top 11 per la formazione titolare (prob > 50)
  const starters = scored.filter(p => p.prob > 50).slice(0, 11);

  // Converti in formato lineup per il frontend
  teamData.lineup  = buildLineupRows(starters);
  teamData.players = starters.map(p => ({
    n:   String(p.originalName || ''),
    pos: p.role,
    num: p.num || 0,
    p:   p.prob,
    rat: 6.5, // default, verrà sovrascritto da API ufficiale
    g:   0,
    a:   0,
    app: 10,
    h:   [],
  }));
}

// ── Dispone i giocatori in righe per il campo (POR, DIF, CEN, ATT) ────────
function buildLineupRows(players) {
  const byPos = {
    POR: players.filter(p => p.role === 'POR'),
    DIF: players.filter(p => p.role === 'DIF'),
    CEN: players.filter(p => p.role === 'CEN'),
    ATT: players.filter(p => p.role === 'ATT'),
    'N/D': players.filter(p => p.role === 'N/D'),
  };

  // Distribuisce N/D nelle posizioni mancanti
  const unknown = [...byPos['N/D']];
  if (byPos.POR.length === 0 && unknown.length) byPos.POR.push(unknown.shift());
  if (byPos.DIF.length === 0 && unknown.length >= 4) byPos.DIF.push(...unknown.splice(0, 4));
  if (byPos.CEN.length === 0 && unknown.length >= 3) byPos.CEN.push(...unknown.splice(0, 3));
  if (byPos.ATT.length === 0 && unknown.length)      byPos.ATT.push(...unknown.splice(0, 3));

  const rows = [];
  if (byPos.POR.length)  rows.push(toTokens(byPos.POR));
  if (byPos.DIF.length)  rows.push(toTokens(byPos.DIF));
  if (byPos.CEN.length)  rows.push(toTokens(byPos.CEN));
  if (byPos.ATT.length)  rows.push(toTokens(byPos.ATT));

  return rows;
}

function toTokens(players) {
  return players.map(p => ({
    n:     String(p.originalName || ''),
    num:   p.num || 0,
    p:     p.prob,
    pos:   p.role,
    shirt: '#1a5276',
  }));
}

// ── Normalizza nome giocatore per confronto tra fonti ────────────────────
// Es: "Pellegrini L." === "Lorenzo Pellegrini" === "pellegrini"
function normalizePlayerName(name) {
  if (!name) return '';
  if (typeof name === 'object') name = name.n || name.name || '';
  return name
    .toLowerCase()
    .replace(/[^a-zàèéìòùáéíóú]/gi, ' ')
    .replace(/\b(de|van|di|del|della|dos|da|el|al|le|la|los|las)\b/gi, '') // articoli
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(t => t.length > 1)
    .slice(-2)   // usa solo cognome (e secondo nome se c'è)
    .join(' ');
}

function normalizeKey(a, b) {
  if (!a || !b) return null;
  const n = s => s.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  return `${n(a)}_${n(b)}`;
}

function timeAgo(iso) {
  if (!iso) return 'N/D';
  const m = Math.floor((Date.now() - new Date(iso)) / 60000);
  return m < 1 ? 'ora' : m < 60 ? `${m}m fa` : `${Math.floor(m / 60)}h fa`;
}



function sourceName(id) {
  return {
    sosfanta:    'SosFanta',
    fantacalcio: 'Fantacalcio.it',
    fplitalia:   'FPL Italia',
    besoccer:    'BeSoccer',
    fantagazzetta: 'Fantagazzetta',
    apifootball:   'API-Football',
    tmw:           'TuttoMercatoWeb',
  }[id] || id;
}
