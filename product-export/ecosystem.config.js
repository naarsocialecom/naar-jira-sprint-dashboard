// PM2 setup for the daily product report.
// The report is a one-shot job (it runs, posts, exits), so PM2 does not keep it
// alive; cron_restart starts it once a day instead.
//   pm2 start ecosystem.config.js && pm2 save
module.exports = {
  apps: [
    {
      name: "naar-product-export",
      script: "src/index.js",
      cwd: __dirname,
      // Every day at 11:00 server time. If the server runs on UTC, use "30 5 * * *" (= 11:00 IST).
      cron_restart: "0 11 * * *",
      autorestart: false,
      instances: 1,
      exec_mode: "fork",
      out_file: "logs/pm2-out.log",
      error_file: "logs/pm2-error.log",
      time: true,
    },
  ],
};
