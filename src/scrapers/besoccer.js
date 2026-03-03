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

// Converte "18 FEB 2026" + "21:00" → "2026-02-18" e "21:00"
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

// ── Entry point principale: scrapa tutto dalla pagina campionato ─────────
export async function scrapeLineups(league = 'premier_league') {
  const slug = LEAGUE_SLUGS[league];
  if (!slug) throw new Error(`BeSoccer: league '${league}' non supportata`);

  const url = `${BASE}/en/competition/${slug}/`;
  logger.info(`[BeSoccer] Scraping ${league} — ${url}`);

  const html = await fetchHTML(url);
  const $ = cheerio.load(html);

  const matches = [];

  // Ogni partita è dentro div.card
  $('div.card').each((_, card) => {
    const $card = $(card);

    // ── Data e ora ──────────────────────────────────────────
    const dateText = $card.find('.card-header span.date').first().text().trim();
    const hourText = $card.find('.card-header span.hour').first().text().trim();
    const { date, time } = parseDateTime(dateText, hourText);

    // ── Nomi squadre ────────────────────────────────────────
    const $matchLink = $card.find('a.match-link').first();
    const homeName = cleanName($card.find('[id^="team1_"]').first().text());
    const awayName = cleanName($card.find('[id^="team2_"]').first().text());

    if (!homeName || !awayName) return; // card non valida

    // ── Stato partita (Fin = terminata, Apl = rinviata) ─────
    const $tag = $card.find('[data-tag]').first();
    const tag  = ($tag.attr('data-tag') || '').toLowerCase();
    let staticStatus = 'scheduled';
    if (tag === 'fin')       staticStatus = 'final';
    else if (tag === 'live') staticStatus = 'live';

    // ── Risultato (solo se terminata/live) ──────────────────
    let score = undefined;
    const $result = $card.find('[id^="result_"]').first();
    const resultSpan = $result.find('span[data-r1]').first();
    if (resultSpan.length) {
      score = {
        home: parseInt(resultSpan.attr('data-r1')) || 0,
        away: parseInt(resultSpan.attr('data-r2')) || 0,
      };
    }

    // ── Giocatori: ul.squad.local e ul.squad.visitor ─────────
    function extractPlayers($ul) {
      const players = [];
      const formation = $ul.attr('data-tacticname') || 'N/D';
      const isConfirmed = $ul.hasClass('confirmed');

      $ul.find('li[data-name]').each((_, li) => {
        const name = cleanName($(li).attr('data-name') || '');
        const num  = parseInt($(li).find('span').first().text().trim()) || 0;
        if (!name || name.length < 2) return;
        players.push({
          name,
          num,
          prob: isConfirmed ? 95 : 80,
          role: 'N/D',
        });
      });

      return { players, formation, confirmed: isConfirmed };
    }

    const $localUl   = $card.find('ul.squad.local').first();
    const $visitorUl = $card.find('ul.squad.visitor').first();

    const homeExtracted = $localUl.length   ? extractPlayers($localUl)   : { players: [], formation: 'N/D', confirmed: false };
    const awayExtracted = $visitorUl.length ? extractPlayers($visitorUl) : { players: [], formation: 'N/D', confirmed: false };

    // ── Struttura lineup per righe (semplificata: POR + outfield) ──
    function buildLineup(players, formation) {
      if (players.length === 0) return [];
      const por      = players.slice(0, 1);
      const outfield = players.slice(1);
      // Dividi outfield in 3 gruppi uguali basandoci sul modulo
      const parts = formation.split('-').filter(p => /^\d+$/.test(p)).map(Number);
      if (parts.length >= 3) {
        let idx = 0;
        const rows = [por];
        for (const count of parts) {
          rows.push(outfield.slice(idx, idx + count));
          idx += count;
        }
        return rows.filter(r => r.length > 0);
      }
      // Fallback: 3 righe da 3-4 giocatori
      const rows = [por];
      for (let i = 0; i < outfield.length; i += 4) {
        rows.push(outfield.slice(i, i + 4));
      }
      return rows;
    }

    function buildTeamData(extracted) {
      const { players, formation, confirmed } = extracted;
      const lineup = buildLineup(
        players.map(p => ({
          n: p.name, num: p.num, p: p.prob, pos: 'N/D',
          shirt: '#1a5276',
        })),
        formation
      );
      const playersList = players.map(p => ({
        n: p.name, pos: 'N/D', num: p.num, p: p.prob,
        rat: 6.5, g: 0, a: 0, app: 10, h: [],
      }));
      const source = {
        id: 'besoccer',
        name: 'BeSoccer',
        form: formation,
        time: 'ora',
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

    // ── ID partita ──────────────────────────────────────────
    const href   = $matchLink.attr('href') || '';
    const matchIdMatch = href.match(/\/(\d+)$/);
    const matchId = matchIdMatch ? matchIdMatch[1] : `${Date.now()}`;
    const id = `${league}_${homeName.toLowerCase().replace(/\s+/g,'_').slice(0,8)}_${matchId}`;

    // Conf: se entrambe le squadre hanno giocatori confermati → 90, altrimenti 65
    const hasHome = homeExtracted.players.length >= 11;
    const hasAway = awayExtracted.players.length >= 11;
    const conf = (hasHome && hasAway) ? 90 : (hasHome || hasAway) ? 75 : 60;

    matches.push({
      id,
      league,
      home: homeName,
      away: awayName,
      date,
      time,
      staticStatus,
      score,
      conf,
      homeColor: '#1a5276',
      awayColor: '#922b21',
      homeData: buildTeamData(homeExtracted),
      awayData: buildTeamData(awayExtracted),
    });
  });

  logger.info(`[BeSoccer] Parsed ${matches.length} matches for ${league}`);
  return matches.map(m => ({ source: 'besoccer', ...m }));
}
