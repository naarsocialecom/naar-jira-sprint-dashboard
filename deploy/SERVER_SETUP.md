# Naar Dashboard — Server Setup Guide

## Prerequisites
- Ubuntu 20.04+ (or any systemd-based Linux)
- Python 3.9+
- Nginx
- A domain or static IP

---

## 1. Upload the project

```bash
scp -r naar-live/ ubuntu@your-server:/opt/naar-live
```

Or clone from Git:
```bash
git clone your-repo /opt/naar-live
```

---

## 2. Backend setup

```bash
cd /opt/naar-live/backend
python3 -m venv venv
source venv/bin/activate
pip install -r ../requirements.txt
```

All configuration lives in `backend/.env` — nothing is hardcoded in `config.py`.
Start from the template and fill it in:
```bash
cp /opt/naar-live/backend/.env.example /opt/naar-live/backend/.env
chmod 600 /opt/naar-live/backend/.env
nano /opt/naar-live/backend/.env
```

The app refuses to start if a required value (`JIRA_DOMAIN`, `JIRA_EMAIL`,
`JIRA_API_TOKEN`, `JIRA_BOARD_ID`, `JIRA_PROJECT_KEY`, `SECRET_KEY`) is missing,
and the error names the missing variable. Keep comments on their own lines —
systemd's `EnvironmentFile` doesn't support inline `# comments`.

---

## 3. Create the log directory

```bash
sudo mkdir -p /var/log/naar-dashboard
sudo chown ubuntu:ubuntu /var/log/naar-dashboard
```

---

## 4. Install the systemd service

```bash
sudo cp /opt/naar-live/deploy/naar-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable naar-dashboard
sudo systemctl start naar-dashboard

# Check status
sudo systemctl status naar-dashboard

# Check logs
journalctl -u naar-dashboard -f
```

---

## 4b. Naar Data Operations — daily Slack update (6 PM reminder, 7 PM post)

The `/ndo` page works without Slack. To turn on the daily flow:

1. Create a Slack app → **OAuth & Permissions** → bot scopes:
   `chat:write`, `files:write`, `channels:history`, `users:read`
   (+ `groups:history` if any of the channels is private).
2. Install it to the workspace and copy the **Bot User OAuth Token** (`xoxb-…`).
3. `/invite @YourBot` in **both** channels: the summary channel and the developer updates channel.
4. In `backend/.env` set `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID` (summary), `SLACK_DEV_UPDATES_CHANNEL_ID`,
   optionally `SLACK_REMINDER_CHANNEL_ID` / `SLACK_REMINDER_MENTION`, `DASHBOARD_URL`,
   and the `AI_*` values for rephrasing. Restart the app.

The Slack image is a real screenshot of the `/ndo` page (header, tiles, Highlights), taken
with headless Chromium. Install the browser once (needs the app running to take shots):
```bash
cd /opt/naar-live/backend && venv/bin/python -m playwright install --with-deps chromium
```
If the browser can't run, the post still goes out with a simpler drawn summary image.

Test without posting anything:
```bash
cd /opt/naar-live/backend
venv/bin/python ndo_daily.py sync                  # reads + rephrases today's developer updates
venv/bin/python ndo_daily.py preview /tmp/ndo.png  # prints the Slack message, writes the image
```

Schedule it — **either** systemd timers (timezone-aware, recommended):
```bash
sudo cp /opt/naar-live/deploy/ndo-daily@.service /opt/naar-live/deploy/ndo-daily-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ndo-daily-remind.timer ndo-daily-post.timer
systemctl list-timers 'ndo-*'
journalctl -u 'ndo-daily@*' -n 50     # logs
```
**or** cron (see the UTC note inside the file):
```bash
crontab -u ubuntu /opt/naar-live/deploy/ndo-crontab
```

What happens each day (IST):
- **During the day** developers post updates in the updates channel. The dashboard reads them
  (every 5 min while open, or via **Fetch developer updates**), rephrases them with the AI
  endpoint, and shows them under **Developer Updates** with ticket links and live Jira status.
- **6:00 PM** reminder in the updates channel: "1 hour left", with how many updates are in.
- **7:00 PM** posts the snapshot + summary to the summary channel — **only if there are
  developer updates from today**. Otherwise nothing is posted and a short "not sent" notice
  goes to the reminder thread. Post later from the dashboard once updates are in.

> The `/ndo` page can post to Slack, so keep the dashboard behind Nginx auth/VPN.

---

## 4d. Daily product report (`product-export/`, 9 AM IST)

A separate Node.js job (no port, no domain, no Nginx). It reads products from MongoDB
(read only) and active campaigns from Meta, then posts a dashboard image + Excel file to Slack
and deletes the previous day's post. Details: `product-export/README.md`.

```bash
# Node 18+ is needed (node -v). Then:
cd /opt/naar-live/product-export
npm ci --omit=dev
cp .env.example .env && chmod 600 .env && nano .env    # MongoDB, Slack, Meta values
npm run export:dry                                      # test: builds files, sends nothing
```
Add the server's IP in MongoDB Atlas → Network Access, or the run can't connect.

Schedule it — **either** the systemd timer (recommended, same as NDO):
```bash
sudo cp /opt/naar-live/deploy/product-export.service /opt/naar-live/deploy/product-export.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now product-export.timer
systemctl list-timers product-export.timer
sudo systemctl start product-export.service     # run once now
journalctl -u product-export -n 50              # logs
```
**or** PM2: `cd /opt/naar-live/product-export && pm2 start ecosystem.config.js && pm2 save`
(the time in that file is server time). Don't use both.

---

## 4c. Production checklist (do these before go-live)

- [ ] `backend/.env` on the server: `APP_ENV=production`, `DEBUG=false`, a fresh `SECRET_KEY`,
      real `DASHBOARD_URL` (https://…), `CORS_ORIGINS` = that URL, `SNAPSHOT_BROWSER_CHANNEL` blank.
- [ ] `chmod 600 /opt/naar-live/backend/.env` and owned by the app user.
- [ ] New Jira API token (the old one is in git history) — revoke the old one.
- [ ] Nginx password set: `sudo htpasswd -c /etc/nginx/.naar-dashboard.htpasswd <user>`.
- [ ] HTTPS certificate (certbot) in place; port 5005 **not** open in the firewall (only 80/443).
- [ ] `venv/bin/python -m playwright install --with-deps chromium` done as the app user.
- [ ] `venv/bin/python ndo_daily.py check` passes; `ndo_daily.py preview /tmp/x.png` produces the image.
- [ ] Timers enabled: `systemctl list-timers 'ndo-*'` shows 18:00 and 19:00 IST.

The 7 PM screenshot job opens `http://127.0.0.1:5005/ndo` directly (not through Nginx),
so the Nginx password doesn't block it — keep `SNAPSHOT_BASE_URL` blank.

---

## 5. Set up Nginx

```bash
sudo apt install nginx -y
sudo cp /opt/naar-live/deploy/nginx-naar-dashboard.conf /etc/nginx/sites-available/naar-dashboard
sudo ln -s /etc/nginx/sites-available/naar-dashboard /etc/nginx/sites-enabled/
sudo nginx -t        # test config
sudo systemctl restart nginx
```

### For HTTPS (recommended):
```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d your-domain.com
```

---

## 6. Test

```bash
curl http://localhost:5005/api/sprints
# Should return JSON with your sprints
```

Then open your domain in a browser.

---

## Everyday commands

| Task | Command |
|------|---------|
| Restart app | `sudo systemctl restart naar-dashboard` |
| View live logs | `journalctl -u naar-dashboard -f` |
| Reload Nginx | `sudo systemctl reload nginx` |
| Deploy new code | Upload files → `sudo systemctl restart naar-dashboard` |
| Check if running | `sudo systemctl status naar-dashboard` |

---

## File permissions

```bash
sudo chown -R ubuntu:ubuntu /opt/naar-live
chmod -R 755 /opt/naar-live/frontend/static
```

---

## Troubleshooting

**502 Bad Gateway** — Gunicorn not running. Run: `sudo systemctl restart naar-dashboard`

**Charts not loading** — Check browser console. Most likely the `JIRA_API_TOKEN` in `.env` is expired. Refresh it in Atlassian → Account Settings → API tokens.

**Static files 404** — Make sure the `alias` path in nginx config matches your actual `frontend/static/` folder location.

**Settings not saving** — The settings panel uses `localStorage`. Make sure the user isn't in incognito mode or has storage blocked.
