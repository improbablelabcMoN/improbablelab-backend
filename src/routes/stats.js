import { Router } from 'express';

const router = Router();

router.get('/debug', async (req, res) => {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) return res.json({ ok: false, error: 'API_FOOTBALL_KEY non settata' });

  try {
    const url = 'https://api-football-v1.p.rapidapi.com/v3/fixtures?league=135&season=2024&next=5';
    const resp = await fetch(url, {
      headers: {
        'x-rapidapi-key': key,
        'x-rapidapi-host': 'api-football-v1.p.rapidapi.com',
      }
    });
    const data = await resp.json();
    res.json({
      ok: resp.status === 200,
      status: resp.status,
      results: data?.results,
      errors: data?.errors,
      sample: data?.response?.slice(0,3).map(f => ({
        home: f.teams?.home?.name,
        away: f.teams?.away?.name,
        date: f.fixture?.date?.slice(0,10),
      })) || [],
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

router.get('/', (req, res) => res.json({ note: 'Usa /api/stats/debug' }));
export default router;
