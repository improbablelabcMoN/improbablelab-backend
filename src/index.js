import express from 'express';
import cors from 'cors';
import { createLogger, format, transports } from 'winston';

const PORT = process.env.PORT || 8080;
const app  = express();

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

export const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp({ format: 'MMM D YYYY HH:mm:ss' }),
    format.printf(({ level, message }) => `[${level.toUpperCase()}]  ${message}`)
  ),
  transports: [new transports.Console()],
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
