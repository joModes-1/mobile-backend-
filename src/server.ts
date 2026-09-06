import app, { logger } from '@/app';
import { getEnv } from '@/config';
import { startJobs } from '@/jobs/scheduler';

const env = getEnv();

// Bind 0.0.0.0 explicitly so phones on the same Wi-Fi can reach the API —
// binding to localhost would make it unreachable from any other device.
const server = app.listen(env.PORT, '0.0.0.0', () => {
  logger.info(`Car Wash API running on port ${env.PORT}`);

  // Print the LAN address so a device can be pointed at it without guesswork.
  try {
    const nets = require('os').networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) {
          logger.info(`  reachable on your network at http://${net.address}:${env.PORT}/api/v1`);
        }
      }
    }
  } catch {}

  // Start background jobs
  startJobs();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down...');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down...');
  server.close(() => process.exit(0));
});
