import { Router } from 'express';
import { findFixture, getPlayerStats, listFixtures } from '../scrapers/apifootball.js';

const router = Router();

router.get('/debug', async (req, res) => {
  const { league = 'serie_a', home, away } = req.query;
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) return res.json({ ok: false, error: 'API_FOOTBALL_KEY non settata' });

  const LEAGUE_IDS = { serie_a: 135, premier_league: 39, la_liga: 140, bundesliga: 78, ligue_1: 61, champions_league: 2 };
  const leagueId = LEAGUE_IDS[league];

  try {
    // Mostra tutte le fixture disponibili nel cache
    const fixtures = await listFixtures(league);

    if (!home || !away) {
      return res.json({ ok: true, key_present: true, available_fixtures: fixtures, total: fixtures.length });
    }

    const fx = await findFixture(league, home, away);
    if (!fx) return res.json({ ok: false, error: `Fixture non trovata per ${home} vs ${away}`, available_fixtures: fixtures, key_present: true });

    const statsMap = await getPlayerStats(fx.homeTeamId, leagueId);
    const players = [...statsMap.entries()].slice(0, 5).map(([k, v]) => ({ key: k, ...v }));

    res.json({ ok: true, fixture: fx, sample_players: players, total_players: statsMap.size });
  } catch (err) {
    res.json({ ok: false, error: err.message, stack: err.stack?.slice(0,300) });
  }
});

router.get('/', (req, res) => res.json({ note: 'Usa /api/stats/debug?league=serie_a per vedere fixture disponibili' }));
export default router;
