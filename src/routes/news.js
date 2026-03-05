/**
 * /api/news — Notizie infortuni/squalifiche per squadra (L3)
 */
import { Router } from 'express';
import { fetchTeamNews, getNewsCache } from '../scrapers/news.js';
import { getDaysSinceLastMatch }       from '../scrapers/context.js';

const router = Router();

// GET /api/news?team=Milan&league=serie_a
router.get('/', async (req, res) => {
  const { team, league = 'serie_a' } = req.query;
  if (!team) return res.status(400).json({ error: 'Missing team param' });

  try {
    const news           = await fetchTeamNews(team, league);
    const daysSinceLast  = getDaysSinceLastMatch(team, league);
    res.json({ team, league, count: news.length, news, daysSinceLast });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/news/cache — debug cache status
router.get('/cache', (req, res) => {
  res.json(getNewsCache());
});

export default router;
