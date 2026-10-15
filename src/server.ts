import app, { logger } from '@/app';
import { getEnv } from '@/config';
import { startJobs } from '@/jobs/scheduler';

const env = getEnv();

// Default to 0.0.0.0 so phones on the same Wi-Fi can reach the API in
// development — binding to localhost would make it unreachable from any other
// device. On a server that sits behind nginx, set HOST=127.0.0.1 so the only
// way in is through the proxy and its HTTPS, not the raw port.
const host = process.env.HOST || '0.0.0.0';
const server = app.listen(env.PORT, host, () => {
  logger.info(`Car Wash API running on ${host}:${env.PORT}`);

  // Print the LAN address so a device can be pointed at it without guesswork.
  // Pointless (and misleading) when bound to loopback only.
  if (host === '0.0.0.0') try {
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
