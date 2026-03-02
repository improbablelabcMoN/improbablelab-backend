import { Router } from 'express';
const router = Router();
router.get('/', (req, res) => res.json({ note: 'Stats endpoint — configura API_FOOTBALL_KEY', stats: [] }));
export default router;
