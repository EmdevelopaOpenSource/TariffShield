import {
  expireDueCreditLines,
  notifyExpiringCreditLines,
} from '../services/credit-lines.js';
import { logger } from '../lib/logger.js';

/**
 * Hourly credit-line lifecycle monitor (#1007):
 *  1. warns importers whose credit line expires within 48h (once), then
 *  2. expires credit lines whose window has passed so collateral health
 *     checks revert to the strict requirement.
 */
export function startCreditLineMonitor(): void {
  const INTERVAL_MS = 60 * 60 * 1000;

  async function tick(): Promise<void> {
    try {
      await notifyExpiringCreditLines();
      await expireDueCreditLines();
    } catch (err) {
      logger.error({ err }, 'credit line monitor run failed');
    }
  }

  tick();
  setInterval(tick, INTERVAL_MS);
}
