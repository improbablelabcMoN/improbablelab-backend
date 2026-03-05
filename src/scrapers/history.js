/**
 * history.js — Storico formazioni per sistema predittivo
 *
 * Persiste su disco (data/history/) le formazioni reali di ogni squadra
 * dopo ogni partita giocata. Da questo storico calcola per ogni giocatore:
 *   - frequenza titolare (ultimi N match)
 *   - ruolo abituale
 *   - streak titolare/panchina recente
 *   - prob_base da usare come punto di partenza prima che arrivino le probabili
 *
 * Flusso:
 *   1. aggregator.js chiama getHistoricalProbs(team, league) → prob per giocatore
 *   2. Queste prob si fondono con quelle degli scraper (peso decrescente se i live sono disponibili)
 *   3. Dopo ogni match con risultato, recordMatch() salva la formazione reale
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(__dirname, '../../data/history');

// Quante partite passate considerare per calcolare le probabilità base
const HISTORY_WINDOW = 10;

// ── Utility I/O ───────────────────────────────────────────────────────────

function teamFile(teamName, league) {
  const safe = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g,'_');
  return path.join(DATA_DIR, league, `${safe(teamName)}.json`);
}

function ensureDir(league) {
  const dir = path.join(DATA_DIR, league);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadTeam(teamName, league) {
  const file = teamFile(teamName, league);
  if (!fs.existsSync(file)) return { team: teamName, league, matches: [] };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { team: teamName, league, matches: [] };
  }
}

function saveTeam(data, teamName, league) {
  ensureDir(league);
  fs.writeFileSync(teamFile(teamName, league), JSON.stringify(data, null, 2));
}

// ── Normalizza nome giocatore (stesso algoritmo di aggregator.js) ─────────

function normName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // rimuove accenti
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(de|van|di|del|della|dos|da|el|al|le|la|los|las)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(t => t.length > 1)
    .slice(-2)
    .join(' ');
}

// ── recordMatch — salva formazione reale dopo partita ────────────────────
/**
 * Chiamare dopo che una partita è terminata (staticStatus === 'final')
 * per registrare le formazioni reali nel database storico.
 *
 * @param {object} match — oggetto partita dal frontend/aggregator
 * @param {string} league
 */
export function recordMatch(match, league) {
  if (!match?.home || !match?.away) return;

  const date = match.date || new Date().toISOString().slice(0, 10);

  for (const side of ['home', 'away']) {
    const teamName = side === 'home' ? match.home : match.away;
    const teamData = side === 'home' ? match.homeData : match.awayData;
    if (!teamData?.players?.length) continue;

    const record = loadTeam(teamName, league);

    // Evita duplicati (stessa partita già salvata)
    const matchKey = `${match.home}_${match.away}_${date}`;
    if (record.matches.some(m => m.key === matchKey)) continue;

    const entry = {
      key:      matchKey,
      date,
      opponent: side === 'home' ? match.away : match.home,
      home:     side === 'home',
      result:   match.score
        ? `${match.score.home ?? '?'}-${match.score.away ?? '?'}`
        : null,
      starters: teamData.players
        .filter(p => (p.p || 0) >= 70) // solo i titolari certi
        .map(p => ({
          name: p.n || p.name || '',
          role: p.pos || p.role || 'N/D',
          num:  p.num || 0,
        })),
    };

    record.matches.unshift(entry); // più recente prima
    // Mantieni solo gli ultimi 20 match
    if (record.matches.length > 20) record.matches = record.matches.slice(0, 20);
    record.updatedAt = new Date().toISOString();

    try {
      saveTeam(record, teamName, league);
      logger.info(`[History] Saved ${teamName} (${league}): ${entry.starters.length} starters`);
    } catch (err) {
      logger.warn(`[History] Could not save ${teamName}: ${err.message}`);
    }
  }
}

// ── getHistoricalProbs — calcola prob base da storico ────────────────────
/**
 * Restituisce una mappa { normName → { prob, role, streak, appearances } }
 * basata sulle ultime HISTORY_WINDOW partite della squadra.
 *
 * prob_base = (n_partite_da_titolare / n_partite_totali) * 100
 *   + bonus streak (ultime 3 da titolare → +5)
 *   - malus streak (ultime 3 in panchina → -10)
 *
 * @param {string} teamName
 * @param {string} league
 * @returns {Map<string, {prob:number, role:string, streak:number, appearances:number}>}
 */
export function getHistoricalProbs(teamName, league) {
  const record  = loadTeam(teamName, league);
  const matches = record.matches.slice(0, HISTORY_WINDOW);
  const result  = new Map();

  if (!matches.length) return result;

  // Raccolta presenze per ogni giocatore
  const playerStats = new Map();

  matches.forEach((match, matchIdx) => {
    const starterSet = new Set(match.starters.map(p => normName(p.name)));
    // Tutti i giocatori visti in qualsiasi match
    match.starters.forEach(p => {
      const key = normName(p.name);
      if (!key) return;
      if (!playerStats.has(key)) {
        playerStats.set(key, {
          originalName: p.name,
          role:         p.role || 'N/D',
          num:          p.num  || 0,
          appearances:  new Array(matches.length).fill(false),
        });
      }
      playerStats.get(key).appearances[matchIdx] = true;
      // Aggiorna ruolo con il più recente
      if (matchIdx === 0 && p.role && p.role !== 'N/D') {
        playerStats.get(key).role = p.role;
      }
    });
  });

  // Calcola probabilità per ogni giocatore
  for (const [key, stats] of playerStats.entries()) {
    const apps   = stats.appearances;
    const total  = matches.length;
    const played = apps.filter(Boolean).length;

    // Prob base: frequenza titolare
    const baseProb = Math.round((played / total) * 100);

    // Streak recente (ultimi 3 match)
    const recent3    = apps.slice(0, 3);
    const streak3    = recent3.filter(Boolean).length;
    const streakBonus = streak3 === 3 ? 5 : streak3 === 0 ? -10 : 0;

    // Prob finale capped
    const prob = Math.min(88, Math.max(10, baseProb + streakBonus));

    result.set(key, {
      originalName: stats.originalName,
      role:         stats.role,
      num:          stats.num,
      prob,
      appearances:  played,
      total,
      streak:       streak3,  // quante delle ultime 3 da titolare
    });
  }

  return result;
}

// ── mergeWithHistory — fonde prob storiche con prob live degli scraper ────
/**
 * Arricchisce la playerMap dell'aggregator con dati storici.
 * Logica di peso:
 *   - Se ci sono N fonti live (scraper) → storico ha peso residuale (20%)
 *   - Se ci sono 0 fonti live (partita lontana) → storico è l'unica fonte (80%)
 *   - Se ci sono giocatori storici non nelle fonti live → li aggiunge con prob ridotta
 *
 * @param {Map} playerMap    — mappa giocatori dall'aggregator (può essere vuota)
 * @param {string} teamName
 * @param {string} league
 * @param {number} liveSources — numero di fonti live disponibili
 */
export function mergeWithHistory(playerMap, teamName, league, liveSources = 0) {
  const histProbs = getHistoricalProbs(teamName, league);
  if (!histProbs.size) return; // nessuno storico disponibile

  // Peso dello storico in base alla disponibilità di fonti live
  // 0 fonti live → peso storico 0.8 | 1 fonte → 0.4 | 2+ fonti → 0.15
  const histWeight = liveSources === 0 ? 0.80
                   : liveSources === 1 ? 0.40
                   : 0.15;
  const liveWeight = 1 - histWeight;

  // 1. Aggiusta prob dei giocatori già in playerMap
  for (const [liveKey, livePlayer] of playerMap.entries()) {
    const normKey = normName(livePlayer.originalName || liveKey);
    const hist    = histProbs.get(normKey);
    if (!hist) continue;

    // Media pesata
    const liveProb = livePlayer.probs?.[0] || 75;
    const blended  = Math.round(liveProb * liveWeight + hist.prob * histWeight);
    if (livePlayer.probs) livePlayer.probs[0] = blended;

    // Aggiorna ruolo se mancante
    if (livePlayer.role === 'N/D' && hist.role !== 'N/D') {
      livePlayer.role = hist.role;
    }

    // Aggiungi metadati storici
    livePlayer.histProb      = hist.prob;
    livePlayer.appearances   = hist.appearances;
    livePlayer.totalMatches  = hist.total;
    livePlayer.recentStreak  = hist.streak;
  }

  // 2. Aggiungi giocatori storici non presenti nelle fonti live
  // (solo se poche fonti live — quando la partita è lontana)
  if (histWeight >= 0.4) {
    for (const [histKey, hist] of histProbs.entries()) {
      // Cerca se esiste già nella playerMap (con nome simile)
      const alreadyPresent = [...playerMap.keys()].some(k =>
        normName(k) === histKey || k.includes(histKey) || histKey.includes(normName(k))
      );
      if (alreadyPresent) continue;

      // Aggiungi con prob ridotta (storico senza conferma live)
      const adjustedProb = Math.round(hist.prob * histWeight);
      if (adjustedProb < 25) continue; // troppo incerto, non mostrare

      playerMap.set(histKey, {
        name:         hist.originalName,
        originalName: hist.originalName,
        role:         hist.role,
        num:          hist.num,
        sources:      ['history'],
        probs:        [adjustedProb],
        histProb:     hist.prob,
        appearances:  hist.appearances,
        totalMatches: hist.total,
        recentStreak: hist.streak,
        fromHistory:  true,
      });
    }
  }
}

// ── getTeamHistory — espone storico grezzo per debug/frontend ─────────────
export function getTeamHistory(teamName, league) {
  return loadTeam(teamName, league);
}

// ── listTeams — lista squadre con storico salvato ─────────────────────────
export function listTeamsWithHistory(league) {
  const dir = path.join(DATA_DIR, league);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''));
}

// ── autoRecord — chiamato dall'aggregator dopo ogni merge ────────────────
/**
 * Controlla se ci sono partite finite non ancora registrate e le salva.
 * Da chiamare alla fine di aggregateLeague().
 */
export function autoRecord(matches, league) {
  let saved = 0;
  for (const m of matches) {
    if (m.staticStatus === 'final' || m.dynStatus === 'finished') {
      recordMatch(m, league);
      saved++;
    }
  }
  if (saved > 0) logger.info(`[History] autoRecord: ${saved} partite salvate per ${league}`);
}
