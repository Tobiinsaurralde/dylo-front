// server.js
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const bodyParser = require('body-parser');
const pool = require('./db');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(helmet());
app.use(bodyParser.json({ limit: '50kb' }));
// Basic CORS (frontend <> backend)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, x-api-key');
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const PORT = process.env.PORT || 3000;
const READERS_KEY = process.env.READER_API_KEY;
// In-memory configuración por lector (temporal, por instancia)
const checkoutConfig = new Map(); // key: reader_name, value: { monto, producto, expiresAt }
const autoPairConfig = new Map(); // key: reader_name, value: { hijo_id, expiresAt }

// helper to normalize uid
function normalizeUid(uid) {
  if (!uid) return uid;
  return uid.toString().replace(/[:\s-]/g, '').toUpperCase();
}

// simple auth middleware for readers (header x-api-key)
function authReader(req, res, next) {
  const k = req.header('x-api-key');
  if (!k || k !== READERS_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}

/*
Payload esperado:
{
  client_tx_id: "uuid",   // obligatorio (idempotencia)
  uid: "04A2BC7F91",      // obligatorio
  reader_name: "cantina-1",
  producto: "alfajor",
  monto: 150.00
}
*/

app.post('/api/scan', authReader, async (req, res) => {
  let { client_tx_id, uid, reader_name, producto, monto } = req.body || {};
  if (!client_tx_id || !uid) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  // Si no viene monto, intentar usar configuración previa del lector
  if ((monto === undefined || monto === null) && reader_name) {
    const cfg = checkoutConfig.get(reader_name);
    if (cfg && cfg.expiresAt > Date.now()) {
      monto = cfg.monto;
      producto = producto || cfg.producto || 'consumo';
      // Consumir una vez
      checkoutConfig.delete(reader_name);
    }
  }
  if (monto === undefined || monto === null) {
    return res.status(400).json({ error: 'missing_monto' });
  }

  const codigo_nfc = normalizeUid(uid);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) buscar pulsera activa por codigo_nfc
    let pulRes = await client.query(
      'SELECT id, hijo_id FROM pulseras WHERE codigo_nfc = $1 AND activa = true',
      [codigo_nfc]
    );
    if (pulRes.rowCount === 0) {
      // Intentar autoparear si hay configuración para este reader
      if (reader_name) {
        const ap = autoPairConfig.get(reader_name);
        if (ap && ap.expiresAt > Date.now()) {
          // Validar que el UID no esté en uso por otro alumno
          const lock = await client.query('SELECT id, hijo_id, activa FROM pulseras WHERE codigo_nfc = $1 FOR UPDATE', [codigo_nfc]);
          if (lock.rowCount > 0 && lock.rows[0].hijo_id !== ap.hijo_id) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'uid_en_uso_por_otro_alumno' });
          }
          // Desactivar cualquier pulsera activa previa del alumno
          await client.query('UPDATE pulseras SET activa = false WHERE hijo_id = $1 AND activa = true AND codigo_nfc <> $2', [ap.hijo_id, codigo_nfc]);
          // Crear (o reactivar) pulsera para el alumno
          let newPulseraId;
          if (lock.rowCount > 0) {
            // Reactivar existente del mismo alumno
            const upd = await client.query('UPDATE pulseras SET activa = true WHERE id = $1 RETURNING id, hijo_id', [lock.rows[0].id]);
            newPulseraId = upd.rows[0].id;
          } else {
            const ins = await client.query('INSERT INTO pulseras (hijo_id, codigo_nfc, activa) VALUES ($1, $2, true) RETURNING id, hijo_id', [ap.hijo_id, codigo_nfc]);
            newPulseraId = ins.rows[0].id;
          }
          // Consumir config de autopair (una sola vez)
          autoPairConfig.delete(reader_name);
          // Reconsultar pulsera activa
          pulRes = await client.query('SELECT id, hijo_id FROM pulseras WHERE codigo_nfc = $1 AND activa = true', [codigo_nfc]);
        }
      }
      if (pulRes.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'pulsera_no_registrada' });
      }
    }
    const pul = pulRes.rows[0];

    // 2) idempotencia: si ya existe client_tx_id
    const txExist = await client.query('SELECT * FROM transacciones WHERE client_tx_id = $1', [client_tx_id]);
    if (txExist.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.json({ ok: true, already_processed: true, transaccion: txExist.rows[0] });
    }

    // 3) SELECT FOR UPDATE para bloquear el saldo del hijo
    const hijoRes = await client.query('SELECT id, saldo FROM hijos WHERE id = $1 FOR UPDATE', [pul.hijo_id]);
    if (hijoRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'hijo_no_encontrado' });
    }
    const hijo = hijoRes.rows[0];

    if (Number(hijo.saldo) < Number(monto)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'saldo_insuficiente', saldo_actual: hijo.saldo });
    }

    const nuevoSaldo = Number(hijo.saldo) - Number(monto);
    await client.query('UPDATE hijos SET saldo = $1 WHERE id = $2', [nuevoSaldo, hijo.id]);

    // 4) insertar transaccion
    const insert = await client.query(
      `INSERT INTO transacciones (client_tx_id, hijo_id, pulsera_id, monto, producto, reader_name)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [client_tx_id, hijo.id, pul.id, monto, producto || null, reader_name || null]
    );

    await client.query('COMMIT');

    // opcional: insertar notificacion para worker que mande WhatsApp
    try {
      await pool.query('INSERT INTO notificaciones (transaccion_id, payload) VALUES ($1, $2)', [
        insert.rows[0].id,
        JSON.stringify({ message: `Gastaste $${monto}`, tipo: 'compra' })
      ]);
    } catch (e) {
      // no bloquear por error de notificación
      console.error('No se pudo encolar notificación', e.message);
    }

    return res.json({ ok: true, transaccion: insert.rows[0], nuevo_saldo: nuevoSaldo });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error /api/scan', err);
    return res.status(500).json({ error: 'internal_error' });
  } finally {
    client.release();
  }
});

// --- Pulseras: consultar, vincular, desvincular ---
app.get('/api/hijos/:id/pulsera', async (req, res) => {
  const hijoId = Number(req.params.id);
  if (!hijoId) return res.status(400).json({ error: 'invalid_hijo_id' });

  try {
    const r = await pool.query(
      'SELECT id, codigo_nfc, activa FROM pulseras WHERE hijo_id = $1 AND activa = true',
      [hijoId]
    );
    if (r.rowCount === 0) return res.json({ pulsera: null });
    return res.json({ pulsera: r.rows[0] });
  } catch (e) {
    console.error('GET /api/hijos/:id/pulsera', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

app.post('/api/hijos/:id/pulsera', async (req, res) => {
  const hijoId = Number(req.params.id);
  const { uid } = req.body || {};
  if (!hijoId || !uid) return res.status(400).json({ error: 'missing_fields' });

  const codigo_nfc = normalizeUid(uid);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const exist = await client.query(
      'SELECT id, hijo_id, activa FROM pulseras WHERE codigo_nfc = $1 FOR UPDATE',
      [codigo_nfc]
    );
    if (exist.rowCount > 0 && exist.rows[0].hijo_id !== hijoId) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'uid_en_uso_por_otro_alumno' });
    }

    await client.query(
      'UPDATE pulseras SET activa = false WHERE hijo_id = $1 AND activa = true AND codigo_nfc <> $2',
      [hijoId, codigo_nfc]
    );

    let pulsera;
    if (exist.rowCount > 0) {
      const upd = await client.query(
        'UPDATE pulseras SET activa = true, hijo_id = $1 WHERE id = $2 RETURNING *',
        [hijoId, exist.rows[0].id]
      );
      pulsera = upd.rows[0];
    } else {
      const ins = await client.query(
        'INSERT INTO pulseras (hijo_id, codigo_nfc, activa) VALUES ($1, $2, true) RETURNING *',
        [hijoId, codigo_nfc]
      );
      pulsera = ins.rows[0];
    }

    await client.query('COMMIT');
    return res.json({ ok: true, pulsera });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST /api/hijos/:id/pulsera', e);
    return res.status(500).json({ error: 'internal_error' });
  } finally {
    client.release();
  }
});

app.delete('/api/hijos/:id/pulsera', async (req, res) => {
  const hijoId = Number(req.params.id);
  if (!hijoId) return res.status(400).json({ error: 'invalid_hijo_id' });

  try {
    const r = await pool.query(
      'UPDATE pulseras SET activa = false WHERE hijo_id = $1 AND activa = true RETURNING *',
      [hijoId]
    );
    return res.json({ ok: true, desactivadas: r.rowCount });
  } catch (e) {
    console.error('DELETE /api/hijos/:id/pulsera', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/api/pulseras', async (req, res) => {
  const uid = req.query.uid;
  if (!uid) return res.status(400).json({ error: 'missing_uid' });
  const codigo_nfc = normalizeUid(uid);
  try {
    const r = await pool.query(
      'SELECT id, hijo_id, codigo_nfc, activa FROM pulseras WHERE codigo_nfc = $1',
      [codigo_nfc]
    );
    return res.json({ pulsera: r.rows[0] || null });
  } catch (e) {
    console.error('GET /api/pulseras', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// --- Pairing por escaneo ---
function randomCode(n = 6) {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
  return s;
}

app.post('/api/pairings', async (req, res) => {
  const { hijo_id, ttl_seconds } = req.body || {};
  const hijoId = Number(hijo_id);
  if (!hijoId) return res.status(400).json({ error: 'missing_hijo_id' });
  const ttl = Math.min(Math.max(Number(ttl_seconds) || 60, 10), 300); // 10s..5m

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const expiresAt = new Date(Date.now() + ttl * 1000);
    let code = randomCode(6);
    // asegurar unicidad simple
    for (let i = 0; i < 5; i++) {
      const chk = await client.query('SELECT 1 FROM pairings WHERE code = $1', [code]);
      if (chk.rowCount === 0) break;
      code = randomCode(6);
    }
    const ins = await client.query(
      'INSERT INTO pairings (code, hijo_id, expires_at) VALUES ($1,$2,$3) RETURNING code, expires_at',
      [code, hijoId, expiresAt]
    );
    await client.query('COMMIT');
    return res.json({ ok: true, code: ins.rows[0].code, expires_at: ins.rows[0].expires_at });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST /api/pairings', e);
    return res.status(500).json({ error: 'internal_error' });
  } finally {
    client.release();
  }
});

app.get('/api/pairings/:code', async (req, res) => {
  const code = req.params.code;
  try {
    const r = await pool.query(
      'SELECT code, hijo_id, expires_at, completed_at, pulsera_id FROM pairings WHERE code = $1',
      [code]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    const p = r.rows[0];
    const now = new Date();
    const expired = p.expires_at && new Date(p.expires_at) < now;
    return res.json({
      pairing: {
        code: p.code,
        hijo_id: p.hijo_id,
        expires_at: p.expires_at,
        expired,
        completed: !!p.completed_at,
        pulsera_id: p.pulsera_id || null
      }
    });
  } catch (e) {
    console.error('GET /api/pairings/:code', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Escaneo de lector para completar pairing (no mueve saldo)
app.post('/api/pairings/scan', authReader, async (req, res) => {
  const { uid, code, reader_name } = req.body || {};
  if (!uid || !code) return res.status(400).json({ error: 'missing_fields' });
  const codigo_nfc = normalizeUid(uid);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const now = new Date();
    const pr = await client.query(
      'SELECT * FROM pairings WHERE code = $1 FOR UPDATE',
      [code]
    );
    if (pr.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'pairing_not_found' });
    }
    const pairing = pr.rows[0];
    if (pairing.completed_at) {
      await client.query('ROLLBACK');
      return res.json({ ok: true, already_completed: true });
    }
    if (new Date(pairing.expires_at) < now) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'pairing_expired' });
    }

    // verificar/crear pulsera y vincular al hijo
    const exist = await client.query(
      'SELECT id, hijo_id, activa FROM pulseras WHERE codigo_nfc = $1 FOR UPDATE',
      [codigo_nfc]
    );
    if (exist.rowCount > 0 && exist.rows[0].hijo_id !== pairing.hijo_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'uid_en_uso_por_otro_alumno' });
    }
    await client.query(
      'UPDATE pulseras SET activa = false WHERE hijo_id = $1 AND activa = true AND codigo_nfc <> $2',
      [pairing.hijo_id, codigo_nfc]
    );

    let pulseraId;
    if (exist.rowCount > 0) {
      const upd = await client.query(
        'UPDATE pulseras SET activa = true, hijo_id = $1 WHERE id = $2 RETURNING id',
        [pairing.hijo_id, exist.rows[0].id]
      );
      pulseraId = upd.rows[0].id;
    } else {
      const ins = await client.query(
        'INSERT INTO pulseras (hijo_id, codigo_nfc, activa) VALUES ($1, $2, true) RETURNING id',
        [pairing.hijo_id, codigo_nfc]
      );
      pulseraId = ins.rows[0].id;
    }

    await client.query(
      'UPDATE pairings SET completed_at = $1, pulsera_id = $2 WHERE id = $3',
      [now, pulseraId, pairing.id]
    );

    // auditoría opcional
    try {
      await pool.query('INSERT INTO notificaciones (transaccion_id, payload) VALUES ($1, $2)', [
        null,
        JSON.stringify({ message: `Pulsera vinculada por ${reader_name || 'lector'}`, tipo: 'pairing' })
      ]);
    } catch (e) {
      // no bloquear por error de notificación
      console.error('No se pudo encolar notificación pairing', e.message);
    }

    await client.query('COMMIT');
    return res.json({ ok: true, pulsera_id: pulseraId });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST /api/pairings/scan', e);
    return res.status(500).json({ error: 'internal_error' });
  } finally {
    client.release();
  }
});

// endpoint health check
app.get('/health', (req, res) => res.json({ ok: true }));

// --- Saldo e historial ---
app.get('/api/hijos/:id/saldo', async (req, res) => {
  const hijoId = Number(req.params.id);
  if (!hijoId) return res.status(400).json({ error: 'invalid_hijo_id' });
  try {
    const r = await pool.query('SELECT saldo FROM hijos WHERE id = $1', [hijoId]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'hijo_no_encontrado' });
    return res.json({ hijo_id: hijoId, saldo: r.rows[0].saldo });
  } catch (e) {
    console.error('GET /api/hijos/:id/saldo', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Información básica del alumno
app.get('/api/hijos/:id', async (req, res) => {
  const hijoId = Number(req.params.id);
  if (!hijoId) return res.status(400).json({ error: 'invalid_hijo_id' });
  try {
    const r = await pool.query('SELECT id, nombre, saldo FROM hijos WHERE id = $1', [hijoId]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'hijo_no_encontrado' });
    return res.json({ hijo: r.rows[0] });
  } catch (e) {
    console.error('GET /api/hijos/:id', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/api/hijos/:id/transacciones', async (req, res) => {
  const hijoId = Number(req.params.id);
  if (!hijoId) return res.status(400).json({ error: 'invalid_hijo_id' });
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const { start, end } = req.query;

  const clauses = ['hijo_id = $1'];
  const params = [hijoId];
  let idx = 2;
  if (start) { clauses.push(`created_at >= $${idx++}`); params.push(new Date(start)); }
  if (end) { clauses.push(`created_at <= $${idx++}`); params.push(new Date(end)); }
  params.push(limit, offset);

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  try {
    const sql = `SELECT id, client_tx_id, monto, producto, reader_name, created_at
                 FROM transacciones
                 ${where}
                 ORDER BY created_at DESC
                 LIMIT $${idx++} OFFSET $${idx}`;
    const r = await pool.query(sql, params);
    return res.json({ hijo_id: hijoId, count: r.rowCount, items: r.rows });
  } catch (e) {
    console.error('GET /api/hijos/:id/transacciones', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Recarga de saldo (admin/portal)
app.post('/api/hijos/:id/recarga', async (req, res) => {
  const hijoId = Number(req.params.id);
  const { amount, note, client_tx_id } = req.body || {};
  const monto = Number(amount);
  if (!hijoId || !monto || monto <= 0) return res.status(400).json({ error: 'invalid_amount' });

  const txId = client_tx_id || uuidv4();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // idempotencia: si ya existe client_tx_id
    const txExist = await client.query('SELECT * FROM transacciones WHERE client_tx_id = $1', [txId]);
    if (txExist.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.json({ ok: true, already_processed: true, transaccion: txExist.rows[0] });
    }

    const hijoRes = await client.query('SELECT id, saldo FROM hijos WHERE id = $1 FOR UPDATE', [hijoId]);
    if (hijoRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'hijo_no_encontrado' });
    }

    const nuevoSaldo = Number(hijoRes.rows[0].saldo) + monto;
    await client.query('UPDATE hijos SET saldo = $1 WHERE id = $2', [nuevoSaldo, hijoId]);

    const insert = await client.query(
      `INSERT INTO transacciones (client_tx_id, hijo_id, pulsera_id, monto, producto, reader_name)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [txId, hijoId, null, monto, note || 'recarga', 'portal']
    );

    await client.query('COMMIT');

    try {
      await pool.query('INSERT INTO notificaciones (transaccion_id, payload) VALUES ($1, $2)', [
        insert.rows[0].id,
        JSON.stringify({ message: `Recargaste $${monto}`, tipo: 'recarga' })
      ]);
    } catch (e) {
      console.error('No se pudo encolar notificación recarga', e.message);
    }

    return res.json({ ok: true, transaccion: insert.rows[0], nuevo_saldo: nuevoSaldo });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST /api/hijos/:id/recarga', e);
    return res.status(500).json({ error: 'internal_error' });
  } finally {
    client.release();
  }
});

// Configurar autopareado para el próximo escaneo de un lector
// Seguridad: prototipo sin auth adicional; proteger con sesión/roles en prod
app.post('/api/pairings/auto/config', async (req, res) => {
  try {
    const { reader_name, hijo_id, ttl_ms } = req.body || {};
    if (!reader_name || !hijo_id) return res.status(400).json({ error: 'missing_fields' });
    const ttl = Number(ttl_ms || 60000);
    autoPairConfig.set(reader_name, { hijo_id: Number(hijo_id), expiresAt: Date.now() + ttl });
    return res.json({ ok: true, reader_name, hijo_id: Number(hijo_id) });
  } catch (e) {
    console.error('POST /api/pairings/auto/config', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Configurar cobro para un lector (usado por la sección de cobro en Front)
// Nota: sin autenticación adicional (prototipo). Recomendado proteger con sesión/rol.
app.post('/api/checkout/config', async (req, res) => {
  try {
    const { reader_name, monto, producto, ttl_ms } = req.body || {};
    if (!reader_name || monto === undefined || monto === null) {
      return res.status(400).json({ error: 'missing_fields' });
    }
    const ttl = Number(ttl_ms || 60000);
    const entry = { monto: Number(monto), producto: producto || 'consumo', expiresAt: Date.now() + ttl };
    checkoutConfig.set(reader_name, entry);
    return res.json({ ok: true, reader_name, expires_at: entry.expiresAt });
  } catch (e) {
    console.error('POST /api/checkout/config', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
