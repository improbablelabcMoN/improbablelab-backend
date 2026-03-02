import * as cheerio from 'cheerio';
import { fetchHTML } from './http.js';
import { logger } from '../index.js';

const BASE = 'https://lineups.besoccer.com';

export const LEAGUE_SLUGS = {
  serie_a:          'serie_a',
  premier_league:   'premier_league',
  la_liga:          'primera_division',
  bundesliga:       'bundesliga',
  ligue_1:          'ligue_1',
  champions_league: 'champions_league',
};

// Mappa ruoli BeSoccer → label leggibile
const ROLE_MAP = {
  por: 'POR', gk: 'POR', goalkeeper: 'POR',
  def: 'DIF', defender: 'DIF', cb: 'DIF', lb: 'DIF', rb: 'DIF', wb: 'DIF',
  mid: 'CEN', midfielder: 'CEN', cm: 'CEN', dm: 'CEN', am: 'CEN',
  att: 'ATT', forward: 'ATT', fw: 'ATT', st: 'ATT', lw: 'ATT', rw: 'ATT',
};

function normalizeRole(raw = '') {
  return ROLE_MAP[raw.toLowerCase().trim()] || 'N/D';
}

// ── Scrape pagina singola partita per ottenere i giocatori ──────────────
async function scrapeMatchPage(matchUrl, league) {
  try {
    const html = await fetchHTML(matchUrl);
    const $ = cheerio.load(html);
    const homePlayers = [];
    const awayPlayers = [];

    // BeSoccer usa .team-players o .lineup-list con .player-item
    const panels = $('.lineup-panel, .team-lineup, .team-box, [class*="lineup"]');

    panels.each((panelIdx, panel) => {
      const players = [];
      $(panel).find('.player, .player-name, [class*="player"]').each((_, el) => {
        const name = $(el).find('.name, span, strong').first().text().trim()
          || $(el).text().trim();
        const roleRaw = $(el).find('.role, .position, [class*="pos"]').text().trim()
          || $(el).attr('data-pos') || '';
        const numRaw = $(el).find('.num, .number, [class*="num"]').text().trim()
          || $(el).attr('data-num') || '';
        const isSub = $(el).closest('.bench, .substitutes, [class*="bench"]').length > 0;

        if (name && name.length > 1 && name.length < 40 && !name.match(/^\d+$/)) {
          players.push({
            name: cleanName(name),
            prob: isSub ? 0 : 85,
            role: normalizeRole(roleRaw),
            num:  parseInt(numRaw) || 0,
            isSub,
          });
        }
      });

      if (players.length > 0) {
        if (panelIdx === 0) homePlayers.push(...players);
        else awayPlayers.push(...players);
      }
    });

    // Fallback: cerca tabelle o liste più semplici
    if (homePlayers.length === 0) {
      let panelIdx = 0;
      $('.team, .squad, [class*="team-"]').each((_, teamEl) => {
        const players = [];
        $(teamEl).find('li, .row, tr').each((_, row) => {
          const text = $(row).text().replace(/\s+/g, ' ').trim();
          if (text.length > 2 && text.length < 50 && !text.match(/^\d+$/)) {
            players.push({ name: cleanName(text), prob: 80, role: 'N/D', num: 0, isSub: false });
          }
        });
        if (players.length >= 5) {
          if (panelIdx === 0) homePlayers.push(...players.slice(0, 18));
          else awayPlayers.push(...players.slice(0, 18));
          panelIdx++;
        }
      });
    }

    // Rileva modulo dal testo pagina
    const pageText = $.text();
    const formHome = (pageText.match(/\b([34][- ][1-5][- ][1-5][- ]?[1-3]?)\b/) || [])[1] || 'N/D';

    return {
      homePlayers: homePlayers.filter(p => !p.isSub).slice(0, 11),
      awayPlayers: awayPlayers.filter(p => !p.isSub).slice(0, 11),
      homeBench:   homePlayers.filter(p => p.isSub).slice(0, 9),
      awayBench:   awayPlayers.filter(p => p.isSub).slice(0, 9),
      formation:   formHome,
    };
  } catch (err) {
    logger.warn(`[BeSoccer] Match page failed: ${matchUrl} — ${err.message}`);
    return { homePlayers: [], awayPlayers: [], homeBench: [], awayBench: [], formation: 'N/D' };
  }
}

function cleanName(raw) {
  return raw
    .replace(/\d{1,3}%/g, '')
    .replace(/^[\d\s.]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Entry point principale ──────────────────────────────────────────────
export async function scrapeLineups(league = 'premier_league') {
  const slug = LEAGUE_SLUGS[league];
  if (!slug) throw new Error(`BeSoccer: league '${league}' non supportata`);

  const url = `${BASE}/en/competition/${slug}/`;
  logger.info(`[BeSoccer] Scraping ${league} — ${url}`);

  const html = await fetchHTML(url);
  const $ = cheerio.load(html);

  // Raccoglie tutti i link partita univoci
  const matchLinks = [];
  const seen = new Set();

  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (!href.includes('/en/match/')) return;

    const urlMatch = href.match(/\/en\/match\/([^/]+)\/([^/]+)\//);
    if (!urlMatch) return;

    const home = titleCase(urlMatch[1].replace(/-/g, ' '));
    const away = titleCase(urlMatch[2].replace(/-/g, ' '));
    const key  = `${home}|${away}`;
    if (seen.has(key)) return;
    seen.add(key);

    const $card     = $(a).closest('[class*="match"], [class*="game"], li, .panel');
    const cardText  = $card.text().toLowerCase();
    const confirmed = cardText.includes('confirmed') || cardText.includes('confermata');

    // Data/ora dal card
    const timeText  = $card.find('[class*="time"], [class*="date"], time').first().text().trim();

    matchLinks.push({
      home, away,
      matchUrl:    href.startsWith('http') ? href : `${BASE}${href}`,
      isConfirmed: confirmed,
      timeText,
    });
  });

  logger.info(`[BeSoccer] Found ${matchLinks.length} match links for ${league}`);

  // Limita a 8 partite max per evitare rate limiting
  const toFetch = matchLinks.slice(0, 8);

  const matches = [];
  for (const link of toFetch) {
    const details = await scrapeMatchPage(link.matchUrl, league);
    matches.push({
      source:      'besoccer',
      league,
      homeTeam:    link.home,
      awayTeam:    link.away,
      matchUrl:    link.matchUrl,
      isConfirmed: link.isConfirmed,
      homePlayers: details.homePlayers,
      awayPlayers: details.awayPlayers,
      bench:       details.homeBench,
      formation:   details.formation,
      scrapedAt:   new Date().toISOString(),
    });

    // Pausa tra richieste per non bloccare
    await new Promise(r => setTimeout(r, 800));
  }

  logger.info(`[BeSoccer] Scraped ${matches.length} matches with players for ${league}`);
  return matches;
}

function titleCase(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}
