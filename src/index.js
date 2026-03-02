import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: '*',
}));
app.use(express.json());

// Health check — risponde subito senza dipendenze
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Import routes dinamico per evitare crash all'avvio
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

    console.log('[OK] Routes loaded');
  } catch (err) {
    console.error('[ERROR] Failed to load routes:', err.message);
  }

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 ImprobableLab backend running on port ${PORT}`);
  });
}

startServer();
