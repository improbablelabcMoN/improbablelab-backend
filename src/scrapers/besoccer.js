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
  europa_league:    'europa_league',
};

function parseDateTime(dateStr, hourStr) {
  const MONTHS = {
    JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',
    JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12'
  };
  try {
    const parts = dateStr.trim().toUpperCase().split(/\s+/);
    if (parts.length === 3) {
      const day   = parts[0].padStart(2, '0');
      const month = MONTHS[parts[1]] || '01';
      const year  = parts[2];
      return { date: `${year}-${month}-${day}`, time: hourStr.trim() };
    }
  } catch (_) {}
  return { date: '', time: hourStr.trim() };
}

function cleanName(raw) {
  return raw.replace(/\s+/g, ' ').trim();
}

function parseMatchesFromHTML(html, league) {
  const $ = cheerio.load(html);
  const matches = [];

  $('div.card').each((_, card) => {
    const $card = $(card);

    const dateText = $card.find('.card-header span.date').first().text().trim();
    const hourText = $card.find('.card-header span.hour').first().text().trim();
    const { date, time } = parseDateTime(dateText, hourText);

    const $matchLink = $card.find('a.match-link').first();
    const homeName = cleanName($card.find('[id^="team1_"]').first().text());
    const awayName = cleanName($card.find('[id^="team2_"]').first().text());

    if (!homeName || !awayName) return;

    const $tag = $card.find('[data-tag]').first();
    const tag  = ($tag.attr('data-tag') || '').toLowerCase();
    let staticStatus = 'scheduled';
    if (tag === 'fin')       staticStatus = 'final';
    else if (tag === 'live') staticStatus = 'live';

    let score = undefined;
    const resultSpan = $card.find('[id^="result_"] span[data-r1]').first();
    if (resultSpan.length) {
      score = {
        home: parseInt(resultSpan.attr('data-r1')) || 0,
        away: parseInt(resultSpan.attr('data-r2')) || 0,
      };
    }

    function extractPlayers($ul) {
      const players = [];
      const formation = $ul.attr('data-tacticname') || 'N/D';
      const isConfirmed = $ul.hasClass('confirmed');

      $ul.find('li[data-name]').each((_, li) => {
        const name = cleanName($(li).attr('data-name') || '');
        const num  = parseInt($(li).find('span').first().text().trim()) || 0;
        if (!name || name.length < 2) return;
        players.push({ name, num, prob: isConfirmed ? 95 : 80, role: 'N/D' });
      });

      return { players, formation, confirmed: isConfirmed };
    }

    const $localUl   = $card.find('ul.squad.local').first();
    const $visitorUl = $card.find('ul.squad.visitor').first();

    const homeExtracted = $localUl.length   ? extractPlayers($localUl)   : { players: [], formation: 'N/D', confirmed: false };
    const awayExtracted = $visitorUl.length ? extractPlayers($visitorUl) : { players: [], formation: 'N/D', confirmed: false };

    function buildLineup(players, formation) {
      if (players.length === 0) return [];
      const tokens = players.map(p => ({
        n: p.name, num: p.num, p: p.prob, pos: 'N/D', shirt: '#1a5276',
      }));
      const parts = formation.split('-').filter(p => /^\d+$/.test(p)).map(Number);
      if (parts.length >= 3 && tokens.length >= 11) {
        const rows = [tokens.slice(0, 1)];
        let idx = 1;
        for (const count of parts) {
          rows.push(tokens.slice(idx, idx + count));
          idx += count;
        }
        return rows.filter(r => r.length > 0);
      }
      const rows = [tokens.slice(0, 1)];
      const outfield = tokens.slice(1);
      const chunk = Math.ceil(outfield.length / 3);
      for (let i = 0; i < outfield.length; i += chunk) {
        rows.push(outfield.slice(i, i + chunk));
      }
      return rows.filter(r => r.length > 0);
    }

    function buildTeamData(extracted) {
      const { players, formation, confirmed } = extracted;
      const lineup = buildLineup(players, formation);
      const playersList = players.map(p => ({
        n: p.name, pos: 'N/D', num: p.num, p: p.prob,
        rat: 6.5, g: 0, a: 0, app: 10, h: [],
      }));
      const source = {
        id: 'besoccer', name: 'BeSoccer', form: formation, time: 'ora',
        players: players.map(p => p.name),
        conf: confirmed ? players.map(p => p.name) : [],
        doubt: [],
      };
      return {
        form: formation,
        lineup,
        bench: [],
        sources: players.length > 0 ? [source] : [],
        players: playersList,
      };
    }

    const href = $matchLink.attr('href') || '';
    const matchIdMatch = href.match(/\/(\d+)$/);
    const matchId = matchIdMatch ? matchIdMatch[1] : `${Date.now()}`;
    const safeHome = homeName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
    const id = `${league}_${safeHome}_${matchId}`;

    const hasHome = homeExtracted.players.length >= 11;
    const hasAway = awayExtracted.players.length >= 11;
    const conf = (hasHome && hasAway) ? 90 : (hasHome || hasAway) ? 75 : 60;

    matches.push({
      id, league, home: homeName, away: awayName,
      date, time, staticStatus, score, conf,
      homeColor: '#1a5276', awayColor: '#922b21',
      homeData: buildTeamData(homeExtracted),
      awayData: buildTeamData(awayExtracted),
    });
  });

  logger.info(`[BeSoccer] Parsed ${matches.length} matches from page`);
  return matches;
}

// ── Entry point principale ──────────────────────────────────────────────
export async function scrapeLineups(league = 'premier_league') {
  const slug = LEAGUE_SLUGS[league];
  if (!slug) throw new Error(`BeSoccer: league '${league}' non supportata`);

  const mainUrl = `${BASE}/en/competition/${slug}/`;
  logger.info(`[BeSoccer] Scraping ${league} — ${mainUrl}`);

  // Carica pagina principale e trova il numero della giornata corrente
  const html1 = await fetchHTML(mainUrl);
  const $main = cheerio.load(html1);
  const selectedOption = $main('option[selected]').val() || '';
  const currentMatchday = parseInt(selectedOption.match(/matchday-(\d+)/)?.[1] || '0');

  logger.info(`[BeSoccer] Current matchday: ${currentMatchday} for ${league}`);

  // Scrapa le 2 giornate precedenti in parallelo
  const prevHtmls = await Promise.all(
    [1, 2].map(offset => {
      const md = currentMatchday - offset;
      if (md < 1) return Promise.resolve(null);
      const url = `${BASE}/en/competition/${slug}/matchday-${md}`;
      logger.info(`[BeSoccer] Fetching previous matchday ${md} — ${url}`);
      return fetchHTML(url).catch(err => {
        logger.warn(`[BeSoccer] matchday-${md} failed: ${err.message}`);
        return null;
      });
    })
  );

  // Parsa tutte le pagine
  const matches1 = parseMatchesFromHTML(html1, league);
  const matches2 = prevHtmls[0] ? parseMatchesFromHTML(prevHtmls[0], league) : [];
  const matches3 = prevHtmls[1] ? parseMatchesFromHTML(prevHtmls[1], league) : [];

  // Unisci evitando duplicati — priorità alla giornata più recente
  const seen = new Set();
  const allMatches = [];

  for (const m of [...matches1, ...matches2, ...matches3]) {
    const key = `${m.home}|${m.away}`;
    if (!seen.has(key)) {
      seen.add(key);
      allMatches.push(m);
    }
  }

  logger.info(`[BeSoccer] Total ${allMatches.length} matches for ${league} (md${currentMatchday}: ${matches1.length}, md${currentMatchday-1}: ${matches2.length}, md${currentMatchday-2}: ${matches3.length})`);
  return allMatches.map(m => ({ source: 'besoccer', ...m }));
}
