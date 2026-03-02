import * as cheerio from 'cheerio';
import { fetchHTML } from './http.js';
import { logger } from '../index.js';

const URL = 'https://www.sosfanta.com/lista-formazioni/probabili-formazioni-serie-a/';

export async function scrapeLineups() {
  logger.info(`[SosFanta] Scraping Serie A`);
  const html = await fetchHTML(URL);
  const $ = cheerio.load(html);
  const matches = [];

  $('h2, h3').each((_, heading) => {
    const text = $(heading).text().trim();
    const vsMatch = text.match(/^(.+?)\s*[-–vsVS]+\s*(.+?)$/i);
    if (!vsMatch || vsMatch[1].length > 40) return;
    const players = [];
    $(heading).nextUntil('h2, h3').find('li, .player').each((_, p) => {
      const name = $(p).text().trim();
      if (name && name.length > 2 && name.length < 35)
        players.push({ name, prob: 80, role: 'N/D' });
    });
    matches.push({
      source: 'sosfanta', league: 'serie_a',
      homeTeam: vsMatch[1].trim(), awayTeam: vsMatch[2].trim(),
      homePlayers: players.slice(0, 11), awayPlayers: [],
      formation: 'N/D', unavailable: [],
      scrapedAt: new Date().toISOString(),
    });
  });

  logger.info(`[SosFanta] Found ${matches.length} matches`);
  return matches;
}
