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
pip install flask flask-cors requests python-dotenv gunicorn
```

Create your `.env` file:
```bash
nano /opt/naar-live/backend/.env
```

Paste your values:
```
JIRA_DOMAIN=https://yourcompany.atlassian.net
JIRA_EMAIL=you@yourcompany.io
JIRA_API_TOKEN=your_token_here
JIRA_BOARD_ID=4
JIRA_PROJECT_KEY=NAAR
FLASK_ENV=production
SECRET_KEY=change-this-to-a-random-secret
EPIC_TABLE_PAGE_SIZE=10
JIRA_FIELD_PLATFORM=customfield_10054
JIRA_FIELD_HIGHLIGHTS=customfield_11550
JIRA_HIGHLIGHTS_TICKET=NAAR-2531
```

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
