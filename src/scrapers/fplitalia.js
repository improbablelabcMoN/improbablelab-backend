import * as cheerio from 'cheerio';
import { fetchHTML } from './http.js';
import { logger } from '../index.js';

const URL = 'https://fplitalia.com/probabili-formazioni-premier-league/';

export async function scrapeLineups() {
  logger.info(`[FPLItalia] Scraping Premier League`);
  const html = await fetchHTML(URL);
  const $ = cheerio.load(html);
  const matches = [];
  let current = null;

  $('.entry-content, article').find('h2, h3, ul, p').each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const text = $(el).text().trim();
    if (tag === 'h2' || tag === 'h3') {
      const m = text.match(/^(.+?)\s*[-–vsVS]+\s*(.+?)$/i);
      if (m && m[1].length < 40) {
        if (current) matches.push(current);
        current = { source: 'fplitalia', league: 'premier_league', homeTeam: m[1].trim(), awayTeam: m[2].trim(), homePlayers: [], awayPlayers: [], formation: 'N/D', scrapedAt: new Date().toISOString() };
      }
      return;
    }
    if (!current) return;
    if (tag === 'ul') {
      $(el).find('li').each((_, li) => {
        const t = $(li).text().trim();
        const pm = t.match(/(\d+)%/);
        if (t.length > 2 && t.length < 40)
          current.homePlayers.push({ name: t.replace(/\d+%/,'').trim(), prob: pm ? parseInt(pm[1]) : 80, role: 'N/D' });
      });
    }
  });
  if (current) matches.push(current);
  logger.info(`[FPLItalia] Found ${matches.length} matches`);
  return matches;
}
