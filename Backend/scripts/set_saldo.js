require('dotenv').config();
const pool = require('../db');

const hijoId = Number(process.argv[2] || 1);
const saldo = Number(process.argv[3] || 10000);

(async () => {
  try {
    const r = await pool.query('UPDATE hijos SET saldo = $1 WHERE id = $2 RETURNING id, saldo', [saldo, hijoId]);
    if (r.rowCount === 0) {
      console.error('No se encontró el hijo con id', hijoId);
    } else {
      console.log('Saldo actualizado', r.rows[0]);
    }
  } catch (e) {
    console.error('set_saldo_error', e.message);
  } finally {
    await pool.end();
  }
})();

