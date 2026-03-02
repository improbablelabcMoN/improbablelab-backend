import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createLogger, format, transports } from 'winston';

dotenv.config();

export const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp({ format: 'HH:mm:ss' }),
    format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level}: ${message}`)
  ),
  transports: [new transports.Console()],
});

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:5173',
    /\.vercel\.app$/,
    /\.railway\.app$/,
  ],
}));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
import lineupsRouter   from './routes/lineups.js';
import standingsRouter from './routes/standings.js';
import statsRouter     from './routes/stats.js';
import newsRouter      from './routes/news.js';

app.use('/api/lineups',   lineupsRouter);
app.use('/api/standings', standingsRouter);
app.use('/api/stats',     statsRouter);
app.use('/api/news',      newsRouter);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  logger.info(`🚀 Backend running on port ${PORT}`);
});
