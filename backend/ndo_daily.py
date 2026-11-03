"""
Scheduled entry point for the NDO daily Slack update.

    python ndo_daily.py check           # verify Slack token, scopes and channels (posts nothing)
    python ndo_daily.py sync            # read + rephrase today's developer updates from Slack
    python ndo_daily.py remind          # 6 PM: "1 hour left" reminder in the updates channel
    python ndo_daily.py post [--force]  # 7 PM: post snapshot + summary — skipped if no updates today
    python ndo_daily.py preview [file]  # write the snapshot PNG + print the message, no Slack

Run from cron or the systemd timers in deploy/ — not inside gunicorn, so the
post happens exactly once no matter how many web workers are running.
"""
import argparse
import logging
import sys
from pathlib import Path

from ndo_report import slack_text
from ndo_service import NdoService, SlackNotConfigured
from slack_client import SlackError

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s: %(message)s')
logger = logging.getLogger('ndo_daily')


def check_slack() -> int:
    from config import Config
    from slack_client import SlackClient
    if not Config.SLACK_BOT_TOKEN:
        logger.error('SLACK_BOT_TOKEN is not set in backend/.env')
        return 2
    problems = SlackClient().check({
        'Summary channel (SLACK_CHANNEL_ID)': Config.SLACK_CHANNEL_ID,
        'Developer updates channel (SLACK_DEV_UPDATES_CHANNEL_ID)': Config.SLACK_DEV_UPDATES_CHANNEL_ID,
        'Reminder channel (SLACK_REMINDER_CHANNEL_ID)': Config.SLACK_REMINDER_CHANNEL_ID,
    })
    for p in problems:
        logger.error(p)
    if not problems:
        logger.info('Slack setup looks good.')
    return 1 if problems else 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', choices=['check', 'sync', 'remind', 'post', 'preview'])
    parser.add_argument('output', nargs='?', default='ndo-snapshot.png', help='preview: PNG output path')
    parser.add_argument('--force', action='store_true', help='post even if already posted today')
    args = parser.parse_args(argv)

    if args.command == 'check':
        return check_slack()

    svc = NdoService()
    try:
        if args.command == 'sync':
            logger.info(f"Developer updates synced: {svc.sync_dev_updates()}")
        elif args.command == 'remind':
            logger.info(f"Reminder sent: {svc.send_reminder()}")
        elif args.command == 'post':
            result = svc.post_daily(force=args.force)
            logger.info(result.get('message') or 'Daily update posted')
        else:
            report = svc.report(refresh=True)
            Path(args.output).write_bytes(svc.slack_image(report))
            print(slack_text(report))
            logger.info(f"Snapshot written to {Path(args.output).resolve()}")
    except SlackNotConfigured as e:
        logger.error(str(e))
        return 2
    except SlackError as e:
        logger.error(str(e))
        return 1
    except Exception:
        logger.exception('NDO daily job failed')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
