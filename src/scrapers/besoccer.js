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

    // BeSoccer struttura reale:
    // <li data-name="Mile Svilar">
    //   <div class="player-img">
    //     <span class="num local">99</span>
    //   </div>
    // </li>
    // I giocatori di casa hanno span.num.local, quelli in trasferta span.num.visitor
    // Le liste sono dentro .panel-lineup o .team-lineup separati per squadra

    // Strategia 1: usa data-name su li, distingui local/visitor dal span
    $('li[data-name]').each((_, li) => {
      const name = $(li).attr('data-name') || '';
      if (!name || name.length < 2) return;

      const numEl   = $(li).find('span.num');
      const numText = numEl.text().trim();
      const num     = parseInt(numText) || 0;
      const isLocal = numEl.hasClass('local');
      const isVisitor = numEl.hasClass('visitor');
      const isSub   = $(li).closest('.subs, .substitutes, [class*="sub"]').length > 0;

      const player = {
        name: cleanName(name),
        prob: isSub ? 0 : 85,
        role: 'N/D',
        num,
        isSub,
      };

      if (isLocal)   homePlayers.push(player);
      else if (isVisitor) awayPlayers.push(player);
      else {
        // fallback: primo pannello = home, secondo = away
        const panel = $(li).closest('[class*="panel"], [class*="team"], ul').first();
        const panelIdx = $('[class*="panel"], [class*="team"]').index(panel);
        if (panelIdx <= 0) homePlayers.push(player);
        else awayPlayers.push(player);
      }
    });

    // Strategia 2: se data-name non ha trovato nulla, fallback su testo li
    if (homePlayers.length === 0 && awayPlayers.length === 0) {
      let panelIdx = 0;
      $('[class*="lineup"], [class*="team-box"], [class*="team_box"]').each((_, panel) => {
        const players = [];
        $(panel).find('li').each((_, li) => {
          const name = cleanName($(li).text());
          const num  = parseInt($(li).find('[class*="num"]').text()) || 0;
          if (name.length > 2 && name.length < 40 && !name.match(/^\d+$/))
            players.push({ name, prob: 85, role: 'N/D', num, isSub: false });
        });
        if (players.length >= 5) {
          if (panelIdx === 0) homePlayers.push(...players);
          else awayPlayers.push(...players);
          panelIdx++;
        }
      });
    }

    // Rileva modulo dal testo pagina
    const pageText = $.text();
    const formHome = (pageText.match(/\b([34][- ][1-5][- ][1-5][- ]?[1-3]?)\b/) || [])[1] || 'N/D';

    logger.info(`[BeSoccer] ${matchUrl} → home:${homePlayers.length} away:${awayPlayers.length}`);

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

    // Format: /en/match/{home}/{away}/{match_id}
    const urlMatch = href.match(/\/en\/match\/([^/]+)\/([^/]+)\/(\d+)/);
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
