/**
 * news.js — LIVELLO 3: Notizie infortuni/squalifiche
 *
 * Scraping da TuttoMercatoWeb (TMW) per trovare:
 *   - Infortuni confermati → prob = 0
 *   - "In dubbio" / "out" → prob -30%
 *   - Rientri → prob +15%
 *   - Conferenza stampa → leggero boost
 *
 * Cache: 30 minuti (le notizie non cambiano di frequente)
 * Trigger: D-2 / D-1 prima della partita
 */

import { fetchHTML } from './http.js';
import { logger }    from '../index.js';

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minuti
const newsCache = new Map();

// Parole chiave per classificare le notizie
const INJURY_KEYWORDS    = ['infortunio', 'infortuna', 'lesione', 'lesionat', 'muscolar', 'fuori', 'out', 'ko', 'stop', 'assente', 'indisponibile', 'si ferma'];
const DOUBT_KEYWORDS     = ['dubbio', 'in forse', 'non sicuro', 'da valutare', 'a rischio', 'non certo', 'non convocato'];
const RETURN_KEYWORDS    = ['rientra', 'torna', 'disponibile', 'recupera', 'recuperato', 'tornato'];
const SUSPENDED_KEYWORDS = ['squalificato', 'squalifica', 'diffidato', 'cartellino rosso', 'espulso'];

/**
 * Scarica e analizza le notizie di infortuni per una squadra.
 * Restituisce un array di news classificate.
 *
 * @param {string} teamName — nome squadra
 * @param {string} league
 * @returns {Promise<Array<{player, type, text, impact, source}>>}
 */
export async function fetchTeamNews(teamName, league) {
  const cacheKey = `${league}_${teamName.toLowerCase().replace(/\s+/g,'_')}`;
  const cached   = newsCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    logger.info(`[News] CACHE HIT for ${teamName}`);
    return cached.data;
  }

  try {
    const news = await scrapeFromTMW(teamName, league);
    newsCache.set(cacheKey, { data: news, expiresAt: Date.now() + CACHE_TTL_MS });
    if (news.length > 0) logger.info(`[News] Trovate ${news.length} notizie per ${teamName}`);
    return news;
  } catch (err) {
    // Fail silently — il sistema funziona senza notizie
    return [];
  }
}

/**
 * Applica le notizie alla playerMap.
 * Modifica le probabilità in place.
 *
 * @param {Map}    playerMap
 * @param {Array}  news      — output di fetchTeamNews
 * @param {string} teamName  — per il log
 */
export function applyNewsToPlayerMap(playerMap, news, teamName) {
  if (!news?.length) return;

  for (const item of news) {
    if (!item.player) continue;
    const targetNorm = normName(item.player);

    // Cerca il giocatore nella playerMap
    for (const [key, player] of playerMap.entries()) {
      const playerNorm = normName(player.originalName || key);
      if (!namesMatch(playerNorm, targetNorm)) continue;

      const currentProb = player.probs?.[0] ?? 75;

      switch (item.type) {
        case 'injury':
          // Infortunio confermato → prob = 0
          if (player.probs) player.probs[0] = 0;
          player.newsNote = `🤕 ${item.text}`;
          player.newsImpact = 'high';
          logger.info(`[News] ${teamName} — ${player.originalName}: INFORTUNATO (prob → 0)`);
          break;

        case 'doubt':
          // In dubbio → -30%
          if (player.probs) player.probs[0] = Math.max(10, Math.round(currentProb * 0.7));
          player.newsNote = `⚠️ ${item.text}`;
          player.newsImpact = item.impact || 'medium';
          logger.info(`[News] ${teamName} — ${player.originalName}: IN DUBBIO (prob ${currentProb} → ${player.probs[0]})`);
          break;

        case 'suspended':
          // Squalificato → prob = 0
          if (player.probs) player.probs[0] = 0;
          player.suspended = true;
          player.newsNote = `🟥 ${item.text}`;
          player.newsImpact = 'high';
          logger.info(`[News] ${teamName} — ${player.originalName}: SQUALIFICATO (prob → 0)`);
          break;

        case 'return':
          // Rientro → +15%, max 85
          if (player.probs) player.probs[0] = Math.min(85, currentProb + 15);
          player.newsNote = `✅ ${item.text}`;
          player.newsImpact = 'medium';
          logger.info(`[News] ${teamName} — ${player.originalName}: RIENTRA (prob ${currentProb} → ${player.probs[0]})`);
          break;
      }

      break; // trovato, passa alla prossima news
    }
  }
}

// ── Scraping TMW ──────────────────────────────────────────────────────────

async function scrapeFromTMW(teamName, league = '') {
  // TMW è focalizzato sul calcio italiano — salta per leghe estere
  const italianLeagues = new Set(['serie_a']);
  if (!italianLeagues.has(league)) return [];

  const slug = teamName.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  // Prova prima con URL diretto categoria formazioni
  const urls = [
    `https://www.tuttomercatoweb.com/serie-a/probabili-formazioni/`,
    `https://www.tuttomercatoweb.com/premier-league/probabili-formazioni/`,
    `https://www.tuttomercatoweb.com/calciomercato/infortuni/`,
  ];

  // Usa solo la prima URL generica — non per squadra singola
  // TMW non ha pagine per squadra con slug semplice
  const url = `https://www.tuttomercatoweb.com/calcio/${slug}/`;
  try {
    const html = await fetchHTML(url);
    if (!html) return [];
    return parseNewsFromHtml(html, teamName);
  } catch {
    return [];
  }
}

function parseNewsFromHtml(html, teamName) {
  const news = [];
  const seen = new Set();

  // Cerca pattern "<titolo notizia>" con parole chiave di infortuni
  // TMW usa struttura: <h2 class="title"><a href="...">Titolo</a></h2>
  const titleRegex = /<(?:h[23]|div)[^>]*class="[^"]*(?:title|news-title|art-title)[^"]*"[^>]*>.*?<a[^>]*>([^<]+)<\/a>/gi;
  let match;

  while ((match = titleRegex.exec(html)) !== null) {
    const title = decodeHtml(match[1]).trim();
    if (!title || seen.has(title)) continue;
    seen.add(title);

    const titleLower = title.toLowerCase();
    const newsItem   = classifyTitle(title, titleLower);
    if (newsItem) news.push(newsItem);
  }

  // Fallback: cerca titoli in <a> con lunghezza ragionevole
  if (news.length === 0) {
    const linkRegex = /<a[^>]+href="[^"]*"[^>]*>([A-Z][^<]{15,120})<\/a>/g;
    while ((match = linkRegex.exec(html)) !== null) {
      const title = decodeHtml(match[1]).trim();
      if (!title || seen.has(title)) continue;
      seen.add(title);
      const titleLower = title.toLowerCase();
      const newsItem   = classifyTitle(title, titleLower);
      if (newsItem) news.push(newsItem);
    }
  }

  return news.slice(0, 10); // max 10 notizie per squadra
}

function classifyTitle(title, titleLower) {
  // Estrai nome giocatore: spesso è il primo elemento maiuscolo
  const playerMatch = title.match(/^([A-ZÀÈÌÒÙ][a-zàèìòù'-]+(?:\s+[A-ZÀÈÌÒÙ][a-zàèìòù'-]+)*)/);
  const player = playerMatch ? playerMatch[1] : null;

  if (SUSPENDED_KEYWORDS.some(kw => titleLower.includes(kw))) {
    return { player, type: 'suspended', text: title, impact: 'high', source: 'tmw' };
  }
  if (INJURY_KEYWORDS.some(kw => titleLower.includes(kw))) {
    return { player, type: 'injury', text: title, impact: 'high', source: 'tmw' };
  }
  if (DOUBT_KEYWORDS.some(kw => titleLower.includes(kw))) {
    return { player, type: 'doubt', text: title, impact: 'medium', source: 'tmw' };
  }
  if (RETURN_KEYWORDS.some(kw => titleLower.includes(kw))) {
    return { player, type: 'return', text: title, impact: 'medium', source: 'tmw' };
  }
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function normName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(de|van|di|del|della|dos|da|el|al|le|la|los|las)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(t => t.length > 1)
    .slice(-2)
    .join(' ');
}

function namesMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  // Corrispondenza parziale: cognome in comune
  const aParts = a.split(' ');
  const bParts = b.split(' ');
  return aParts.some(ap => ap.length > 3 && bParts.includes(ap));
}

function decodeHtml(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Espone la cache per debug
 */
export function getNewsCache() {
  return Object.fromEntries(
    [...newsCache.entries()].map(([k, v]) => [k, { count: v.data.length, expiresAt: v.expiresAt }])
  );
}
