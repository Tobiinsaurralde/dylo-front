require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./db');

async function run() {
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir)
    .filter((f) => f.match(/^\d+_.*\.sql$/))
    .sort();

  for (const file of files) {
    const p = path.join(dir, file);
    const sql = fs.readFileSync(p, 'utf8');
    console.log('Running migration', file);
    try {
      // Run as a single batch; keep idempotence inside SQL
      await pool.query(sql);
    } catch (e) {
      console.error('Migration failed for', file, e.message);
      process.exitCode = 1;
      break;
    }
  }
  await pool.end();
}

run();

