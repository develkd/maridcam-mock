# maridcam-mock

Mock-Backend mit Testdaten für [maridcam-frontend](https://github.com/develkd/maridcam-frontend).
Damit lässt sich das Frontend **ohne** [maridcam-backend](https://github.com/develkd/maridcam-backend)
starten, ansehen und testen: Gebetszeiten, Schüleranmeldung und der Verwaltungsbereich
(Anmeldung, Barzahler, Quittungen hochladen und stornieren).

- Node.js ≥ 20, **keine** Abhängigkeiten (`npm install` ist nicht nötig)
- Gleiche Endpunkte, Antworten und Fehlercodes wie das Backend (SDDs BE-006/007, BE-015, BE-017–BE-021)
- Alle Daten liegen im Arbeitsspeicher. Neustart oder `POST /__mock/reset` stellt die Testdaten wieder her.

> **Nur für Entwicklung und Tests.** Die Gebetszeiten sind aus dem Sonnenstand berechnete Näherungswerte und
> **keine** gültigen Gebetszeiten der Moschee. Alle Personen, Konten und Quittungen sind erfunden.

## Schnellstart

```bash
# Terminal 1: Mock auf Port 8080 (dort erwartet das Frontend das Backend)
cd maridcam-mock
npm start

# Terminal 2: Frontend wie gewohnt
cd maridcam-frontend
npm start            # http://localhost:4200
```

Das Frontend ruft fest `http://localhost:8080` auf (`API_BASE_URL` in `app.config.ts`). Läuft gleichzeitig das
echte Backend, ist der Port belegt; dann eines von beiden beenden.

## Zugänge

| E-Mail | Passwort | Ergebnis |
|---|---|---|
| `admin@maridcam.local` | `Admin-Dev-2026!` | Anmeldung als Admin (wie dev-Profil im Backend) |
| `sekretariat@maridcam.local` | `Sekretariat-Dev-2026!` | zweiter Admin, um „Hochgeladen von“/„Storniert von“ zu unterscheiden |
| `lehrer@maridcam.local` | `Lehrer-Dev-2026!` | 401 `INVALID_CREDENTIALS` (keine Rolle `ADMIN`) |
| `gesperrt@maridcam.local` | `Gesperrt-Dev-2026!` | 401 `INVALID_CREDENTIALS` (Konto gesperrt) |

Nach 5 Fehlversuchen für dieselbe E-Mail antwortet der Login 15 Minuten lang mit 429
`LOGIN_TEMPORARILY_LOCKED` (wie im Backend). `POST /__mock/reset` hebt die Sperre auf.

## Testdaten

Die Daten liegen als JSON in [`data/`](data) und lassen sich direkt bearbeiten (Neustart nötig).
Monats- und Datumsangaben sind **relativ zu heute** (`{{month-1}}`, `{{date-3}}`, `{{datetime-1}}`), damit
„aktueller Monat bezahlt/offen“ immer passt.

| Datei | Inhalt |
|---|---|
| `persons.json` | 26 Anmeldungen: 24 Barzahler (davon 4 Volljährige ohne Erziehungsberechtigte), je 1 × SEPA und Überweisung |
| `cash-receipts.json` | 23 Quittungen, davon 2 storniert. Die PDF-Belege werden beim Start erzeugt. |
| `admins.json` | Konten für den Verwaltungsbereich (siehe oben) |
| `mosque.json` | Moschee, Berechnungsparameter für Gebetszeiten, Iqama-Abstände, Jumua |

Fälle, die sich mit den Testdaten zeigen lassen:

| Person | Fall |
|---|---|
| Elif Demir | drei Monate einzeln bezahlt, aktueller Monat bezahlt |
| Zeynep Yılmaz | zwei Erziehungsberechtigte; eine Quittung über drei Monate und eine stornierte Quittung |
| Meryem Arslan | aktueller Monat nach Storno wieder offen: hier eine neue Quittung hochladen |
| Leon Schneider | volljährig, zahlt selbst; aktueller und nächster Monat im Voraus bezahlt |
| Ömer Çelik, Selin Öztürk, … | noch keine Quittung |
| Ahmet Demir (Kind) | gleicher Name wie der Vater von Elif: Suche nach „Ahmet“ findet beide |
| Max Mustermann | zahlt per SEPA, erscheint nicht in der Barzahler-Liste (Upload → 409 `PAYMENT_METHOD_NOT_CASH`) |

Mit 24 Barzahlern hat die Liste bei 20 Einträgen pro Seite eine zweite Seite („Mehr laden“).
Eine neue Anmeldung mit Zahlungsart „Bar“ erscheint sofort in der Barzahler-Liste.
Belegte E-Mail-Adressen (z. B. `elif.demir1@example.com`) liefern 409 `EMAIL_ALREADY_REGISTERED`.

## Endpunkte

| Methode | Pfad | Hinweis |
|---|---|---|
| `POST` | `/v1/auth/login` | Token gilt 1 h (`MOCK_TOKEN_TTL_SECONDS`) |
| `POST` | `/v1/student-registrations` | Pflichtfelder, Alter ↔ Erziehungsberechtigte, Zahlungsart/IBAN/SEPA-Mandat, Einwilligungen |
| `GET` | `/v1/prayer-times[?year=&month=]` | heutige Zeiten, nächstes Gebet, Kalender (Jahr oder Monat), Iqama |
| `GET` | `/v1/prayer-times/calendar.ics?lang=de\|tr\|en` | Kalender-Abo, 60 Tage ab heute |
| `GET` | `/v1/admin/cash-payers?query=&page=&size=` | nur Barzahler, Suche auch über Erziehungsberechtigte |
| `GET` | `/v1/admin/persons/{id}/cash-receipts` | neueste zuerst, inkl. stornierter |
| `POST` | `/v1/admin/persons/{id}/cash-receipts` | Multipart `file` + `data`; PDF/JPEG/PNG (Signatur), max. 10 MB |
| `POST` | `/v1/admin/cash-receipts/{id}/cancellation` | Storno mit Grund, nicht umkehrbar |
| `GET` | `/v1/admin/cash-receipts/{id}/file` | Beleg herunterladen |
| `GET` | `/__mock` | nur Mock: Zugänge, Einstellungen, Anzahl der Daten |
| `POST` | `/__mock/reset` | nur Mock: Testdaten neu laden |

Nicht nachgebildet: Wetter (das Frontend fragt open-meteo.com direkt ab), Swagger, E-Mail-Versand.

## Einstellungen

| Variable | Standard | Wirkung |
|---|---|---|
| `PORT` | `8080` | Port des Mocks |
| `HOST` | `127.0.0.1` | `0.0.0.0`, um z. B. vom Handy im WLAN zuzugreifen |
| `MOCK_DELAY_MS` | `0` | Verzögerung je Anfrage, um Ladezustände zu sehen (`npm run start:slow` = 1500 ms) |
| `MOCK_PRAYER_TIMES` | – | `unavailable` → Gebetszeiten liefern 503 `PRAYER_TIMES_UNAVAILABLE` (`npm run start:no-prayer-times`) |
| `MOCK_TOKEN_TTL_SECONDS` | `3600` | Laufzeit des Tokens, z. B. `60`, um den Ablauf der Sitzung zu testen |
| `MOCK_NOW` | – | feste Uhrzeit (ISO, z. B. `2026-11-08T14:00:00Z`) für reproduzierbare Screenshots und Tests |
| `MOCK_CORS_ORIGINS` | `*` | erlaubte Origins, kommagetrennt |

Beispiel: `MOCK_DELAY_MS=800 MOCK_TOKEN_TTL_SECONDS=120 npm start`

## Tests

```bash
npm test
```

- `test/api.test.js`: startet den Mock mit fester Uhrzeit und prüft Login/Sperre, Barzahler-Suche, Quittungsliste,
  Upload inkl. Fehlerfällen, Storno, Anmeldung, Gebetszeiten, Kalender-Abo, CORS und Reset.
- `test/contract.test.js`: Vertragstest gegen [`api/openapi.json`](api/openapi.json), die API-Beschreibung des
  Backends. Jeder Backend-Endpunkt muss nachgebildet sein, und jede Antwort muss genau die Felder des
  Backend-Schemas haben (keine fehlenden, keine zusätzlichen).

## Automatischer Abgleich mit dem Backend

```text
maridcam-backend (develop)                       maridcam-mock
docs/api/openapi.json oder SDD geändert ──────▶  Workflow „Mock an Backend-API anpassen“
  .github/workflows/notify-mock.yml                1. Backend auschecken, api/openapi.json übernehmen
  (repository_dispatch backend-api-changed)        2. Claude passt Endpunkte, Testdaten, Tests, README an
                                                   3. npm test
                                                   4. PR „Mock an Backend-API anpassen“ gegen develop
```

- Das Backend hält seine OpenAPI-Beschreibung als `docs/api/openapi.json` aktuell (`OpenApiSnapshotTest`).
- [`api/backend-sync.json`](api/backend-sync.json) merkt sich den zuletzt abgeglichenen Backend-Commit. Der
  Workflow schaut sich nur die Änderungen seitdem an.
- Gibt es nichts anzupassen, entsteht kein PR. Der PR wird nie automatisch gemergt.
- Von Hand starten: Actions → „Mock an Backend-API anpassen“ → „Run workflow“ (optional Backend-Branch).

Benötigte Secrets:

| Repo | Secret | Inhalt |
|---|---|---|
| maridcam-backend und maridcam-mock | `MARIDCAM_AUTOMATION_TOKEN` | Fine-grained Token (Owner `develkd`) für `maridcam-backend` und `maridcam-mock`: Contents read/write, Pull requests read/write |
| maridcam-mock | `ANTHROPIC_API_KEY` **oder** `CLAUDE_CODE_OAUTH_TOKEN` | Zugang für die Claude Code Action (`claude setup-token` erzeugt den OAuth-Token) |

## Aufbau

```text
src/
├── server.js            Start, Ausgabe der Zugänge
├── app.js               HTTP-Server, Routing, CORS, Verzögerung, /__mock
├── http.js              Fehlerformat (BE-007), JSON/Multipart lesen
├── store.js             Daten im Arbeitsspeicher, relative Platzhalter, Reset
├── time.js              Datum/Uhrzeit in Europe/Berlin
├── pdf.js               erzeugt die PDF-Belege der Testquittungen
├── prayer-calc.js       Näherungsberechnung der Gebetszeiten
└── routes/              auth, cash-receipts, registration, prayer-times
api/                     API-Beschreibung des Backends + zuletzt abgeglichener Commit
data/                    Testdaten (JSON)
test/                    API- und Vertragstests (node:test)
```

Änderungen am Mock von Hand: Endpunkt in `src/routes/`, Testdaten in `data/`, Tests in `test/`.
