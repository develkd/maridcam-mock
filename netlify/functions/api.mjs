/**
 * Netlify Function: stellt den Mock unter /v1/* und /__mock bereit (siehe netlify.toml und README, Abschnitt Netlify).
 * Übersetzt die Web-API (Request/Response) von Netlify in die req/res-Schnittstelle von node:http, die der Mock nutzt.
 *
 * Wichtig: Daten liegen im Arbeitsspeicher der Function-Instanz. Hochgeladene Quittungen, Stornos und neue Anmeldungen
 * gehen verloren, sobald Netlify die Instanz beendet oder eine neue startet; danach gelten wieder die Testdaten.
 */
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
const { createHandler, configFromEnv } = require('../../src/app.js');

// Eine Instanz je Function-Container: Testdaten werden einmal geladen und bleiben bis zum Neustart erhalten.
const { handler } = createHandler({ ...configFromEnv(process.env), quiet: true });

/** Minimaler Ersatz für http.ServerResponse: sammelt Status, Header und Body. */
class CollectingResponse extends EventEmitter {
  constructor(done) {
    super();
    this.done = done;
    this.statusCode = 200;
    this.headers = {};
    this.headersSent = false;
  }

  writeHead(status, headers = {}) {
    this.statusCode = status;
    Object.assign(this.headers, headers);
    this.headersSent = true;
    return this;
  }

  end(body) {
    this.headersSent = true;
    const noBody = this.statusCode === 204 || this.statusCode === 304 || body === undefined || body === null;
    const headers = new Headers();
    for (const [name, value] of Object.entries(this.headers)) {
      // Content-Length setzt die Plattform selbst
      if (name.toLowerCase() !== 'content-length') headers.set(name, String(value));
    }
    this.emit('finish');
    this.done(new Response(noBody ? null : body, { status: this.statusCode, headers }));
  }
}

export default async (request) => {
  const url = new URL(request.url);
  const body = Buffer.from(await request.arrayBuffer());
  const req = Readable.from(body.length ? [body] : []);
  req.method = request.method;
  req.url = url.pathname + url.search;
  req.headers = Object.fromEntries(request.headers); // Schlüssel sind bereits kleingeschrieben
  req.headers['content-length'] = String(body.length);

  return new Promise((resolve) => {
    handler(req, new CollectingResponse(resolve));
  });
};

export const config = {
  path: ['/v1/*', '/__mock', '/__mock/*'],
};
