# AGENTS.md — maridcam-mock

Mock-Backend mit Testdaten für maridcam-frontend. Überblick, Zugänge, Testdaten und Einstellungen: README.md.

## Git-Regeln

- **Niemals direkt auf `develop` pushen.** `develop` erhält Änderungen ausschließlich über gemergte Pull Requests – auch beim ersten Commit eines neuen Repositorys, bei kleinen Korrekturen und nie per Force-Push.
- Jede Änderung entsteht auf einem eigenen Branch, der vom aktuellen `origin/develop` abzweigt, und geht per Pull Request gegen `develop`.
- Pull Requests folgen der Vorlage `.github/pull_request_template.md`.
- Der Workflow „Mock an Backend-API anpassen“ arbeitet ebenso: Branch `auto/backend-api-sync`, PR gegen `develop`, nie automatisch gemergt.

## Entwicklung

- Node ≥ 20, keine npm-Abhängigkeiten hinzufügen.
- `npm test` muss grün sein (API-, Vertrags- und Export-Tests).
- API-Verhalten folgt dem Backend (`api/openapi.json`, SDDs in maridcam-backend `docs/sdd/backend/`). Neuer Endpunkt: Route in `src/routes/`, Beispiel in `test/contract.test.js` (`SAMPLES`), Test in `test/api.test.js`, README-Tabelle.
- Testdaten nur in `data/*.json` ändern; danach `npm run export:liquibase` und das Ergebnis per PR ins Backend (`src/main/resources/db/changelog/mock/`).
