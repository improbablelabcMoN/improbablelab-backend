import * as cheerio from 'cheerio';
import { fetchHTML } from './http.js';
import { logger } from '../index.js';

const URL = 'https://www.sosfanta.com/lista-formazioni/probabili-formazioni-serie-a/';

// Ruoli comuni in italiano
const ROLE_MAP = {
  'p': 'POR', 'por': 'POR', 'portiere': 'POR',
  'd': 'DIF', 'dif': 'DIF', 'difensore': 'DIF', 'dc': 'DIF', 'ts': 'DIF', 'ds': 'DIF',
  'c': 'CEN', 'cen': 'CEN', 'centrocampista': 'CEN', 'cc': 'CEN', 'mf': 'CEN', 'trq': 'CEN',
  'a': 'ATT', 'att': 'ATT', 'attaccante': 'ATT', 'w': 'ATT', 'tr': 'ATT',
};

function normalizeRole(raw = '') {
  return ROLE_MAP[raw.toLowerCase().trim()] || 'N/D';
}

function cleanPlayerName(raw) {
  return raw
    .replace(/\d+%/g, '')
    .replace(/^\s*[\d.]+\s*/, '') // rimuove numero maglia iniziale
    .replace(/\s+/g, ' ')
    .trim();
}

function extractProb(text) {
  const m = text.match(/(\d{2,3})\s*%/);
  return m ? Math.min(100, parseInt(m[1])) : 80;
}

export async function scrapeLineups() {
  logger.info(`[SosFanta] Scraping Serie A — ${URL}`);
  const html = await fetchHTML(URL);
  const $ = cheerio.load(html);
  const matches = [];

  // ── Strategia 1: blocchi partita con classe specifica ─────────────────
  const matchBlocks = $(
    '.match-block, .formazione-block, [class*="match"], [class*="formazione"], ' +
    '.lineup-container, .probabili-container, article'
  ).toArray();

  if (matchBlocks.length > 0) {
    for (const block of matchBlocks) {
      const $b     = $(block);
      const title  = $b.find('h2, h3, h4, .match-title, .teams').first().text().trim();
      const vsMatch = parseVsTitle(title);
      if (!vsMatch) continue;

      const players = extractPlayersFromBlock($b, $);
      if (players.length < 3) continue;

      matches.push(buildMatch(vsMatch, players, $b, $));
    }
  }

  // ── Strategia 2: heading h2/h3 + contenuto seguente ──────────────────
  if (matches.length === 0) {
    $('h2, h3').each((_, heading) => {
      const title = $(heading).text().trim();
      const vsMatch = parseVsTitle(title);
      if (!vsMatch) return;

      // Raccoglie elementi fino all'heading successivo
      const $section = $(heading).nextUntil('h2, h3');
      const players = [];

      $section.find('li, .player, [class*="player"], tr, .row').each((_, el) => {
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        if (text.length < 2 || text.length > 60) return;

        const roleEl = $(el).find('[class*="role"], [class*="pos"], .ruolo').text().trim();
        const prob   = extractProb(text);
        const name   = cleanPlayerName(text);

        if (name.length > 1 && !name.match(/^\d+$/))
          players.push({ name, prob, role: normalizeRole(roleEl), num: 0 });
      });

      if (players.length < 3) return;
      const $section2 = $(heading).nextUntil('h2, h3');
      matches.push(buildMatch(vsMatch, players, $section2, $));
    });
  }

  // ── Strategia 3: tabelle ──────────────────────────────────────────────
  if (matches.length === 0) {
    $('table').each((_, table) => {
      const caption = $(table).find('caption, th').first().text().trim();
      const vsMatch = parseVsTitle(caption);
      if (!vsMatch) return;

      const players = [];
      $(table).find('tr').each((_, tr) => {
        const cells = $(tr).find('td').map((_, td) => $(td).text().trim()).toArray();
        if (cells.length < 1) return;
        const name = cleanPlayerName(cells[1] || cells[0]);
        const role = normalizeRole(cells[0]);
        const prob = cells.length > 2 ? extractProb(cells[cells.length - 1]) : 80;
        if (name.length > 1) players.push({ name, prob, role, num: 0 });
      });

      if (players.length < 3) return;
      matches.push(buildMatch(vsMatch, players, $(table), $));
    });
  }

  logger.info(`[SosFanta] Found ${matches.length} matches`);
  return matches;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function parseVsTitle(text) {
  if (!text || text.length > 80) return null;
  const m = text.match(/^(.+?)\s*(?:[-–—vsVS]+|contro)\s*(.+?)(?:\s*\|.*)?$/i);
  if (!m) return null;
  const home = m[1].trim();
  const away = m[2].trim();
  if (home.length < 2 || home.length > 40) return null;
  if (away.length < 2 || away.length > 40) return null;
  // Evita falsi positivi (titoli di sezione generici)
  if (/probabili|formazioni|serie|giornata|turno/i.test(home)) return null;
  return { home, away };
}

function extractPlayersFromBlock($block, $) {
  const players = [];

  $block.find('li, .player, [class*="player"], [class*="nome"], tr').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text.length < 2 || text.length > 60) return;

    const roleRaw = $(el).find('[class*="role"], [class*="pos"], [class*="ruol"]').text().trim()
      || $(el).attr('data-role') || $(el).attr('data-pos') || '';
    const prob = extractProb(text);
    const name = cleanPlayerName(text);

    if (name.length > 1 && !name.match(/^\d+$/) && !name.match(/^\W+$/))
      players.push({ name, prob, role: normalizeRole(roleRaw), num: 0 });
  });

  return players;
}

function buildMatch(vsMatch, players, $container, $) {
  // Prova a leggere il modulo
  const containerText = typeof $container.text === 'function' ? $container.text() : '';
  const formMatch = containerText.match(/\b([34][- ][1-5][- ][1-5][- ]?[1-3]?)\b/);
  const formation = formMatch ? formMatch[1].replace(/\s/g, '-') : 'N/D';

  // Separa titolari (prob > 50) da indisponibili
  const starters    = players.filter(p => p.prob > 50).slice(0, 11);
  const unavailable = players.filter(p => p.prob <= 50).map(p => p.name);

  return {
    source:      'sosfanta',
    league:      'serie_a',
    homeTeam:    vsMatch.home,
    awayTeam:    vsMatch.away,
    homePlayers: starters,
    awayPlayers: [],   // SosFanta lista per squadra singola
    formation,
    unavailable,
    scrapedAt: new Date().toISOString(),
  };
}
