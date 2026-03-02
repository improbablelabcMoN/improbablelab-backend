import { Router } from 'express';
import { scrapeLineups } from '../scrapers/sosfanta.js';
import { cached } from '../cache/manager.js';

const router = Router();

router.get('/', async (req, res) => {
  const { league = 'serie_a' } = req.query;
  try {
    const data = await cached('news', `news_${league}`, () => scrapeLineups());
    res.json({ league, count: data.length, news: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
