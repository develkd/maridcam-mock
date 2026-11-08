---
name: neue-session
description: Verwenden, sobald der Nutzer eine neue Session verlangt oder ein neues Projekt angelegt wird – z. B. „neue Session“, „in einer neuen Session“, „erstelle eine Session für <Repo>“, „mach das in einer eigenen Session“. Dann wird zuerst eine komplett neue Session erstellt, in der die Anweisung durchgeführt wird; in der aktuellen Session wird für diese Aufgabe nichts getan. Neue Projekte bekommen diesen Skill unter .claude/skills/neue-session/.
---

# Neue Session

Regel des Nutzers: **Bei neuen Sessions wird zuerst eine komplett neue Session erstellt, in der dann die Anweisung
durchgeführt wird.**

## Vorgehen

1. **In der aktuellen Session nichts für die Aufgabe tun.** Kein `add_repo`, kein Klonen, keine Dateien, keine Commits,
   keine Notizen oder Doku im Repository der aktuellen Session, keine Recherche vorab.
2. **Sofort eine neue Session erstellen** (`create_session`):
   - `source_url`: das Repository, um das es geht. Mehrere Ziel-Repositorys → je eine eigene Session.
   - `title`: kurz und eindeutig, z. B. `develkd/epic_v2 – Redesign`.
   - `prompt`: die **vollständige Anweisung des Nutzers** (wörtlich) plus allen Kontext aus dem Gespräch, den die neue
     Session braucht, um selbstständig zu arbeiten (Ziel, Referenz-Repositorys zum Lesen, Rahmenbedingungen). Die neue
     Session kennt dieses Gespräch nicht.
   - `append_system_prompt`: dauerhafte Regeln des Nutzers, mindestens: „Niemals direkt auf `develop` pushen.
     `develop` erhält Änderungen ausschließlich über gemergte Pull Requests – auch beim ersten Commit eines neuen
     Repositorys, bei kleinen Korrekturen und nie per Force-Push. Jede Änderung entsteht auf einem eigenen Branch und
     geht per Pull Request gegen `develop`.“
   - Kein `prompt` nur dann, wenn der Nutzer ausdrücklich eine leere Session ohne Auftrag will.
3. **Hier nur kurz melden:** Titel, Session-ID, Repository und was als Auftrag übergeben wurde. Nicht nachfragen, ob man
   die Aufgabe doch hier erledigen soll.
4. Rückfragen, die die neue Session selbst klären kann (Branches, Struktur, Details), gehören in die neue Session,
   nicht in die aktuelle.

## Neue Projekte

Der Skill ist projektspezifisch (nicht konto- oder organisationsweit). Wird ein **neues Projekt/Repository angelegt**,
gehört er von Anfang an dazu, damit jeder, der das Projekt auscheckt, ihn nutzen kann:

- Datei unverändert nach `.claude/skills/neue-session/SKILL.md` im neuen Repository kopieren.
- Wie jede Änderung über einen eigenen Branch und einen Pull Request gegen `develop` (nie direkt auf `develop`).
- Gilt auch, wenn das neue Projekt über eine neue Session angelegt wird: Dann gehört „Skill `neue-session` unter
  `.claude/skills/neue-session/SKILL.md` ablegen“ in den `prompt` dieser Session, zusammen mit dem Inhalt dieser Datei.

## Hinweis

Eine per Werkzeug erstellte Session ist technisch mit der erstellenden Session verknüpft. Ganz unabhängig wird sie nur,
wenn der Nutzer sie selbst auf claude.ai/code startet. Deshalb gilt umso strenger: Die Arbeit findet ausschließlich in
der neuen Session statt.
