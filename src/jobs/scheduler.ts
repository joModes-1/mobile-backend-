import cron from 'node-cron';
import { runStaleWashAlerts } from './staleWashAlerts';
import { runPurgeTokens } from './purgeTokens';
import { runExpireCredits } from './expireCredits';
import { runNightlySummary } from './nightlySummary';
import { dispatchOverdue } from '@/modules/dispatch';
import { getPool } from '@/db';

export function startJobs(): void {
  // Every 15 minutes — stale wash alerts
  cron.schedule('*/15 * * * *', async () => {
    console.log('[CRON] Running staleWashAlerts...');
    await runStaleWashAlerts();
  });

  // Nightly at 2am — purge old tokens
  cron.schedule('0 2 * * *', async () => {
    console.log('[CRON] Running purgeTokens...');
    await runPurgeTokens();
  });

  // Nightly at 3am — expire credits
  cron.schedule('0 3 * * *', async () => {
    console.log('[CRON] Running expireCredits...');
    await runExpireCredits();
  });

  // Daily at 6am — nightly summary
  cron.schedule('0 6 * * *', async () => {
    console.log('[CRON] Running nightlySummary...');
    await runNightlySummary();
  });

  // Every 5 seconds — give jobs whose accept window has passed to a worker,
  // and alert managers about jobs nobody on site can take. Accept windows
  // are measured in seconds, so this can't sit on a minute-level cron.
  // The polling screens also run it on demand; this covers the case where
  // nobody happens to be looking.
  let dispatching = false;
  setInterval(async () => {
    if (dispatching) return;
    dispatching = true;
    try {
      await dispatchOverdue(getPool());
    } catch (err: any) {
      console.error('[JOB] dispatchOverdue failed:', err?.message);
    } finally {
      dispatching = false;
    }
  }, 5000);

  console.log('[CRON] All jobs scheduled');
}
