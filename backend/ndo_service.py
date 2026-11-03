"""
NDO service — ties Jira, the note store, the report builder and Slack together.
Used by both the Flask routes (ndo_routes.py) and the scheduler CLI (ndo_daily.py).

Daily flow (times in REPORT_TIMEZONE):
  during the day  developers post updates in SLACK_DEV_UPDATES_CHANNEL_ID
                  → sync_dev_updates() reads today's messages, rephrases them (AI),
                    and stores them as today's "Developer Updates"
  18:00           send_reminder()  "1 hour left — post your updates"
  19:00           post_daily()     posts snapshot + summary, but ONLY if today has
                                   developer updates (never yesterday's)
"""
import logging
import threading
import time
from datetime import datetime, timezone
from typing import Dict, List, Tuple

from zoneinfo import ZoneInfo

from ai_rephrase import CLOSED_TICKET_PROMPT, rephrase, ticket_keys
from config import Config
from dashboard_snapshot import SnapshotError, capture_dashboard
from jira_apis import JiraClient
from ndo_report import _parse_dt, adf_text, build_report, normalize_issue, slack_text
from ndo_snapshot import render_snapshot
from ndo_store import NdoStore
from slack_client import SlackClient, SlackError

logger = logging.getLogger(__name__)

TICKET_FIELDS = ['issuetype', 'status', 'priority', 'summary', 'assignee', 'created', 'updated']
CLOSED_TICKET_FIELDS = ['issuetype', 'status', 'summary', 'assignee', 'description', 'comment',
                        'issuelinks', 'subtasks', 'statuscategorychangedate']


class SlackNotConfigured(RuntimeError):
    pass


def _jql_list(values: List[str]) -> str:
    return ', '.join('"' + v.replace('"', '\\"') + '"' for v in values)


class NdoService:
    def __init__(self, jira: JiraClient = None, store: NdoStore = None):
        self.jira = jira or JiraClient()
        self.store = store or NdoStore()
        self.tz = ZoneInfo(Config.REPORT_TIMEZONE)
        self._cache: Dict = {'at': 0.0, 'tickets': None}
        # Touched on every forced refresh so all gunicorn workers drop their cached tickets
        self._refresh_stamp = self.store.data_dir / 'ndo-refresh.stamp'
        self._lock = threading.Lock()
        self._sync_lock = threading.Lock()
        self._shot_lock = threading.Lock()
        self._shot_cache: Dict = {'at': 0.0, 'png': None}

    # ── Time ─────────────────────────────────────────────────
    def now(self) -> datetime:
        return datetime.now(self.tz)

    def today(self) -> str:
        return self.now().strftime('%Y-%m-%d')

    def start_of_today(self) -> datetime:
        return self.now().replace(hour=0, minute=0, second=0, microsecond=0)

    # ── Jira ─────────────────────────────────────────────────
    @property
    def jql(self) -> str:
        parts = [f'project = "{Config.NDO_PROJECT_KEY}"']
        if Config.NDO_ISSUE_TYPES:
            parts.append(f'issuetype in ({_jql_list(Config.NDO_ISSUE_TYPES)})')
        if Config.NDO_EXCLUDED_STATUSES:
            parts.append(f'status not in ({_jql_list(Config.NDO_EXCLUDED_STATUSES)})')
        return ' AND '.join(parts) + ' ORDER BY priority DESC, created DESC'

    def _last_forced_refresh(self) -> float:
        try:
            return self._refresh_stamp.stat().st_mtime
        except OSError:
            return 0.0

    def _mark_forced_refresh(self) -> None:
        try:
            self._refresh_stamp.touch()
        except OSError as e:
            logger.warning(f"Could not write refresh stamp: {e}")

    def tickets(self, refresh: bool = False) -> List[Dict]:
        with self._lock:
            if refresh:
                self._mark_forced_refresh()
            fresh = (time.time() - self._cache['at'] < Config.NDO_CACHE_SECONDS
                     and self._cache['at'] > self._last_forced_refresh())
            if self._cache['tickets'] is not None and fresh and not refresh:
                return self._cache['tickets']
            fields = TICKET_FIELDS + ([Config.JIRA_FIELD_SEVERITY] if Config.JIRA_FIELD_SEVERITY else [])
            raw = self.jira.search_issues(self.jql, fields)
            now = self.now()
            tickets = [normalize_issue(i, Config.JIRA_DOMAIN, Config.JIRA_FIELD_SEVERITY, now) for i in raw]
            self._cache = {'at': time.time(), 'tickets': tickets}
            return tickets

    def ticket_info(self, keys: List[str]) -> Dict[str, Dict]:
        """Current status/summary for tickets mentioned in updates (incl. Done ones)."""
        if not keys:
            return {}
        fields = TICKET_FIELDS + ([Config.JIRA_FIELD_SEVERITY] if Config.JIRA_FIELD_SEVERITY else [])
        try:
            issues = self.jira.search_issues(f"key in ({', '.join(sorted(set(keys)))})", fields)
        except Exception as e:
            # One unknown/mistyped key makes Jira reject the whole JQL — just skip the details
            logger.info(f"Ticket lookup skipped: {e}")
            return {}
        now = self.now()
        return {i['key']: normalize_issue(i, Config.JIRA_DOMAIN, Config.JIRA_FIELD_SEVERITY, now) for i in issues}

    # ── Report ───────────────────────────────────────────────
    def report(self, refresh: bool = False) -> Dict:
        day = self.today()
        tickets = self.tickets(refresh)
        state = self.store.get_day(day)
        open_keys = {t['key'] for t in tickets}
        mentioned = {k for n in state['notes'] for k in n.get('tickets') or []}
        report = build_report(
            tickets,
            day=day,
            now=self.now(),
            issue_types=Config.NDO_ISSUE_TYPES,
            stale_days=Config.NDO_STALE_DAYS,
            notes=state['notes'],
            rag_override=state['rag_override'],
            dashboard_url=Config.DASHBOARD_URL,
            jql=self.jql,
            jira_domain=Config.JIRA_DOMAIN,
            ticket_prefixes=Config.TICKET_KEY_PREFIXES,
            ticket_info=self.ticket_info(sorted(mentioned - open_keys)),
        )
        report['slack'] = self.slack_status(state)
        return report

    def snapshot_png(self, refresh: bool = False) -> bytes:
        """Dashboard preview image. One browser at a time, reused for 60s, so the endpoint can't be used to pile up Chrome processes."""
        with self._shot_lock:
            if self._shot_cache['png'] and time.time() - self._shot_cache['at'] < 60 and not refresh:
                return self._shot_cache['png']
            png = self.slack_image(self.report(refresh))
            self._shot_cache = {'at': time.time(), 'png': png}
            return png

    def slack_image(self, report: Dict) -> bytes:
        """Screenshot of the live dashboard; drawn summary card if the browser can't run."""
        try:
            return capture_dashboard()
        except SnapshotError as e:
            logger.warning(f"{e} — using the drawn summary card instead")
            return render_snapshot(report)

    # ── Developer updates ────────────────────────────────────
    def add_manual_update(self, text: str, author: str = '') -> Dict:
        """Update typed on the dashboard — rephrased the same way as Slack ones."""
        text = text.strip()
        clean, rephrased = rephrase(text)
        return self.store.add_note(self.today(), clean, author=author, extra={
            'raw_text': text, 'rephrased': rephrased, 'tickets': ticket_keys(text),
        })

    def sync_dev_updates(self) -> Dict:
        """Read today's messages from the developer updates channel into Developer Updates."""
        slack = self._slack()
        if not Config.SLACK_DEV_UPDATES_CHANNEL_ID:
            raise SlackNotConfigured('Set SLACK_DEV_UPDATES_CHANNEL_ID in backend/.env')
        day = self.today()
        with self._sync_lock:
            try:
                messages = slack.channel_messages(Config.SLACK_DEV_UPDATES_CHANNEL_ID,
                                                  oldest=self.start_of_today().timestamp())
            except SlackError as e:
                self.store.set_value(day, 'dev_sync_error', str(e))
                raise

            previous = {n['slack_ts']: n for n in self.store.notes(day) if n.get('slack_ts')}
            synced = []
            for msg in messages:
                raw = slack.plain_text(msg.get('text', ''))
                if not raw:
                    continue
                old = previous.get(msg['ts'])
                if old and old.get('raw_text') == raw:
                    text, rephrased = old['text'], old.get('rephrased', False)   # unchanged: no new AI call
                else:
                    text, rephrased = rephrase(raw)
                synced.append({
                    'slack_ts': msg['ts'],
                    'raw_text': raw,
                    'text': text,
                    'rephrased': rephrased,
                    'author': slack.user_name(msg['user']) if msg.get('user') else '',
                    'tickets': ticket_keys(raw),
                    'posted_at': datetime.fromtimestamp(float(msg['ts']), timezone.utc).isoformat(timespec='seconds'),
                })
            result = self.store.sync_slack_notes(day, synced)
            self.store.set_value(day, 'dev_synced_at', datetime.now(timezone.utc).isoformat(timespec='seconds'))
            self.store.set_value(day, 'dev_sync_error', None)
            return {**result, 'total': len(synced)}

    @staticmethod
    def _closed_ticket_brief(issue: Dict, start: datetime) -> Tuple[str, str]:
        """What the AI needs to describe a ticket closed today, plus a plain one-line fallback."""
        f = issue['fields']
        key, status, summary = issue['key'], f['status']['name'], f.get('summary') or ''

        def today(value) -> bool:
            dt = _parse_dt(value)
            return bool(dt and dt >= start)

        def clean(text: str, limit: int = 400) -> str:
            text = ' '.join(text.split())
            return text if len(text) <= limit else text[:limit].rstrip() + '…'

        lines = [f"Ticket: {key} ({f['issuetype']['name']}) — {summary}",
                 f"Final status today: {status}"]
        description = clean(adf_text(f.get('description')))
        if description:
            lines.append(f"Description: {description}")

        trail = sorted((h['created'], item.get('toString') or '')
                       for h in (issue.get('changelog') or {}).get('histories', []) if today(h.get('created'))
                       for item in h.get('items', []) if item.get('field') == 'status')
        if trail:
            lines.append('Status changes today: ' + ' → '.join(s for _, s in trail))

        comments = (f.get('comment') or {}).get('comments') or []
        # Today's comments; if nobody commented today, the last few still explain the close
        for c in [c for c in comments if today(c.get('created'))] or comments[-3:]:
            body = clean(adf_text(c.get('body')))
            if body:
                lines.append(f"Comment: {body}")

        # Only linked tickets / sub-tasks that are still open count as follow-up work
        linked = [link.get('outwardIssue') or link.get('inwardIssue') for link in f.get('issuelinks') or []]
        follow_ups = []
        for other in filter(None, linked + list(f.get('subtasks') or [])):
            fields = other.get('fields') or {}
            other_status = fields.get('status') or {}
            if (other_status.get('statusCategory') or {}).get('key') == 'done':
                continue
            lines.append(f"Open follow-up ticket: {other['key']} \"{fields.get('summary', '')}\" — "
                         f"status {other_status.get('name', 'open')}")
            follow_ups.append(f"{other['key']} ({other_status.get('name', 'open')})")

        fallback = f"{key}: closed as {status} — {summary}." + (
            f" Follow-up: {', '.join(follow_ups)}." if follow_ups else '')
        return '\n'.join(lines), fallback

    def sync_closed_tickets(self) -> Dict:
        """Tickets closed (Done / Rejected) today → updates written from the summary and today's comments."""
        day, start = self.today(), self.start_of_today()
        # "updated" is only a coarse pre-filter; the exact close time is checked below
        jql = ' AND '.join(filter(None, [
            f'project = "{Config.NDO_PROJECT_KEY}"',
            f'issuetype in ({_jql_list(Config.NDO_ISSUE_TYPES)})' if Config.NDO_ISSUE_TYPES else '',
            f'status in ({_jql_list(Config.NDO_EXCLUDED_STATUSES)})',
            'updated >= -25h',
        ]))

        with self._sync_lock:
            candidates = self.jira.search_issues(jql, ['statuscategorychangedate'])
            closed = [i['key'] for i in candidates
                      if (_parse_dt(i['fields'].get('statuscategorychangedate')) or start) > start]
            previous = {n['jira_key']: n for n in self.store.notes(day) if n.get('source') == 'jira'}
            items = []
            for key in closed:
                issue = self.jira.get_issue(key, CLOSED_TICKET_FIELDS, expand='changelog')
                f = issue['fields']
                brief, fallback = self._closed_ticket_brief(issue, start)
                old = previous.get(key)
                if old and old.get('raw_text') == brief:
                    text, rephrased = old['text'], old.get('rephrased', False)   # unchanged: no new AI call
                else:
                    text, rephrased = rephrase(brief, CLOSED_TICKET_PROMPT, fallback)
                closed_at = _parse_dt(f['statuscategorychangedate']).astimezone(timezone.utc)
                items.append({
                    'jira_key': key,
                    'raw_text': brief,
                    'text': text,
                    'rephrased': rephrased,
                    'author': (f.get('assignee') or {}).get('displayName', ''),
                    'tickets': list(dict.fromkeys([key, *ticket_keys(brief)])),
                    'posted_at': closed_at.isoformat(timespec='seconds'),
                })
            result = self.store.sync_jira_notes(day, items)
            self.store.set_value(day, 'closed_synced_at', datetime.now(timezone.utc).isoformat(timespec='seconds'))
            return {**result, 'total': len(items)}

    def sync_all_updates(self, raise_errors: bool = False) -> Dict:
        """Slack messages + tickets closed today. One source failing doesn't stop the other."""
        jobs = []
        if Config.slack_enabled() and Config.SLACK_DEV_UPDATES_CHANNEL_ID:
            jobs.append(self.sync_dev_updates)
        if Config.NDO_CLOSED_TICKET_UPDATES:
            jobs.append(self.sync_closed_tickets)
        totals = {'added': 0, 'changed': 0, 'removed': 0, 'total': 0}
        error = None
        for job in jobs:
            try:
                for k, v in job().items():
                    totals[k] = totals.get(k, 0) + v
            except Exception as e:
                logger.warning(f"{job.__name__} failed: {e}")
                error = error or e
        if error and raise_errors:
            raise error
        return totals

    def _due(self, state_key: str) -> bool:
        last = self.store.get_day(self.today()).get(state_key)
        return not last or (datetime.now(timezone.utc) - datetime.fromisoformat(last)).total_seconds() >= Config.NDO_DEV_SYNC_SECONDS

    def maybe_sync_dev_updates(self) -> None:
        """Throttled background-safe sync used when the dashboard is opened."""
        if Config.slack_enabled() and Config.SLACK_DEV_UPDATES_CHANNEL_ID and self._due('dev_synced_at'):
            try:
                self.sync_dev_updates()
            except Exception as e:
                logger.warning(f"Automatic developer-update sync failed: {e}")
        if Config.NDO_CLOSED_TICKET_UPDATES and self._due('closed_synced_at'):
            try:
                self.sync_closed_tickets()
            except Exception as e:
                logger.warning(f"Automatic closed-ticket sync failed: {e}")

    # ── Slack ────────────────────────────────────────────────
    def slack_status(self, state: Dict = None) -> Dict:
        state = state or self.store.get_day(self.today())
        return {
            'enabled': Config.slack_enabled(),
            'channel_id': Config.SLACK_CHANNEL_ID,
            'dev_channel_id': Config.SLACK_DEV_UPDATES_CHANNEL_ID,
            'ai_enabled': Config.ai_enabled(),
            'post_time': Config.NDO_POST_TIME_LABEL,
            'reminder_sent': bool(state.get('reminder_ts')),
            'posted_at': state.get('slack_posted_at'),
            'dev_synced_at': state.get('dev_synced_at'),
            'dev_sync_error': state.get('dev_sync_error'),
        }

    def _slack(self) -> SlackClient:
        if not Config.slack_enabled():
            raise SlackNotConfigured('Slack is not configured: set SLACK_BOT_TOKEN and SLACK_CHANNEL_ID in backend/.env')
        return SlackClient()

    def send_reminder(self) -> Dict:
        """One hour before the post: nudge the channel to add developer updates."""
        slack = self._slack()
        self.sync_all_updates()
        day = self.today()
        notes = self.store.notes(day)
        mention = f"{Config.SLACK_REMINDER_MENTION} " if Config.SLACK_REMINDER_MENTION else ''
        where = f"<#{Config.SLACK_DEV_UPDATES_CHANNEL_ID}>" if Config.SLACK_DEV_UPDATES_CHANNEL_ID else 'the updates channel'
        link = f" or add them on the <{Config.DASHBOARD_URL}/ndo|NDO dashboard>" if Config.DASHBOARD_URL else ''
        if notes:
            status = f"*{len(notes)}* developer update{'s' if len(notes) != 1 else ''} captured so far."
        else:
            status = (":warning: *No developer updates yet* — the daily summary will *not* be posted "
                      "without today's updates.")
        text = (f"{mention}:alarm_clock: *1 hour left* — the NDO daily summary goes out at "
                f"*{Config.NDO_POST_TIME_LABEL}*.\n{status}\n"
                f"Post today's Incident / Operations ticket updates in {where}{link}.")
        resp = slack.post_message(text, channel=Config.SLACK_REMINDER_CHANNEL_ID)
        self.store.set_value(day, 'reminder_ts', resp['ts'])
        return {'ts': resp['ts'], 'updates': len(notes)}

    def post_daily(self, force: bool = False) -> Dict:
        """
        Post today's snapshot + summary. Skips (and says so in Slack) when there are no
        developer updates for today. Refuses a second post unless force=True.
        """
        slack = self._slack()
        day = self.today()
        self.sync_all_updates()

        if not self.store.notes(day):
            state = self.store.get_day(day)
            if not state.get('skip_notice_ts') and Config.SLACK_REMINDER_CHANNEL_ID:
                link = f" Then use *Post daily update* on the <{Config.DASHBOARD_URL}/ndo|NDO dashboard>." \
                    if Config.DASHBOARD_URL else ''
                resp = slack.post_message(
                    ":no_entry: No developer updates were posted today, so the NDO daily summary was "
                    f"*not* sent.{link}",
                    channel=Config.SLACK_REMINDER_CHANNEL_ID, thread_ts=state.get('reminder_ts'))
                self.store.set_value(day, 'skip_notice_ts', resp['ts'])
            return {'posted': False, 'reason': 'no_updates',
                    'message': 'No developer updates for today — summary not posted.'}

        if not self.store.claim_daily_post(day, force=force):
            return {'posted': False, 'reason': 'already_posted',
                    'message': "Today's update was already posted (use force to post again)."}
        try:
            report = self.report(refresh=True)
            png = self.slack_image(report)
            filename = f"ndo-daily-{day}.png"
            title = f"Naar Data Operations · {report['date_label']}"
            posted = False
            if Config.SLACK_BOT_NAME:
                try:
                    slack.post_image_message(png, filename, title, slack_text(report))
                    posted = True
                except SlackError as e:
                    # Nothing reached the channel; fall back to a plain file share (bot's profile name)
                    logger.warning(f"Named image post failed, sharing the file instead: {e}")
            if not posted:
                slack.upload_image(png, filename=filename, title=title, initial_comment=slack_text(report))
        except Exception:
            self.store.release_daily_post(day)
            raise
        return {'posted': True}
