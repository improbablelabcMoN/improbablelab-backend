import { Router } from 'express';

const router = Router();

router.get('/debug', async (req, res) => {
  const { league = 'serie_a' } = req.query;
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) return res.json({ ok: false, error: 'API_FOOTBALL_KEY non settata' });

  const LEAGUE_IDS = { serie_a: 135, premier_league: 39, la_liga: 140, bundesliga: 78, ligue_1: 61, champions_league: 2 };
  const leagueId = LEAGUE_IDS[league] || 135;

  // Chiamata diretta senza cache per vedere la risposta raw
  try {
    const url = `https://v3.football.api-sports.io/fixtures?league=${leagueId}&season=2024&next=5`;
    const resp = await fetch(url, { headers: { 'x-apisports-key': key } });
    const data = await resp.json();

    res.json({
      ok: true,
      url,
      http_status: resp.status,
      api_results: data?.results,
      api_errors: data?.errors,
      api_remaining: resp.headers.get('x-ratelimit-requests-remaining'),
      sample: data?.response?.slice(0,2).map(f => ({
        id: f.fixture?.id,
        home: f.teams?.home?.name,
        away: f.teams?.away?.name,
        date: f.fixture?.date,
      })) || [],
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

router.get('/', (req, res) => res.json({ note: 'Usa /api/stats/debug?league=serie_a' }));
export default router;
