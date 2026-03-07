import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

export const logger = {
  info:  (msg) => console.log(`[INFO]  ${msg}`),
  warn:  (msg) => console.warn(`[WARN]  ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`),
};

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Debug temporaneo: testa API-Football direttamente
app.get('/debug/apifootball', async (req, res) => {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) return res.status(500).json({ error: 'API_FOOTBALL_KEY not set' });
  try {
    const today = new Date().toISOString().slice(0, 10);
    const to    = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const url   = `https://v3.football.api-sports.io/fixtures?league=39&season=2024&from=${today}&to=${to}`;
    const r = await fetch(url, { headers: { 'x-apisports-key': key } });
    const d = await r.json();
    res.json({ status: r.status, results: d.results, errors: d.errors, keyUsed: key.slice(0,6)+'...', sample: d.response?.slice(0,2).map(f=>({ date: f.fixture?.date, home: f.teams?.home?.name, away: f.teams?.away?.name })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

async function startServer() {
  try {
    const { default: lineupsRouter }   = await import('./routes/lineups.js');
    const { default: standingsRouter } = await import('./routes/standings.js');
    const { default: statsRouter }     = await import('./routes/stats.js');
    const { default: newsRouter }      = await import('./routes/news.js');
    const { default: analysisRouter }  = await import('./routes/analysis.js');
    const { default: socialRouter }    = await import('./routes/social.js');

    app.use('/api/lineups',   lineupsRouter);
    app.use('/api/standings', standingsRouter);
    app.use('/api/stats',     statsRouter);
    app.use('/api/news',      newsRouter);
    app.use('/api/analysis',  analysisRouter);
    app.use('/api/social',    socialRouter);

    logger.info('Routes loaded OK');
  } catch (err) {
    logger.error(`Failed to load routes: ${err.message}`);
  }

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`🚀 Backend running on port ${PORT}`);
  });
}

startServer();
