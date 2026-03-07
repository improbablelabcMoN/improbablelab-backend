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
  const LEAGUE_IDS = { serie_a:135, premier_league:39, la_liga:140, bundesliga:78, ligue_1:61, champions_league:2 };
  try {
    const from = new Date(Date.now() - 7*86400000).toISOString().slice(0,10);
    const to   = new Date(Date.now() + 30*86400000).toISOString().slice(0,10);
    const results = {};
    for (const [name, id] of Object.entries(LEAGUE_IDS)) {
      const url = `https://v3.football.api-sports.io/fixtures?league=${id}&season=2025&from=${from}&to=${to}`;
      const d = await fetch(url, { headers: { 'x-apisports-key': key } }).then(r=>r.json());
      results[name] = { count: d.results, errors: d.errors, sample: d.response?.slice(0,1).map(f=>({ date: f.fixture?.date?.slice(0,10), home: f.teams?.home?.name, away: f.teams?.away?.name, elapsed: f.fixture?.status?.elapsed })) };
    }
    res.json({ keyUsed: key.slice(0,6)+'...', results });
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
