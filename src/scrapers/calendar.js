/**
 * calendar.js — Fetch calendario partite da fonti ICS/Google Calendar pubbliche
 * Usato come fallback/cross-check per date ufficiali quando API-Football non matcha
 *
 * Fonti ICS pubbliche affidabili:
 * - football-data.co.uk (CSV storici)
 * - soccerway / livescore embed
 * - Calendari Google pubblici per Serie A, PL, ecc.
 */

import { fetchHTML } from './http.js';
import { logger } from '../index.js';

// Calendari ICS pubblici per campionato
// Questi sono calendari Google/iCal pubblici con fixture ufficiali
const CALENDAR_URLS = {
  serie_a: [
    'https://www.football-data.co.uk/fixtures.csv', // CSV con tutte le serie A
  ],
  premier_league: [
    'https://www.football-data.co.uk/engfixtures.csv',
  ],
};

// Mappa nome squadra → varianti normalizzate per cross-matching
const TEAM_ALIASES = {
  // Serie A
  'inter':          ['inter milan','fc internazionale','internazionale','inter milano'],
  'milan':          ['ac milan','milan ac'],
  'juventus':       ['juve','juventus fc'],
  'napoli':         ['ssc napoli','napoli fc'],
  'roma':           ['as roma','roma fc'],
  'lazio':          ['ss lazio','lazio rome'],
  'fiorentina':     ['acf fiorentina'],
  'atalanta':       ['atalanta bc'],
  'torino':         ['torino fc'],
  'bologna':        ['bologna fc'],
  // Premier League
  'manchester city':  ['man city','manchester city fc','man. city'],
  'manchester united':['man utd','man united','manchester utd'],
  'arsenal':          ['arsenal fc'],
  'chelsea':          ['chelsea fc'],
  'liverpool':        ['liverpool fc'],
  'tottenham':        ['tottenham hotspur','spurs','tottenham fc'],
  'newcastle':        ['newcastle united','newcastle utd'],
  'aston villa':      ['aston villa fc'],
  // La Liga
  'real madrid':      ['real madrid cf','r. madrid'],
  'barcelona':        ['fc barcelona','barca','barça'],
  'atletico madrid':  ['atletico de madrid','atl. madrid','atlético madrid'],
  // Bundesliga
  'bayern munich':    ['fc bayern','fc bayern münchen','bayern münchen','fc bayern munich'],
  'borussia dortmund':['bvb','dortmund'],
  // Ligue 1
  'paris saint-germain':['psg','paris sg','paris saint germain'],
  // Champions League — nomi già standard
};

/**
 * Normalizza nome squadra per confronto cross-source
 */
export function normalizeTeamName(raw) {
  if (!raw) return '';
  const clean = raw.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\b(fc|ac|sc|bc|cf|afc|ssc|bvb|vfb|rb|1\.|fsv)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Cerca alias
  for (const [canonical, aliases] of Object.entries(TEAM_ALIASES)) {
    if (clean === canonical || aliases.some(a => clean.includes(a) || a.includes(clean))) {
      return canonical;
    }
  }
  return clean;
}

/**
 * Parse ICS format — estrae VEVENT con DTSTART, SUMMARY
 */
function parseICS(icsText) {
  const events = [];
  const blocks = icsText.split('BEGIN:VEVENT');

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];

    const dtstart = block.match(/DTSTART[^:]*:(\d{8}T\d{6}Z?|\d{8})/)?.[1];
    const summary = block.match(/SUMMARY:(.+)/)?.[1]?.trim();
    const location = block.match(/LOCATION:(.+)/)?.[1]?.trim();

    if (!dtstart || !summary) continue;

    // Parse data
    let date = '', time = '00:00';
    if (dtstart.length >= 8) {
      const y = dtstart.slice(0,4);
      const m = dtstart.slice(4,6);
      const d = dtstart.slice(6,8);
      date = `${y}-${m}-${d}`;
    }
    if (dtstart.length >= 15) {
      const h = dtstart.slice(9,11);
      const min = dtstart.slice(11,13);
      time = `${h}:${min}`;
    }

    // Parse summary (tipicamente "Home vs Away" o "Home - Away")
    const vsMatch = summary.match(/^(.+?)\s+(?:vs?\.?|-|–)\s+(.+?)(?:\s*\(.*\))?$/i);
    if (!vsMatch) continue;

    events.push({
      home: vsMatch[1].trim(),
      away: vsMatch[2].trim(),
      date,
      time,
      venue: location || null,
      source: 'ics',
    });
  }

  return events;
}

/**
 * Fetch e parse calendario ICS per un campionato
 */
export async function fetchCalendarFixtures(league) {
  const urls = CALENDAR_URLS[league];
  if (!urls?.length) return [];

  const allEvents = [];

  for (const url of urls) {
    try {
      const text = await fetchHTML(url, { retries: 2 });
      if (!text) continue;

      // Detect formato
      if (text.includes('BEGIN:VCALENDAR') || text.includes('BEGIN:VEVENT')) {
        const events = parseICS(text);
        allEvents.push(...events);
        logger.info(`[Calendar] ${league}: ${events.length} eventi da ${url}`);
      }
    } catch (err) {
      logger.warn(`[Calendar] ${league} fetch failed (${url}): ${err.message}`);
    }
  }

  return allEvents;
}

/**
 * Cross-match tra fixture API-Football e calendario ICS
 * Restituisce una mappa arricchita con i dati più affidabili
 */
export function crossMatchFixtures(apiFixtures, calendarEvents) {
  if (!calendarEvents.length) return apiFixtures;

  const enriched = [...apiFixtures];

  for (const fix of enriched) {
    const homeNorm = normalizeTeamName(fix.home?.name || fix.home);
    const awayNorm = normalizeTeamName(fix.away?.name || fix.away);

    // Cerca match nel calendario
    const calMatch = calendarEvents.find(ev => {
      const evHome = normalizeTeamName(ev.home);
      const evAway = normalizeTeamName(ev.away);
      return (
        (evHome === homeNorm || evHome.includes(homeNorm) || homeNorm.includes(evHome)) &&
        (evAway === awayNorm || evAway.includes(awayNorm) || awayNorm.includes(evAway))
      );
    });

    if (calMatch) {
      // Arricchisci con dati calendario se mancanti
      if (!fix.venue && calMatch.venue) fix.venue = calMatch.venue;
      // Il calendario ICS è più affidabile per date/orari pubblici
      if (calMatch.date && calMatch.date !== fix.date) {
        logger.info(`[Calendar] Date mismatch for ${fix.home?.name} vs ${fix.away?.name}: API=${fix.date}, ICS=${calMatch.date}`);
      }
    }
  }

  return enriched;
}
