import * as cheerio from 'cheerio';
import { fetchHTML } from './http.js';
import { logger } from '../index.js';

const BASE = 'https://lineups.besoccer.com';

export const LEAGUE_SLUGS = {
  serie_a: 'serie_a', premier_league: 'premier_league', la_liga: 'primera_division',
  bundesliga: 'bundesliga', ligue_1: 'ligue_1', champions_league: 'champions_league',
};

export async function scrapeLineups(league = 'premier_league') {
  const slug = LEAGUE_SLUGS[league];
  if (!slug) throw new Error(`BeSoccer: league '${league}' non supportata`);
  const url = `${BASE}/en/competition/${slug}/`;
  logger.info(`[BeSoccer] Scraping ${league} — ${url}`);
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  const matches = [];

  $('a[href*="/en/match/"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const urlMatch = href.match(/\/en\/match\/([^/]+)\/([^/]+)\//);
    if (!urlMatch) return;
    const home = urlMatch[1].replace(/-/g, ' ');
    const away = urlMatch[2].replace(/-/g, ' ');
    const $card = $(a).closest('.match-info, .panel, li, .card');
    const confirmed = $card.text().toLowerCase().includes('confirmed');
    matches.push({
      source: 'besoccer', league,
      homeTeam: home, awayTeam: away,
      matchUrl: href.startsWith('http') ? href : `${BASE}${href}`,
      isConfirmed: confirmed,
      starters: [], bench: [],
      scrapedAt: new Date().toISOString(),
    });
  });

  const seen = new Set();
  const unique = matches.filter(m => {
    const k = `${m.homeTeam}-${m.awayTeam}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  logger.info(`[BeSoccer] Found ${unique.length} matches for ${league}`);
  return unique;
}
