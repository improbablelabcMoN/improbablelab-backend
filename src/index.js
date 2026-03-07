import express from 'express';
import cors from 'cors';
import { createLogger, format, transports } from 'winston';

const PORT = process.env.PORT || 8080;
const app  = express();

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

export const logger = createLogger({
  level: 'info',
  format: format.combine(format.timestamp({ format: 'MMM D YYYY HH:mm:ss' }), format.printf(({ level, message, timestamp }) => `[${level.toUpperCase()}]  ${message}`)),
  transports: [new transports.Console()],
});

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
    // Test senza season per vedere se restituisce dati
    const url1 = `https://v3.football.api-sports.io/fixtures?league=39&from=${today}&to=${to}`;
    // Test con season
    const url2 = `https://v3.football.api-sports.io/fixtures?league=39&season=2025&next=5`;
    const url3 = `https://v3.football.api-sports.io/fixtures?league=39&season=2025&next=5`;
    const [r1, r2, r3] = await Promise.all([
      fetch(url1, { headers: { 'x-apisports-key': key } }).then(r=>r.json()),
      fetch(url2, { headers: { 'x-apisports-key': key } }).then(r=>r.json()),
      fetch(url3, { headers: { 'x-apisports-key': key } }).then(r=>r.json()),
    ]);
    res.json({
      withoutSeason: { results: r1.results, errors: r1.errors, sample: r1.response?.slice(0,1).map(f=>({ date: f.fixture?.date, home: f.teams?.home?.name, away: f.teams?.away?.name })) },
      withSeason2024: { results: r2.results, errors: r2.errors },
      withSeason2025: { results: r3.results, errors: r3.errors, sample: r3.response?.slice(0,1).map(f=>({ date: f.fixture?.date, home: f.teams?.home?.name, away: f.teams?.away?.name })) },
      keyUsed: key.slice(0,6)+'...',
    });
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
    const { default: fixturesRouter }  = await import('./routes/fixtures.js');

    app.use('/api/lineups',   lineupsRouter);
    app.use('/api/standings', standingsRouter);
    app.use('/api/stats',     statsRouter);
    app.use('/api/news',      newsRouter);
    app.use('/api/analysis',  analysisRouter);
    app.use('/api/social',    socialRouter);
    app.use('/api/fixtures',  fixturesRouter);

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
