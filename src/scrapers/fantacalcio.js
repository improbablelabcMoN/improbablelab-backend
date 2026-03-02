import * as cheerio from 'cheerio';
import { fetchHTML } from './http.js';
import { logger } from '../index.js';

const URL = 'https://www.fantacalcio.it/probabili-formazioni-serie-a';

const ROLE_MAP = {
  'p': 'POR', 'por': 'POR',
  'd': 'DIF', 'dif': 'DIF', 'dc': 'DIF', 'ts': 'DIF', 'ds': 'DIF', 'td': 'DIF',
  'c': 'CEN', 'cen': 'CEN', 'cc': 'CEN', 'mf': 'CEN', 'trq': 'CEN', 'm': 'CEN',
  'a': 'ATT', 'att': 'ATT', 'w': 'ATT', 't': 'ATT', 'pc': 'ATT',
};

function normalizeRole(raw = '') {
  const clean = raw.toLowerCase().trim().replace(/[^a-z]/g, '');
  return ROLE_MAP[clean] || 'N/D';
}

function extractProb(text) {
  const m = text.match(/(\d{2,3})\s*%/);
  return m ? Math.min(100, parseInt(m[1])) : 80;
}

function cleanPlayerName(raw) {
  return raw
    .replace(/\d+%/g, '')
    .replace(/^\s*[PDCAMWT]{1,3}\s+/i, '') // rimuove prefisso ruolo
    .replace(/^\s*[\d.]+\s*/, '')            // rimuove numero maglia
    .replace(/\s+/g, ' ')
    .trim();
}

function parseVsTitle(text) {
  if (!text || text.length > 100) return null;
  const m = text.match(/^(.+?)\s*(?:[-–—vsVS]+|contro|vs\.?)\s*(.+?)(?:\s*\|.*)?$/i);
  if (!m) return null;
  const home = m[1].trim();
  const away = m[2].trim();
  if (home.length < 2 || home.length > 45) return null;
  if (away.length < 2 || away.length > 45) return null;
  if (/probabili|formazioni|serie|giornata|turno|classifica/i.test(home)) return null;
  return { home, away };
}

export async function scrapeLineups() {
  logger.info(`[Fantacalcio] Scraping Serie A — ${URL}`);
  const html = await fetchHTML(URL);
  const $ = cheerio.load(html);
  const matches = [];

  // ── Strategia 1: container partita dedicato ────────────────────────────
  const matchSelectors = [
    '.match-container', '.match-box', '.lineup-box',
    '[class*="probabili"]', '[class*="formazione"]',
    '.card[class*="match"]', 'article',
  ];

  for (const sel of matchSelectors) {
    const blocks = $(sel).toArray();
    if (blocks.length === 0) continue;

    for (const block of blocks) {
      const $b    = $(block);
      const title = $b.find('h2, h3, h4, .title, .match-title').first().text().trim();
      const vs    = parseVsTitle(title);
      if (!vs) continue;

      const players = extractPlayersFromBlock($b, $);
      if (players.length < 3) continue;

      matches.push(buildMatch(vs, players, $b.text()));
    }

    if (matches.length > 0) break;
  }

  // ── Strategia 2: heading + lista ──────────────────────────────────────
  if (matches.length === 0) {
    $('h2, h3, h4').each((_, heading) => {
      const title = $(heading).text().trim();
      const vs    = parseVsTitle(title);
      if (!vs) return;

      const players = [];
      const $next   = $(heading).nextUntil('h2, h3, h4');

      // Cerca player con probabilità esplicita (tipico di Fantacalcio)
      $next.find('li, .player, [class*="player"]').each((_, el) => {
        const $el     = $(el);
        const fullTxt = $el.text().replace(/\s+/g, ' ').trim();
        if (fullTxt.length < 2 || fullTxt.length > 80) return;

        // Fantacalcio spesso ha struttura: [Ruolo] Nome Cognome XX%
        const roleEl  = $el.find('[class*="role"], [class*="pos"], [class*="sigla"], .r').text().trim();
        const prob    = extractProb(fullTxt);
        const name    = cleanPlayerName($el.find('.name, .player-name, strong, b').text().trim() || fullTxt);

        if (name.length > 1 && !name.match(/^\d+$/) && !name.match(/^[PDCAM]$/))
          players.push({ name, prob, role: normalizeRole(roleEl), num: 0 });
      });

      if (players.length < 3) return;

      const sectionText = $next.text();
      matches.push(buildMatch(vs, players, sectionText));
    });
  }

  // ── Strategia 3: tabelle ──────────────────────────────────────────────
  if (matches.length === 0) {
    $('table').each((_, table) => {
      const $t     = $(table);
      const title  = $t.prev('h2, h3, h4').text().trim() || $t.find('caption').text().trim();
      const vs     = parseVsTitle(title);
      if (!vs) return;

      const players = [];
      $t.find('tr').slice(1).each((_, tr) => { // skip header row
        const cells = $(tr).find('td, th').map((_, td) => $(td).text().trim()).toArray();
        if (cells.length < 2) return;

        // Colonne tipiche: Ruolo | Nome | Prob% | Note
        const roleRaw = cells[0];
        const name    = cleanPlayerName(cells[1] || cells[0]);
        const probTxt = cells.find(c => /\d+%/.test(c)) || '';
        const prob    = extractProb(probTxt);

        if (name.length > 1 && !name.match(/^\d+$/))
          players.push({ name, prob, role: normalizeRole(roleRaw), num: 0 });
      });

      if (players.length < 3) return;
      matches.push(buildMatch(vs, players, $t.text()));
    });
  }

  logger.info(`[Fantacalcio] Found ${matches.length} matches`);
  return matches;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function extractPlayersFromBlock($block, $) {
  const players = [];

  $block.find('li, .player, [class*="player"], tr').each((_, el) => {
    const $el    = $(el);
    const text   = $el.text().replace(/\s+/g, ' ').trim();
    if (text.length < 2 || text.length > 80) return;

    const roleRaw = $el.find('[class*="role"], [class*="pos"], [class*="sigla"], .r').text().trim()
      || $el.attr('data-role') || '';
    const prob    = extractProb(text);
    const nameEl  = $el.find('.name, .player-name, strong, b').text().trim();
    const name    = cleanPlayerName(nameEl || text);

    if (name.length > 1 && !name.match(/^\d+$/) && !name.match(/^[PDCAM]{1,2}$/))
      players.push({ name, prob, role: normalizeRole(roleRaw), num: 0 });
  });

  return players;
}

function buildMatch(vs, players, sectionText = '') {
  const formMatch = sectionText.match(/\b([34][- ][1-5][- ][1-5][- ]?[1-3]?)\b/);
  const formation = formMatch ? formMatch[1].replace(/\s/g, '-') : 'N/D';

  // Titolari = prob > 50, dubbi = prob 30-50, indisponibili = prob < 30
  const starters    = players.filter(p => p.prob > 50).slice(0, 11);
  const unavailable = players.filter(p => p.prob < 30).map(p => p.name);

  return {
    source:      'fantacalcio',
    league:      'serie_a',
    homeTeam:    vs.home,
    awayTeam:    vs.away,
    homePlayers: starters,
    awayPlayers: [],
    formation,
    unavailable,
    scrapedAt:   new Date().toISOString(),
  };
}
