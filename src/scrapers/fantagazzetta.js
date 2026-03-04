/**
 * Fantagazzetta.com — Probabili Formazioni Serie A
 * URL: https://www.fantagazzetta.com/formazioni/probabili-formazioni-serie-a
 *
 * Struttura pagina:
 * - Ogni partita è in un blocco .fg-match-lineup o simile
 * - I giocatori titolari con percentuale titolarità
 * - Modulo (es. 3-5-2) indicato per squadra
 */

import * as cheerio from 'cheerio';
import { fetchHTML } from './http.js';
import { logger } from '../index.js';

const URL = 'https://www.fantagazzetta.com/formazioni/probabili-formazioni-serie-a';

const ROLE_MAP = {
  'p': 'POR', 'por': 'POR', 'portiere': 'POR',
  'd': 'DIF', 'dif': 'DIF', 'difensore': 'DIF', 'dc': 'DIF', 'ts': 'DIF', 'ds': 'DIF', 'td': 'DIF', 'terzino': 'DIF',
  'c': 'CEN', 'cen': 'CEN', 'centrocampista': 'CEN', 'cc': 'CEN', 'm': 'CEN', 'mf': 'CEN', 'trq': 'CEN', 'mezzala': 'CEN',
  'a': 'ATT', 'att': 'ATT', 'attaccante': 'ATT', 'w': 'ATT', 'ala': 'ATT', 'pc': 'ATT', 't': 'ATT',
};

function normalizeRole(raw = '') {
  return ROLE_MAP[raw.toLowerCase().trim().replace(/[^a-z]/g, '')] || 'N/D';
}

function extractProb(text = '') {
  const m = text.match(/(\d{2,3})\s*%/);
  return m ? Math.min(100, parseInt(m[1])) : 80;
}

function cleanName(raw = '') {
  return raw
    .replace(/\d+\s*%/g, '')
    .replace(/^[PDCAMWT]{1,3}\s+/i, '')
    .replace(/^\d+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseVsTitle(text = '') {
  if (!text || text.length > 120) return null;
  const m = text.match(/^(.+?)\s*(?:[-–—]|vs\.?)\s*(.+?)(?:\s*[\|\-].*)?$/i);
  if (!m) return null;
  const home = m[1].trim();
  const away = m[2].trim();
  if (home.length < 2 || home.length > 50) return null;
  if (away.length < 2 || away.length > 50) return null;
  return { home, away };
}

export async function scrapeLineups() {
  logger.info(`[Fantagazzetta] Scraping Serie A — ${URL}`);
  const html = await fetchHTML(URL);
  const $ = cheerio.load(html);
  const matches = [];

  // ── Strategia 1: blocchi partita dedicati ──────────────────────────────
  // Fantagazzetta usa spesso strutture come:
  // <div class="match-container"> o <article class="match">
  // con h2/h3 per il titolo partita e liste per i giocatori

  const matchSelectors = [
    '.match-container', '.fg-match', '.lineup-block',
    '.probabili-formazioni-match', '[class*="match-lineup"]',
    '[class*="lineup"]', 'article.match', '.scheda-partita',
  ];

  let matchBlocks = $();
  for (const sel of matchSelectors) {
    const found = $(sel);
    if (found.length > 1) { matchBlocks = found; break; }
  }

  if (matchBlocks.length > 0) {
    matchBlocks.each((_, block) => {
      const $block = $(block);
      const titleText = $block.find('h2, h3, .match-title, .title').first().text().trim();
      const parsed = parseVsTitle(titleText);
      if (!parsed) return;

      const homePlayers = [];
      const awayPlayers = [];

      // Cerca colonne home/away
      const cols = $block.find('.home, .away, .team-home, .team-away, .col-home, .col-away, [class*="home"], [class*="away"]');
      if (cols.length >= 2) {
        const homeCol = cols.filter('[class*="home"]').first();
        const awayCol = cols.filter('[class*="away"]').first();
        extractPlayersFromBlock($, homeCol, homePlayers);
        extractPlayersFromBlock($, awayCol, awayPlayers);
      } else {
        // Fallback: prendi tutti i giocatori dal blocco
        extractPlayersFromBlock($, $block, homePlayers);
      }

      if (homePlayers.length > 0) {
        const formation = extractFormation($block.text());
        matches.push({
          source: 'fantagazzetta',
          league: 'serie_a',
          homeTeam: parsed.home,
          awayTeam: parsed.away,
          homePlayers,
          awayPlayers,
          formation,
          scrapedAt: new Date().toISOString(),
        });
      }
    });
  }

  // ── Strategia 2: parsing testuale per sezione (fallback) ───────────────
  if (matches.length === 0) {
    logger.info('[Fantagazzetta] Strategia 1 fallita, provo parsing testuale...');

    let current = null;
    let isHome = true;

    $('h2, h3, h4, ul, ol, p, .player, [class*="player"], [class*="giocatore"]').each((_, el) => {
      const tag = el.tagName.toLowerCase();
      const text = $(el).text().trim();

      if (tag === 'h2' || tag === 'h3' || tag === 'h4') {
        const parsed = parseVsTitle(text);
        if (parsed) {
          if (current && current.homePlayers.length > 0) matches.push(current);
          current = {
            source: 'fantagazzetta',
            league: 'serie_a',
            homeTeam: parsed.home,
            awayTeam: parsed.away,
            homePlayers: [],
            awayPlayers: [],
            formation: 'N/D',
            scrapedAt: new Date().toISOString(),
          };
          isHome = true;
        }
        return;
      }

      if (!current) return;

      // Cerca divisore home/away
      if (text.toLowerCase().includes(current.homeTeam.toLowerCase().slice(0, 5))) isHome = true;
      if (text.toLowerCase().includes(current.awayTeam.toLowerCase().slice(0, 5))) isHome = false;

      // Modulo
      if (/^\d-\d-\d/.test(text) && current.formation === 'N/D') {
        current.formation = text.match(/\d-\d-\d(-\d)?/)?.[0] || 'N/D';
      }

      // Lista giocatori
      if (tag === 'ul' || tag === 'ol') {
        $(el).find('li').each((_, li) => {
          const liText = $(li).text().trim();
          if (liText.length < 2 || liText.length > 60) return;
          const probMatch = liText.match(/(\d{2,3})\s*%/);
          const role = liText.match(/^([PDCAMWT]{1,3})\s/i)?.[1] || 'N/D';
          const player = {
            name: cleanName(liText),
            prob: probMatch ? parseInt(probMatch[1]) : 80,
            role: normalizeRole(role),
          };
          if (player.name.length > 2) {
            (isHome ? current.homePlayers : current.awayPlayers).push(player);
          }
        });
      }
    });

    if (current && current.homePlayers.length > 0) matches.push(current);
  }

  // ── Strategia 3: cerca elementi con classe player/giocatore ovunque ───
  if (matches.length === 0) {
    logger.info('[Fantagazzetta] Strategia 2 fallita, provo classe player...');

    $('[class*="player"], [class*="giocatore"], [class*="calciatore"]').each((_, el) => {
      const text = $(el).text().trim();
      if (text.length < 2 || text.length > 60) return;
      const probMatch = text.match(/(\d{2,3})\s*%/);
      // Senza contesto partita non possiamo associare, skip
    });
  }

  logger.info(`[Fantagazzetta] Found ${matches.length} matches`);
  return matches;
}

function extractPlayersFromBlock($, $block, players) {
  $block.find('li, [class*="player"], [class*="giocatore"]').each((_, el) => {
    const text = $(el).text().trim();
    if (text.length < 2 || text.length > 60) return;
    const probMatch = text.match(/(\d{2,3})\s*%/);
    const roleMatch = text.match(/^([PDCAMWT]{1,3})\s/i);
    players.push({
      name: cleanName(text),
      prob: probMatch ? parseInt(probMatch[1]) : 80,
      role: normalizeRole(roleMatch?.[1] || 'N/D'),
    });
  });
}

function extractFormation(text = '') {
  const m = text.match(/\b(\d-\d-\d(?:-\d)?)\b/);
  return m ? m[1] : 'N/D';
}
