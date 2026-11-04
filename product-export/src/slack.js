const fs = require("fs");
const path = require("path");
const { WebClient } = require("@slack/web-api");

// Deletes this report's earlier posts in one conversation, so only the newest
// stays. Only messages posted by this bot whose files carry this report's file
// prefix are touched; the bot's other messages are left alone.
// Returns the number of report posts deleted.
async function deletePreviousReports(client, channel, { bot, filePrefix, before }) {
  const isReport = (m) =>
    (m.user === bot.user_id || (bot.bot_id && m.bot_id === bot.bot_id)) &&
    m.files?.some((f) => f.name?.startsWith(`${filePrefix}_`));

  let deleted = 0;
  let cursor;
  // Last 1,000 messages is plenty for a once-a-day report
  for (let page = 0; page < 5; page++) {
    const res = await client.conversations.history({ channel, latest: before, limit: 200, cursor });
    for (const message of res.messages.filter(isReport)) {
      for (const file of message.files) {
        await client.files.delete({ file: file.id }).catch(ignore("file_not_found", "file_deleted"));
      }
      await client.chat.delete({ channel, ts: message.ts }).catch(ignore("message_not_found"));
      deleted++;
    }
    cursor = res.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return deleted;
}

// Swallows the given Slack errors (already gone), rethrows anything else
const ignore = (...codes) => (err) => {
  if (!codes.includes(err.data?.error)) throw err;
};

// Posts the report to each channel in SLACK_CHANNEL_ID and as a DM to each user
// in SLACK_USER_ID: the file(s) with the summary (or a one-line comment) as text.
// With deletePrevious, earlier report posts are removed after the new one is up.
// Returns [{ channel, deleted, warning }].
async function sendToSlack(slack, { files, rowCount, title, summary, filePrefix }) {
  const client = new WebClient(slack.token);
  const conversations = [...slack.channelIds];

  // A DM needs the bot's conversation ID with that user, not the user ID itself
  for (const user of slack.userIds) {
    const dm = await client.conversations.open({ users: user });
    conversations.push(dm.channel.id);
  }
  if (!conversations.length) {
    throw new Error("Set SLACK_CHANNEL_ID and/or SLACK_USER_ID in .env");
  }

  const bot = slack.deletePrevious ? await client.auth.test() : null;
  // Slack timestamp of "now": everything older than this is a previous post
  const before = (Date.now() / 1000).toFixed(6);

  const date = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const fileUploads = () => files.map((f) => ({ file: fs.readFileSync(f), filename: path.basename(f) }));

  // One message per conversation: the files (dashboard image first, so Slack
  // previews it) with the summary as the message text
  const comment = summary ? summary.slackText : `:bar_chart: ${title} - ${date} (${rowCount} rows)`;
  const results = [];
  for (const channel of conversations) {
    await client.files.uploadV2({ channel_id: channel, initial_comment: comment, file_uploads: fileUploads() });
    const result = { channel, deleted: 0 };

    // Clean-up runs only after the new post succeeded; a failure here is reported, not fatal
    if (slack.deletePrevious) {
      try {
        result.deleted = await deletePreviousReports(client, channel, { bot, filePrefix, before });
      } catch (err) {
        const reason = err.data?.error || err.message;
        result.warning = `old posts not deleted (${reason}${err.data?.needed ? `, needs scope ${err.data.needed}` : ""})`;
      }
    }
    results.push(result);
  }

  return results;
}

module.exports = { sendToSlack, deletePreviousReports };
