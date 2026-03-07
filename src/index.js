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

// Debug temporaneo: forza refetch CL e mostra risultato
app.get('/debug/cl', async (req, res) => {
  try {
    const mod = await import('./routes/besoccer.js');
    const matches = await mod.scrapeLineups('champions_league');
    const byStatus = matches.reduce((acc, m) => {
      acc[m.staticStatus] = (acc[m.staticStatus] || 0) + 1;
      return acc;
    }, {});
    const scheduled = matches.filter(m => m.staticStatus === 'scheduled');
    res.json({
      total: matches.length,
      byStatus,
      scheduledSample: scheduled.slice(0, 5).map(m => ({ home: m.home, away: m.away, date: m.date, round: m.round })),
      allSample: matches.slice(0, 3).map(m => ({ home: m.home, away: m.away, date: m.date, staticStatus: m.staticStatus })),
    });
  } catch(e) { res.status(500).json({ error: e.message, stack: e.stack?.slice(0,300) }); }
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
