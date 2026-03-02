import axios from 'axios';
import { logger } from '../index.js';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/119.0.0.0 Safari/537.36',
];
let uaIdx = 0;
const nextUA = () => USER_AGENTS[uaIdx++ % USER_AGENTS.length];
const sleep  = ms => new Promise(r => setTimeout(r, ms));

export async function fetchHTML(url, opts = {}) {
  const { retries = 3, delayMs = 1500, headers = {} } = opts;
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await axios.get(url, {
        timeout: 15000,
        headers: { 'User-Agent': nextUA(), 'Accept-Language': 'it-IT,it;q=0.9', 'Referer': 'https://www.google.com/', ...headers },
      });
      return res.data;
    } catch (err) {
      logger.warn(`fetchHTML attempt ${i}/${retries} failed: ${url} — ${err.message}`);
      if (i === retries) throw err;
      await sleep(delayMs * i);
    }
  }
}

export async function fetchJSON(url, opts = {}) {
  const { retries = 3, delayMs = 1000, headers = {} } = opts;
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': nextUA(), 'Accept': 'application/json', ...headers } });
      return res.data;
    } catch (err) {
      logger.warn(`fetchJSON attempt ${i}/${retries} failed: ${url} — ${err.message}`);
      if (i === retries) throw err;
      await sleep(delayMs * i);
    }
  }
}
