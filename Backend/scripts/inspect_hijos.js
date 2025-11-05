require('dotenv').config();
const pool = require('../db');

(async () => {
  try {
    const r = await pool.query(
      "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'hijos' ORDER BY ordinal_position"
    );
    console.log(r.rows);
  } catch (e) {
    console.error('query_error', e.message);
  } finally {
    await pool.end();
  }
})();

