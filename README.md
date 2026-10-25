# Project Beyond (local backend edition)

A local-first AI command-center prototype. **No AI services are connected, no API keys are used, nothing paid is enabled.**
Tasks and activity logs are stored in a SQLite database file on your own computer.

## What you need
- **Node.js 22.13 or newer** (free): https://nodejs.org. Check with `node -v`.
- That's it. There is nothing to `npm install`.

## Run it
1. Unzip the project and open a terminal in the `project-beyond` folder.
2. Start the server:
   ```
   node server.js
   ```
   (You may see an "SQLite is an experimental feature" warning. That is normal.)
3. Open **http://localhost:3000** in your browser.
4. Stop the server with `Ctrl + C`.

The banner at the top should say **"Backend connected (local SQLite)"**.
Your data is saved in `data/beyond.db`. Delete that file to start fresh, or use Settings → Reset.

Use another port: `PORT=3001 node server.js` (Windows PowerShell: `$env:PORT=3001; node server.js`).

## Run the tests
```
node --test
```

## How it works
```
Browser (public/index.html) -> server.js (Node built-ins only) -> data/beyond.db (SQLite)
```
- If the backend isn't running (or you open `index.html` directly), the page falls back to browser storage and says so in the banner.
- The server listens on `127.0.0.1` only, validates all input, and rejects requests from other websites.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Check the server is up |
| GET | `/api/state` | Tasks, logs, settings |
| POST | `/api/tasks` | Create a task |
| PATCH | `/api/tasks/:id` | Change status (`pending`, `progress`, `done`) |
| DELETE | `/api/tasks/:id` | Delete a task |
| DELETE | `/api/logs` | Clear logs |
| PUT | `/api/settings` | Set `freeFirst` |
| POST | `/api/reset` | Restore sample data |

## Limits to know about
- SQLite via `node:sqlite` is marked experimental by Node, so it could change in a future Node version.
- Data lives on one computer. There are no user accounts, so don't expose this server to the internet as it is.
- It's free to run locally. Hosting it online is a separate step that may cost money; do that only after you decide to.

## Secrets (for later)
There are none today. When real AI providers are added, keys will live in a server-side `.env` file (already in `.gitignore`), never in `public/`. Nothing is connected until you approve it.
