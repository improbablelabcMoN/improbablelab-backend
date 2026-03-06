import { Router } from 'express';
import { findFixture, getPlayerStats } from '../scrapers/apifootball.js';

const router = Router();

// Debug endpoint: testa API-Football key e restituisce stat giocatori
// GET /api/stats/debug?league=serie_a&home=Inter&away=Milan
router.get('/debug', async (req, res) => {
  const { league = 'serie_a', home = 'Inter', away = 'AC Milan' } = req.query;

  const key = process.env.API_FOOTBALL_KEY;
  if (!key) return res.json({ ok: false, error: 'API_FOOTBALL_KEY non settata' });

  try {
    // 1. Trova fixture e teamId
    const fx = await findFixture(league, home, away);
    if (!fx) return res.json({ ok: false, error: `Fixture non trovata per ${home} vs ${away} in ${league}`, key_present: true });

    // 2. Scarica stats giocatori squadra home
    const LEAGUE_IDS = { serie_a: 135, premier_league: 39, la_liga: 140, bundesliga: 78, ligue_1: 61, champions_league: 2 };
    const leagueId = LEAGUE_IDS[league];
    const statsMap = await getPlayerStats(fx.homeTeamId, leagueId);

    const players = [...statsMap.entries()].slice(0, 5).map(([k, v]) => ({ key: k, ...v }));

    res.json({
      ok: true,
      key_present: true,
      fixture: { id: fx.fixtureId, homeTeamId: fx.homeTeamId, awayTeamId: fx.awayTeamId },
      sample_players: players,
      total_players: statsMap.size,
    });
  } catch (err) {
    res.json({ ok: false, error: err.message, key_present: true });
  }
});

router.get('/', (req, res) => res.json({ note: 'Usa /api/stats/debug?league=serie_a&home=Inter&away=Milan per testare' }));

export default router;
