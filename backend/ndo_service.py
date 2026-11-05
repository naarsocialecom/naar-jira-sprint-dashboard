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
import hashlib
import math
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Tuple

from zoneinfo import ZoneInfo

from ai_rephrase import CLOSED_TICKET_PROMPT, DIGEST_PROMPT, SYSTEM_PROMPT, prompt_id, rephrase, summarize, ticket_keys
from config import Config
from dashboard_snapshot import SnapshotError, capture_dashboard
from jira_apis import JiraClient
from ndo_report import _parse_dt, adf_text, build_report, normalize_issue, slack_text
from ndo_snapshot import render_snapshot
from ndo_store import NdoStore
from slack_client import SlackClient, SlackError, is_user_id

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

    def resolve_day(self, day: str = None) -> str:
        """Validated 'YYYY-MM-DD' (default today); past days up to NDO_HISTORY_DAYS back."""
        if not day:
            return self.today()
        try:
            date = datetime.strptime(day, '%Y-%m-%d').date()
        except ValueError:
            raise ValueError('day must look like 2026-11-03')
        today = self.now().date()
        if date > today or (today - date).days > Config.NDO_HISTORY_DAYS:
            raise ValueError(f'day must be within the last {Config.NDO_HISTORY_DAYS} days')
        return day

    def day_window(self, day: str):
        """[start, end) of a calendar day in REPORT_TIMEZONE."""
        start = datetime.strptime(day, '%Y-%m-%d').replace(tzinfo=self.tz)
        return start, start + timedelta(days=1)

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
    def report(self, refresh: bool = False, day: str = None) -> Dict:
        day = self.resolve_day(day)
        past = day != self.today()
        tickets = self.tickets(refresh)
        state = self.store.get_day(day)
        open_keys = {t['key'] for t in tickets}
        mentioned = {k for n in state['notes'] for k in n.get('tickets') or []}
        report = build_report(
            tickets,
            day=day,
            # A past day is labelled as that day; tickets are always Jira's current state
            now=self.day_window(day)[1] - timedelta(seconds=1) if past else self.now(),
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
        report['digest'] = self._digest(day, report['dev_updates'])
        report['is_today'] = not past
        return report

    @staticmethod
    def _digest_key(texts: List[str]) -> str:
        return hashlib.sha1(('\n'.join(texts) + prompt_id(DIGEST_PROMPT)).encode('utf-8')).hexdigest()[:12]

    def _digest(self, day: str, notes: List[Dict]) -> List[str]:
        """The day's updates condensed to a few grouped lines; re-made only when the updates change."""
        texts = [n['text'] for n in sorted(notes, key=lambda n: n.get('created_at') or '')]
        if not texts:
            return []
        key = self._digest_key(texts)
        saved = self.store.get_day(day).get('digest') or {}
        if saved.get('key') == key:
            return saved['lines']
        lines, by_ai = summarize(texts)
        if by_ai:   # a fallback list isn't stored, so the AI is tried again next time
            self.store.set_value(day, 'digest', {'key': key, 'lines': lines})
        return lines

    def snapshot_png(self, refresh: bool = False, day: str = None) -> bytes:
        """Dashboard preview image. One browser at a time, reused for 60s, so the endpoint can't be used to pile up Chrome processes."""
        with self._shot_lock:
            day = self.resolve_day(day)
            cache = self._shot_cache
            if cache['png'] and cache.get('day') == day and time.time() - cache['at'] < 60 and not refresh:
                return cache['png']
            png = self.slack_image(self.report(refresh, day=day))
            self._shot_cache = {'at': time.time(), 'png': png, 'day': day}
            return png

    def slack_image(self, report: Dict) -> bytes:
        """Screenshot of the live dashboard; drawn summary card if the browser can't run."""
        try:
            return capture_dashboard(None if report.get('is_today', True) else report['day'])
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

    def copy_updates(self, from_day: str) -> Dict:
        """Copy a past day's updates into today (as dashboard updates), e.g. to re-send a day that went out wrong."""
        from_day, day = self.resolve_day(from_day), self.today()
        if from_day == day:
            raise ValueError('Pick a past day to copy from')
        already = {(n.get('copied_from'), n['text']) for n in self.store.notes(day)}
        copied = 0
        for n in sorted(self.store.notes(from_day), key=lambda n: n.get('created_at') or ''):
            if (from_day, n['text']) in already:
                continue
            # Only the final text travels: Jira briefs (raw_text) can hold customer details
            self.store.add_note(day, n['text'], extra={
                'raw_text': n['text'], 'rephrased': n.get('rephrased', False),
                'tickets': n.get('tickets') or [], 'copied_from': from_day,
            })
            copied += 1
        # Same updates → keep the source day's summary word for word (instead of a fresh AI wording)
        source_digest = (self.store.get_day(from_day).get('digest') or {}).get('lines')
        today_notes = sorted(self.store.notes(day), key=lambda n: n.get('created_at') or '')
        if source_digest and all(n.get('copied_from') == from_day for n in today_notes):
            self.store.set_value(day, 'digest', {'key': self._digest_key([n['text'] for n in today_notes]),
                                                 'lines': source_digest})
        return {'copied': copied, 'from': from_day, 'to': day}

    def sync_dev_updates(self, day: str = None) -> Dict:
        """Read a day's messages (default today) from the developer updates channel into Developer Updates."""
        slack = self._slack()
        if not Config.SLACK_DEV_UPDATES_CHANNEL_ID:
            raise SlackNotConfigured('Set SLACK_DEV_UPDATES_CHANNEL_ID in backend/.env')
        day = self.resolve_day(day)
        start, end = self.day_window(day)
        with self._sync_lock:
            try:
                messages = slack.channel_messages(Config.SLACK_DEV_UPDATES_CHANNEL_ID, oldest=start.timestamp())
            except SlackError as e:
                self.store.set_value(day, 'dev_sync_error', str(e))
                raise
            messages = [m for m in messages if float(m['ts']) < end.timestamp()]

            previous = {n['slack_ts']: n for n in self.store.notes(day) if n.get('slack_ts')}
            synced = []
            for msg in messages:
                raw = slack.plain_text(msg.get('text', ''))
                if not raw:
                    continue
                old = previous.get(msg['ts'])
                if old and old.get('raw_text') == raw and old.get('prompt_id') == prompt_id(SYSTEM_PROMPT):
                    text, rephrased = old['text'], old.get('rephrased', False)   # unchanged: no new AI call
                else:
                    text, rephrased = rephrase(raw)
                synced.append({
                    'slack_ts': msg['ts'],
                    'raw_text': raw,
                    'text': text,
                    'rephrased': rephrased,
                    'prompt_id': prompt_id(SYSTEM_PROMPT),
                    'author': slack.user_name(msg['user']) if msg.get('user') else '',
                    'tickets': ticket_keys(raw),
                    'posted_at': datetime.fromtimestamp(float(msg['ts']), timezone.utc).isoformat(timespec='seconds'),
                })
            result = self.store.sync_slack_notes(day, synced)
            self.store.set_value(day, 'dev_synced_at', datetime.now(timezone.utc).isoformat(timespec='seconds'))
            self.store.set_value(day, 'dev_sync_error', None)
            return {**result, 'total': len(synced)}

    @staticmethod
    def _closed_ticket_brief(issue: Dict, start: datetime, end: datetime = None) -> Tuple[str, str]:
        """What the AI needs to describe a ticket closed on the day [start, end), plus a plain one-line fallback."""
        f = issue['fields']
        key, status, summary = issue['key'], f['status']['name'], f.get('summary') or ''

        def today(value) -> bool:
            dt = _parse_dt(value)
            return bool(dt and dt >= start and (end is None or dt < end))

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

    def sync_closed_tickets(self, day: str = None) -> Dict:
        """Tickets closed (Done / Rejected) on a day (default today) → updates from the summary and that day's comments."""
        day = self.resolve_day(day)
        start, end = self.day_window(day)
        hours_back = math.ceil((self.now() - start).total_seconds() / 3600) + 1
        # "updated" is only a coarse pre-filter; the exact close time is checked below
        jql = ' AND '.join(filter(None, [
            f'project = "{Config.NDO_PROJECT_KEY}"',
            f'issuetype in ({_jql_list(Config.NDO_ISSUE_TYPES)})' if Config.NDO_ISSUE_TYPES else '',
            f'status in ({_jql_list(Config.NDO_EXCLUDED_STATUSES)})',
            f'updated >= -{hours_back}h',
        ]))

        def closed_on_day(issue) -> bool:
            dt = _parse_dt(issue['fields'].get('statuscategorychangedate'))
            return bool(dt and start <= dt < end)

        with self._sync_lock:
            candidates = self.jira.search_issues(jql, ['statuscategorychangedate'])
            closed = [i['key'] for i in candidates if closed_on_day(i)]
            previous = {n['jira_key']: n for n in self.store.notes(day) if n.get('source') == 'jira'}
            items = []
            for key in closed:
                issue = self.jira.get_issue(key, CLOSED_TICKET_FIELDS, expand='changelog')
                f = issue['fields']
                brief, fallback = self._closed_ticket_brief(issue, start, end)
                old = previous.get(key)
                if old and old.get('raw_text') == brief and old.get('prompt_id') == prompt_id(CLOSED_TICKET_PROMPT):
                    text, rephrased = old['text'], old.get('rephrased', False)   # unchanged: no new AI call
                else:
                    text, rephrased = rephrase(brief, CLOSED_TICKET_PROMPT, fallback)
                closed_at = _parse_dt(f['statuscategorychangedate']).astimezone(timezone.utc)
                items.append({
                    'jira_key': key,
                    'raw_text': brief,
                    'text': text,
                    'rephrased': rephrased,
                    'prompt_id': prompt_id(CLOSED_TICKET_PROMPT),
                    'author': (f.get('assignee') or {}).get('displayName', ''),
                    'tickets': list(dict.fromkeys([key, *ticket_keys(brief)])),
                    'posted_at': closed_at.isoformat(timespec='seconds'),
                })
            result = self.store.sync_jira_notes(day, items)
            self.store.set_value(day, 'closed_synced_at', datetime.now(timezone.utc).isoformat(timespec='seconds'))
            return {**result, 'total': len(items)}

    def sync_all_updates(self, raise_errors: bool = False, day: str = None) -> Dict:
        """Slack messages + tickets closed on a day (default today). One source failing doesn't stop the other."""
        jobs = []
        if Config.slack_enabled() and Config.SLACK_DEV_UPDATES_CHANNEL_ID:
            jobs.append(self.sync_dev_updates)
        if Config.NDO_CLOSED_TICKET_UPDATES:
            jobs.append(self.sync_closed_tickets)
        totals = {'added': 0, 'changed': 0, 'removed': 0, 'total': 0}
        error = None
        for job in jobs:
            try:
                for k, v in job(day).items():
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
            'post_without_updates': Config.NDO_POST_WITHOUT_UPDATES,
            'reminder_sent': bool(state.get('reminder_ts')),
            # Only a post to the current summary channel counts (not an earlier test post elsewhere)
            'posted_at': state.get('slack_posted_at')
            if state.get('slack_posted_channel') in (None, Config.SLACK_CHANNEL_ID) else None,
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
        elif Config.NDO_POST_WITHOUT_UPDATES:
            status = (":warning: *No developer updates yet* — if none come in, the summary goes out "
                      "saying _No updates from developers_.")
        else:
            status = (":warning: *No developer updates yet* — the daily summary will *not* be posted "
                      "without today's updates.")
        text = (f"{mention}:alarm_clock: *1 hour left* — the NDO daily summary goes out at "
                f"*{Config.NDO_POST_TIME_LABEL}*.\n{status}\n"
                f"Post today's Incident / Operations ticket updates in {where}{link}.")
        resp = slack.post_message(text, channel=Config.SLACK_REMINDER_CHANNEL_ID)
        self.store.set_value(day, 'reminder_ts', resp['ts'])
        return {'ts': resp['ts'], 'updates': len(notes)}

    def post_daily(self, force: bool = False, day: str = None) -> Dict:
        """
        Post a day's (default today) snapshot + summary. With no developer updates it either posts
        "No updates from developers" (NDO_POST_WITHOUT_UPDATES) or skips and says so.
        Refuses a second post unless force=True.
        """
        slack = self._slack()
        day = self.resolve_day(day)
        self.sync_all_updates(day=day)

        if not self.store.notes(day) and not Config.NDO_POST_WITHOUT_UPDATES:
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

        if not self.store.claim_daily_post(day, Config.SLACK_CHANNEL_ID, force=force):
            return {'posted': False, 'reason': 'already_posted',
                    'message': "Today's update was already posted (use force to post again)."}
        try:
            report = self.report(refresh=True, day=day)
            png = self.slack_image(report)
            filename = f"ndo-daily-{day}.png"
            title = f"Naar Data Operations · {report['date_label']}"
            posted = False
            if is_user_id(Config.SLACK_CHANNEL_ID):
                # A person (DM): only chat.postMessage takes a user ID, the file-share call needs a channel
                slack.post_image_message(png, filename, title, slack_text(report))
                posted = True
            elif Config.SLACK_BOT_NAME:
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
