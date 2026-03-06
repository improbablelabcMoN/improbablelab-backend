import { Router } from 'express';

const router = Router();

router.get('/debug', async (req, res) => {
  const { league = 'serie_a' } = req.query;
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) return res.json({ ok: false, error: 'API_FOOTBALL_KEY non settata' });

  const leagueId = 135;

  // Prova entrambi gli endpoint: diretto e RapidAPI
  const tests = [
    {
      name: 'api-sports diretto',
      url: `https://v3.football.api-sports.io/fixtures?league=${leagueId}&season=2024&next=5`,
      headers: { 'x-apisports-key': key },
    },
    {
      name: 'RapidAPI',
      url: `https://api-football-v1.p.rapidapi.com/v3/fixtures?league=${leagueId}&season=2024&next=5`,
      headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': 'api-football-v1.p.rapidapi.com' },
    },
  ];

  const results = [];
  for (const t of tests) {
    try {
      const resp = await fetch(t.url, { headers: t.headers });
      const data = await resp.json();
      results.push({
        name: t.name,
        status: resp.status,
        results: data?.results,
        errors: data?.errors,
        sample: data?.response?.slice(0,1).map(f => ({ home: f.teams?.home?.name, away: f.teams?.away?.name })) || [],
      });
    } catch (err) {
      results.push({ name: t.name, error: err.message });
    }
  }

  res.json({ key_length: key.length, key_prefix: key.slice(0,6)+'...', results });
});

router.get('/', (req, res) => res.json({ note: 'Usa /api/stats/debug' }));
export default router;
