require('dotenv').config();
const pool = require('../db');

(async () => {
  try {
    const count = await pool.query('SELECT COUNT(*)::int AS c FROM hijos');
    if (count.rows[0].c > 0) {
      const ex = await pool.query('SELECT id, nombre FROM hijos ORDER BY id LIMIT 1');
      console.log('Existing hijo:', ex.rows[0]);
      return;
    }
    const ins = await pool.query("INSERT INTO hijos (nombre) VALUES ('Alumno Demo') RETURNING id, nombre");
    console.log('Seeded hijo:', ins.rows[0]);
  } catch (e) {
    console.error('seed_error', e.message);
  } finally {
    await pool.end();
  }
})();

