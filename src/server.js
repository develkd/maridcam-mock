#!/usr/bin/env node
'use strict';

const { createApp, configFromEnv } = require('./app');

const config = configFromEnv();
const { server, store } = createApp(config);

server.listen(config.port, config.host, () => {
  const base = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  console.log(`maridcam-mock läuft auf ${base}`);
  console.log(`  ${store.persons.filter((p) => p.paymentMethod === 'CASH').length} Barzahler, ${store.receipts.length} Quittungen`);
  console.log(`  Admin: ${store.admins[0].email} / ${store.admins[0].password}`);
  console.log(`  Übersicht: ${base}/__mock   Zurücksetzen: POST ${base}/__mock/reset`);
  if (config.delayMs) console.log(`  Verzögerung: ${config.delayMs} ms je Anfrage`);
  if (config.prayerTimesUnavailable) console.log('  Gebetszeiten: liefern 503 PRAYER_TIMES_UNAVAILABLE');
  if (config.now) console.log(`  Feste Uhrzeit: ${config.now}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} ist belegt (läuft das echte Backend?). Anderen Port wählen: PORT=8081 npm start`);
    process.exit(1);
  }
  throw err;
});
