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

async function startServer() {
  try {
    const { default: lineupsRouter }   = await import('./routes/lineups.js');
    const { default: standingsRouter } = await import('./routes/standings.js');
    const { default: statsRouter }     = await import('./routes/stats.js');
    const { default: newsRouter }      = await import('./routes/news.js');

    app.use('/api/lineups',   lineupsRouter);
    app.use('/api/standings', standingsRouter);
    app.use('/api/stats',     statsRouter);
    app.use('/api/news',      newsRouter);

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
