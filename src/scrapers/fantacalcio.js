import * as cheerio from 'cheerio';
import { fetchHTML } from './http.js';
import { logger } from '../index.js';

const URL = 'https://www.fantacalcio.it/probabili-formazioni-serie-a';

export async function scrapeLineups() {
  logger.info(`[Fantacalcio] Scraping Serie A`);
  const html = await fetchHTML(URL);
  const $ = cheerio.load(html);
  const matches = [];

  $('h2, h3').each((_, heading) => {
    const text = $(heading).text().trim();
    const vsMatch = text.match(/^(.+?)\s*[-–vsVS]+\s*(.+?)$/i);
    if (!vsMatch || vsMatch[1].length > 40) return;
    const players = [];
    $(heading).nextUntil('h2, h3').find('li').each((_, li) => {
      const t = $(li).text().trim();
      const probMatch = t.match(/(\d+)%/);
      if (t.length > 2 && t.length < 40)
        players.push({ name: t.replace(/\d+%/,'').trim(), prob: probMatch ? parseInt(probMatch[1]) : 80, role: 'N/D' });
    });
    matches.push({
      source: 'fantacalcio', league: 'serie_a',
      homeTeam: vsMatch[1].trim(), awayTeam: vsMatch[2].trim(),
      homePlayers: players.slice(0, 11), awayPlayers: [],
      formation: 'N/D', unavailable: [],
      scrapedAt: new Date().toISOString(),
    });
  });

  logger.info(`[Fantacalcio] Found ${matches.length} matches`);
  return matches;
}
