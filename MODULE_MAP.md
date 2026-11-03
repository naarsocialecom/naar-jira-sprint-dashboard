# Naar Dashboard — Module Map
> "Which file do I touch?" — answered here.

---

## Frontend JS

### Entry point
| File | What it does |
|------|-------------|
| `js/dashboard.js` | Boots everything on `DOMContentLoaded`. Rarely needs changing. |

### `js/modules/` — Core logic
| File | What it does | Touch when… |
|------|-------------|-------------|
| `state.js` | Global `State` and `Settings` objects. Single source of truth. | Adding a new global variable |
| `helpers.js` | Pure utility functions (sorting, escaping, date calc). No DOM. | Adding/changing utility logic |
| `adf-renderer.js` | Converts Jira ADF JSON → HTML. Fully self-contained. | Jira changes their ADF format |
| `highlights.js` | Fetches and renders the Highlights section. | Changing highlights display |
| `sprints.js` | Sprint selector, checklist, data fetching. | Changing sprint selector UI |
| `epic-table.js` | Epic table, search, pagination. | Changing the epic table |
| `platform.js` | Platform breakdown cards. | Changing platform cards |
| `chart-plugins.js` | Chart.js custom plugins (bar labels, donut center). | Adding new chart plugin |
| `legend.js` | Renders legends in pill or table style. | Changing legend appearance |
| `settings-panel.js` | Settings drawer UI + apply/reset. | Changing settings options |
| `orchestrator.js` | Runs all charts/metrics after data loads. Has `safeRun` wrapper. | Adding a new section to refresh |

### `js/charts/` — One file per chart
| File | Chart | Touch when… |
|------|-------|-------------|
| `chart-issue-type.js` | Issue Types bar chart | Changing that bar chart ONLY |
| `chart-priority.js` | Priority donut chart | Changing that donut ONLY |
| `chart-component.js` | Components horizontal bar | Changing that bar ONLY |
| `chart-heat.js` | Heat (Bug×Incident) clustered bar | Changing heat chart ONLY |

**Key rule**: If chart A breaks, charts B/C/D keep working. Each has its own `_instance` variable and `destroy()`.

---

## Frontend CSS

| File | What it styles |
|------|---------------|
| `css/style.css` | Everything base: layout, cards, header, metrics, charts, epic table, platform |
| `css/modules/settings-panel.css` | Settings drawer + gear button |
| `css/modules/legend-table.css` | Table-style and pill-style legends |
| `css/ndo.css` | Naar Data Operations page (`/ndo`) |

**NDO page JS**: `js/ndo.js` (+ `templates/ndo.html`) — standalone, reuses `modules/helpers.js` only.

---

## Backend

| File | What it does | Touch when… |
|------|-------------|-------------|
| `backend/app.py` | Flask routes | Adding/changing API endpoints |
| `backend/jira_apis.py` | All Jira API calls | Changing Jira queries or adding new endpoints |
| `backend/config.py` | Reads every setting from `backend/.env` (template: `.env.example`). No hardcoded values. | Adding/changing config keys |
| `backend/ndo_routes.py` | `/ndo` page + `/api/ndo/*` endpoints | Adding NDO endpoints |
| `backend/ndo_service.py` | NDO glue: Jira query + cache, developer-update sync, 6 PM reminder, 7 PM post (skipped without updates) | Changing the JQL or daily flow |
| `backend/ndo_report.py` | Pure logic: RAG rules, highlight sentences, key tickets, Slack text | Changing the reasoning / wording |
| `backend/ndo_snapshot.py` | Renders the PNG snapshot posted to Slack (Pillow) | Changing the Slack image |
| `backend/ndo_store.py` | JSON store (`data/ndo_state.json`) for team updates, RAG override, Slack state | Changing what's saved per day |
| `backend/slack_client.py` | Slack Web API calls (post, upload image, read channel/threads, mrkdwn → text) | Slack API changes |
| `backend/ai_rephrase.py` | Rephrases developer updates via `AI_ENDPOINT_URL`; keeps ticket keys | Changing the AI prompt or endpoint format |
| `backend/ndo_daily.py` | CLI for the scheduler: `sync` / `remind` / `post` / `preview` | Changing scheduled behaviour |

---

## Deploy

| File | Purpose |
|------|---------|
| `deploy/naar-dashboard.service` | systemd unit — copy to `/etc/systemd/system/` |
| `deploy/nginx-naar-dashboard.conf` | Nginx reverse proxy config |
| `deploy/SERVER_SETUP.md` | Step-by-step server setup guide |
| `deploy/ndo-daily@.service` + `ndo-daily-*.timer` / `ndo-crontab` | 6 PM IST reminder, 7 PM IST post |

---

## Common tasks

**"I want to change the color of the Issue Type chart"**
→ Open Settings panel → Issue Type Chart Colors. Or edit `Settings.barColors.issueType` defaults in `modules/state.js`.

**"I broke the heat chart"**
→ Only `charts/chart-heat.js` is affected. Other charts still work.

**"I want to add a new chart"**
→ Create `charts/chart-myname.js` → Import and call in `orchestrator.js` inside `refreshAllChartsAndMetrics()` wrapped in `safeRun()`.

**"I want to add a new setting"**
→ Add it to `Settings` object in `state.js`, add UI in `settings-panel.js`, consume it where needed.

**"Platform cards are showing blank"**
→ Check `modules/platform.js`. The `PLATFORM_FIELD` comes from `helpers.js` which reads `JIRA_PLATFORM_FIELD` set in `index.html` from Flask.

**"I want to change the NDO RAG rules or highlight wording"**
→ `backend/ndo_report.py` — `compute_rag()` and `build_highlights()`. Test with `python ndo_daily.py preview`.

**"Which tickets does /ndo show?"**
→ `NDO_PROJECT_KEY`, `NDO_ISSUE_TYPES`, `NDO_EXCLUDED_STATUSES` in `backend/.env`. The JQL is printed in the page footer.
