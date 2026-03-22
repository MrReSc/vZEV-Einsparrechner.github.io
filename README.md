# vZEV Einsparrechner

[www.strom-vom-dohlenweg.zeres.ch](www.strom-vom-dohlenweg.zeres.ch)

## Lokal starten

Die Seiten laden ihre Texte per `fetch()` aus `texts/*.json`.
Darum funktionieren `index.html` und `calculator.html` nicht zuverlässig via `file://...` (CORS/Same-Origin).

Starte lokal einen HTTP-Server im Projektordner:

```bash
python3 -m http.server 8000
```

Dann im Browser öffnen:

- `http://localhost:8000/index.html`
- `http://localhost:8000/calculator.html`
- `http://localhost:8000/simulation.html`
