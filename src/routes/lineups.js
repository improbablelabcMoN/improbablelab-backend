import { Router } from 'express';
import { cached } from '../cache/manager.js';
import { aggregateLeague } from '../scrapers/aggregator.js';
import { logger } from '../index.js';

const router = Router();
const LEAGUES = ['serie_a','premier_league','la_liga','bundesliga','ligue_1','champions_league'];

router.get('/', async (req, res) => {
  const { league = 'serie_a' } = req.query;
  if (!LEAGUES.includes(league))
    return res.status(400).json({ error: `League '${league}' non supportata`, supported: LEAGUES });
  try {
    const data = await cached('lineups', league, () => aggregateLeague(league));
    res.json({ league, ...data });
  } catch (err) {
    logger.error(`[/lineups] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/sources', (req, res) => res.json({ sources: [
  { id:'sosfanta',     name:'SosFanta',        league:'serie_a',        url:'https://www.sosfanta.com' },
  { id:'fantacalcio',  name:'Fantacalcio.it',   league:'serie_a',        url:'https://www.fantacalcio.it' },
  { id:'fplitalia',    name:'FPL Italia',        league:'premier_league', url:'https://fplitalia.com' },
  { id:'besoccer',     name:'BeSoccer',          league:'multi',          url:'https://lineups.besoccer.com' },
  { id:'fantagazzetta', name:'Fantagazzetta',      league:'serie_a',        url:'https://www.fantagazzetta.com' },
  { id:'apifootball',   name:'API-Football',       league:'multi',          url:'https://api-sports.io' },
]}));

export default router;
