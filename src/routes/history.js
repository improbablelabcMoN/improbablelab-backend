/**
 * /api/history — Storico formazioni squadre
 * GET /api/history?team=Inter&league=serie_a   → storico completo squadra
 * GET /api/history?league=serie_a              → lista squadre con storico
 * GET /api/history/probs?team=Inter&league=serie_a → probabilità calcolate
 */

import { Router } from 'express';
import { getTeamHistory, getHistoricalProbs, listTeamsWithHistory } from '../scrapers/history.js';
import { logger } from '../index.js';

const router = Router();

// Lista squadre con storico o storico di una squadra specifica
router.get('/', (req, res) => {
  const { team, league = 'serie_a' } = req.query;

  if (!team) {
    // Lista tutte le squadre con storico per il campionato
    const teams = listTeamsWithHistory(league);
    return res.json({ league, teams, count: teams.length });
  }

  try {
    const history = getTeamHistory(team, league);
    res.json(history);
  } catch (err) {
    logger.error(`[/history] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Probabilità calcolate da storico
router.get('/probs', (req, res) => {
  const { team, league = 'serie_a' } = req.query;
  if (!team) return res.status(400).json({ error: 'team richiesto' });

  try {
    const probs = getHistoricalProbs(team, league);
    const sorted = [...probs.entries()]
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => b.prob - a.prob);
    res.json({ team, league, players: sorted, count: sorted.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
