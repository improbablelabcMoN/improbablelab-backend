import { Router } from 'express';
import { cached } from '../cache/manager.js';
import { fetchJSON } from '../scrapers/http.js';
import { logger } from '../index.js';

const router = Router();
const LEAGUE_IDS = { serie_a:135, premier_league:39, la_liga:140, bundesliga:78, ligue_1:61, champions_league:2 };
const SEASON = 2025;

router.get('/', async (req, res) => {
  const { league = 'serie_a' } = req.query;
  const leagueId = LEAGUE_IDS[league];
  if (!leagueId) return res.status(400).json({ error: `League '${league}' non supportata` });

  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) return res.json({ league, source: 'static', note: 'Aggiungi API_FOOTBALL_KEY per dati live', standings: [] });

  try {
    const data = await cached('standings', `${league}_${SEASON}`, async () => {
      const result = await fetchJSON(
        `https://v3.football.api-sports.io/standings?league=${leagueId}&season=${SEASON}`,
        { headers: { 'x-apisports-key': apiKey } }
      );
      return result.response[0].league.standings[0].map(t => ({
        rank: t.rank, team: t.team.name, abbr: t.team.name.slice(0,3).toUpperCase(),
        played: t.all.played, wins: t.all.win, draws: t.all.draw, losses: t.all.lose,
        gf: t.all.goals.for, ga: t.all.goals.against, gd: t.goalsDiff,
        points: t.points, form: t.form || '',
      }));
    });
    res.json({ league, season: SEASON, source: 'api-football', standings: data });
  } catch (err) {
    logger.error(`[/standings] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

export default router;
