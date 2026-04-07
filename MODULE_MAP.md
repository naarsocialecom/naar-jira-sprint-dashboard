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

---

## Backend

| File | What it does | Touch when… |
|------|-------------|-------------|
| `backend/app.py` | Flask routes | Adding/changing API endpoints |
| `backend/jira_apis.py` | All Jira API calls | Changing Jira queries or adding new endpoints |
| `backend/config.py` | Configuration (env vars) | Adding/changing config keys |

---

## Deploy

| File | Purpose |
|------|---------|
| `deploy/naar-dashboard.service` | systemd unit — copy to `/etc/systemd/system/` |
| `deploy/nginx-naar-dashboard.conf` | Nginx reverse proxy config |
| `deploy/SERVER_SETUP.md` | Step-by-step server setup guide |

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
