const { NFC } = require('nfc-pcsc');

const nfc = new NFC();

nfc.on('reader', reader => {
    console.log('Lector detectado:', reader.reader.name);

    reader.on('card', card => {
        console.log('Tarjeta detectada:', card.uid || card);
    });

    reader.on('error', err => console.error('Error lector:', err));
});

nfc.on('error', err => console.error('Error global nfc:', err));