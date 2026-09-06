import cron from 'node-cron';
import { runStaleWashAlerts } from './staleWashAlerts';
import { runPurgeTokens } from './purgeTokens';
import { runExpireCredits } from './expireCredits';
import { runNightlySummary } from './nightlySummary';

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

  console.log('[CRON] All jobs scheduled');
}
