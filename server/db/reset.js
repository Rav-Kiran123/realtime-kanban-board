// `npm run reset-db` -> deletes the SQLite file so the next start re-seeds demo data.
const fs = require('fs');
const config = require('../config');

for (const suffix of ['', '-wal', '-shm']) {
  const file = config.DB_FILE + suffix;
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    console.log('deleted', file);
  }
}
console.log('Database reset. Run `npm start` to create it again with demo data.');
