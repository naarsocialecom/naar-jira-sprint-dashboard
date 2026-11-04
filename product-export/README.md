# Product export — daily stock report to Slack

Node.js job that runs once a day:

1. Reads active products from MongoDB (**read only**: write stages `$out` / `$merge` are refused).
2. Reads the active Meta (Ads Manager) campaigns with a read-only token and matches each one to a
   seller by the shop name in the campaign name, or by `meta-campaign-sellers.json`.
3. Builds an Excel file (tabs: Products, Low stock, Meta campaigns, Meta campaign products) and a
   dashboard image, posts both with a summary to Slack, and deletes the previous day's post.

No port, domain or Nginx is needed: it only makes outgoing connections (MongoDB, graph.facebook.com,
slack.com). The server's IP must be allowed in MongoDB Atlas → Network Access.

## Setup

```bash
cd /opt/naar-live/product-export
npm ci --omit=dev                # Node 18+
cp .env.example .env && chmod 600 .env && nano .env
npm run export:dry               # builds the files, sends nothing
npm run export                   # real run: posts to SLACK_CHANNEL_ID
```

Unmatched campaigns (no shop name in the campaign name) are listed as "not matched, not used".
To link one to a seller, add it to `meta-campaign-sellers.json`:
`{ "<campaign name or ID>": ["<shop name or seller userId>"] }`.

## Schedule

See `deploy/SERVER_SETUP.md` → section 4d (systemd timer, 11 AM IST). `ecosystem.config.js` is a PM2
alternative. Use only one of them, or the report posts twice.
