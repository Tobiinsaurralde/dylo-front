// reader.js
require('dotenv').config();

const { NFC } = require('nfc-pcsc');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const SERVER_URL = process.env.SERVER_URL; // http://localhost:3001/api/scan
const API_KEY = process.env.READER_API_KEY;
const RETRY_INTERVAL_MS = Number(process.env.RETRY_INTERVAL_MS || 8000);
const READER_NAME = process.env.READER_NAME || null; // e.g. "pos1"
const DEFAULT_PRODUCT = process.env.DEFAULT_PRODUCT || 'consumo';
const DEFAULT_AMOUNT = Number(process.env.DEFAULT_AMOUNT || 150.0);

if (!SERVER_URL || !API_KEY) {
  console.error('ERROR: falta SERVER_URL o READER_API_KEY en .env');
  process.exit(1);
}

const QUEUE_DIR = path.join(__dirname, 'queue');
if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR);

function normalizeUid(uid) {
  return uid.toString().replace(/[:\s-]/g, '').toUpperCase();
}

// enviar al backend o encolar
async function sendPayload(payload) {
  try {
    const resp = await axios.post(SERVER_URL, payload, {
      headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
      timeout: 5000
    });
    console.log('Envío exitoso:', payload.client_tx_id, '→', resp.data);
    return true;
  } catch (err) {
    const status = err?.response?.status;
    const body = err?.response?.data;
    console.warn('Fallo envío:', status, body || err.message || err.toString());
    // escribir en cola
    const filename = path.join(QUEUE_DIR, `${payload.client_tx_id}.json`);
    fs.writeFileSync(filename, JSON.stringify(payload));
    return false;
  }
}

// reintentos sobre cola en disco
async function retryQueue() {
  const files = fs.readdirSync(QUEUE_DIR);
  for (const f of files) {
    try {
      const p = path.join(QUEUE_DIR, f);
      const data = JSON.parse(fs.readFileSync(p));
      const resp = await axios.post(SERVER_URL, data, {
        headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
        timeout: 5000
      });
      fs.unlinkSync(p);
      console.log('Reenvío exitoso cola:', f, '→', resp.data);
    } catch (e) {
      // dejar para el siguiente intento
    }
  }
}

setInterval(() => {
  retryQueue().catch(e => console.error('Error retryQueue', e));
}, RETRY_INTERVAL_MS);

// NFC reader
const nfc = new NFC();

nfc.on('reader', reader => {
  console.log(`Lector conectado: ${reader.reader.name}`);

  // debounce: ignorar lecturas repetidas en X ms
  let lastUid = null;
  let lastTime = 0;
  const DEBOUNCE_MS = 800;

  reader.on('card', async card => {
    try {
      const raw = card.uid || card.uidString || card;
      const uid = normalizeUid(raw);
      const now = Date.now();
      if (uid === lastUid && now - lastTime < DEBOUNCE_MS) {
        console.log('Lectura duplicada ignorada', uid);
        return;
      }
      lastUid = uid;
      lastTime = now;

      const client_tx_id = uuidv4();
      const payload = {
        client_tx_id,
        uid,
        reader_name: READER_NAME || reader.reader.name,
        producto: DEFAULT_PRODUCT,
        monto: DEFAULT_AMOUNT
      };

      console.log('Leído UID:', uid, '→ Enviando', client_tx_id, payload);
      await sendPayload(payload);
    } catch (err) {
      console.error('Error procesando tarjeta:', err);
    }
  });

  reader.on('error', err => {
    console.error('Error lector', err);
  });

  reader.on('end', () => {
    console.log(`Lector desconectado: ${reader.reader.name}`);
  });
});

nfc.on('error', err => {
  console.error('nfc error', err);
});
