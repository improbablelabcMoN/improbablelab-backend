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
```

---

Hai **10 file** da creare su GitHub nel repo `improbablelab-backend`. La struttura è:
```
package.json
railway.toml
src/
  index.js
  cache/manager.js
  scrapers/http.js
  scrapers/besoccer.js
  scrapers/sosfanta.js
  scrapers/fantacalcio.js
  scrapers/fplitalia.js
  scrapers/aggregator.js
  routes/lineups.js
  routes/standings.js
  routes/stats.js
  routes/news.js
