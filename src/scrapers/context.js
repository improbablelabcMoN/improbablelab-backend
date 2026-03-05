/**
 * context.js — LIVELLO 2: Contesto partita
 *
 * Aggiusta le probabilità dei giocatori in base a:
 *   1. Tipo di partita (campionato vs coppa → turnover)
 *   2. Distanza dall'ultima partita (< 3 giorni → rotazione)
 *   3. Squalifiche (gialli accumulati)
 *
 * Input:  playerMap (da aggregator), match metadata, storico partite
 * Output: playerMap modificata (prob aggiustate in place)
 */

import { getTeamHistory } from './history.js';
import { logger } from '../index.js';

// Campionati considerati "coppa" (più turnover probabile)
const CUP_LEAGUES = new Set(['champions_league', 'europa_league', 'coppa_italia', 'fa_cup']);

// Soglia giorni per considerare "ravvicinata" l'ultima partita
const FATIGUE_THRESHOLD_DAYS = 3;

/**
 * Applica il contesto partita alla playerMap di una squadra.
 *
 * @param {Map}    playerMap   — mappa giocatori (modificata in place)
 * @param {string} teamName
 * @param {string} league
 * @param {object} matchMeta  — { date, league, isHome }
 * @param {string[]} suspendedPlayers — nomi squalificati (da feed ufficiali)
 */
export function applyMatchContext(playerMap, teamName, league, matchMeta = {}, suspendedPlayers = []) {
  const history = getTeamHistory(teamName, league);
  const matches = history.matches || [];

  // ── 1. Tipo partita: coppa → turnover atteso ──────────────────────────
  const isCup = CUP_LEAGUES.has(league);

  // ── 2. Distanza dall'ultima partita ──────────────────────────────────
  const matchDate = matchMeta.date ? new Date(matchMeta.date) : null;
  let fatigue = false;
  if (matchDate && matches.length > 0) {
    const lastMatch = matches[0]; // più recente
    const lastDate  = new Date(lastMatch.date);
    const daysBetween = (matchDate - lastDate) / (1000 * 60 * 60 * 24);
    fatigue = daysBetween > 0 && daysBetween < FATIGUE_THRESHOLD_DAYS;
    if (fatigue) {
      logger.info(`[Context] ${teamName}: ultima partita ${Math.round(daysBetween)}gg fa → rotazione probabile`);
    }
  }

  // ── 3. Squalifiche ────────────────────────────────────────────────────
  const suspNorm = new Set(suspendedPlayers.map(n => normName(n)));

  // ── Applica aggiustamenti ─────────────────────────────────────────────
  for (const [key, player] of playerMap.entries()) {
    const pNorm = normName(player.originalName || key);

    // Squalificato → prob = 0
    if (suspNorm.size > 0 && suspNorm.has(pNorm)) {
      if (player.probs) player.probs[0] = 0;
      player.suspended = true;
      player.contextNote = 'Squalificato';
      logger.info(`[Context] ${teamName} — ${player.originalName}: SQUALIFICATO`);
      continue;
    }

    // Fatica/ravvicinata + coppa: i titolari fissi rischiano turnover
    if (fatigue && isCup) {
      const currentProb = player.probs?.[0] ?? 75;
      // Solo i titolari fissi (prob alta) vengono abbassati
      if (currentProb >= 80) {
        const newProb = Math.max(50, currentProb - 15);
        if (player.probs) player.probs[0] = newProb;
        player.contextNote = 'Possibile turnover (coppa + ravvicinata)';
      }
    } else if (fatigue && !isCup) {
      // Campionato + ravvicinata: leggero malus per chi ha giocato più minuti
      const currentProb = player.probs?.[0] ?? 75;
      if (currentProb >= 85) {
        const newProb = Math.max(65, currentProb - 8);
        if (player.probs) player.probs[0] = newProb;
        player.contextNote = 'Possibile riposo (ravvicinata)';
      }
    }
  }

  return {
    fatigue,
    isCup,
    suspendedCount: suspNorm.size,
  };
}

/**
 * Calcola i giorni dall'ultima partita per una squadra.
 * Utile per mostrarlo nel frontend come contesto.
 */
export function getDaysSinceLastMatch(teamName, league, currentDate) {
  const history = getTeamHistory(teamName, league);
  const matches = history.matches || [];
  if (!matches.length) return null;

  const lastDate = new Date(matches[0].date);
  const curr     = currentDate ? new Date(currentDate) : new Date();
  const days     = Math.round((curr - lastDate) / (1000 * 60 * 60 * 24));
  return days >= 0 ? days : null;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function normName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(de|van|di|del|della|dos|da|el|al|le|la|los|las)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(t => t.length > 1)
    .slice(-2)
    .join(' ');
}
