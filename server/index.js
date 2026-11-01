// Entry point: HTTP server (Express) + WebSocket server (Socket.IO) on the SAME port.
const http = require('http');
const { Server } = require('socket.io');
const config = require('./config');
const { initDb } = require('./db/database');
const { seedIfEmpty } = require('./db/seed');
const { createApp } = require('./app');
const { setupSocket } = require('./realtime/socket');
const hub = require('./realtime/hub');

function startServer(port = config.PORT) {
  initDb();
  if (config.SEED_DEMO_DATA && seedIfEmpty()) console.log('[db] empty database -> demo data created');

  const app = createApp();
  const server = http.createServer(app);
  const io = new Server(server, {
    // tune how fast we notice a dead connection (wifi drops etc.)
    pingInterval: 10000,
    pingTimeout: 8000,
  });

  hub.setIo(io);
  setupSocket(io);

  return new Promise((resolve) => {
    server.listen(port, () => resolve({ server, io, port: server.address().port }));
  });
}

// only auto-start when run directly (`node server/index.js`), not when required by tests
if (require.main === module) {
  startServer().then(({ port }) => {
    console.log(`\n  TeamBoard is running ->  http://localhost:${port}\n`);
    console.log('  Demo logins (password: password123):');
    console.log('    alice@acme.test   Org Admin   (Acme Corp - all branches)');
    console.log('    bob@acme.test     Tenant Admin (Acme Hyderabad)');
    console.log('    carol@acme.test   Member      (Acme Hyderabad + Bangalore)');
    console.log('    dan@acme.test     Member      (Acme Bangalore)');
    console.log('    gina@globex.test  Org Admin   (Globex Inc)');
    console.log('    omar@globex.test  Member      (Globex London)\n');
  });
}

module.exports = { startServer };
