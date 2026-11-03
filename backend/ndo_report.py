"""
NDO (Naar Data / Operations) report — pure logic, no Flask, no I/O.

  normalize_issue()  Jira issue JSON  → flat ticket dict
  build_report()     tickets + notes  → report dict (RAG, highlights, breakdowns)
  slack_text()       report           → Slack mrkdwn message
"""
import re
from collections import Counter, OrderedDict
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

PRIORITY_ORDER = ['Critical', 'Highest', 'High', 'Medium', 'Low', 'Lowest', 'None']
SEVERITY_ORDER = ['Sev-0', 'Sev-1', 'Sev-2', 'Sev-3', 'Not set']
URGENT_PRIORITIES = {'Critical', 'Highest', 'High'}
CRITICAL_PRIORITIES = {'Critical', 'Highest'}
CRITICAL_SEVERITIES = {'Sev-0', 'Sev-1'}
ON_HOLD_STATUSES = {'on-hold', 'on hold', 'blocked'}

RAG_LABELS = {'green': 'On Track', 'amber': 'Moderate', 'red': 'Critical'}
RAG_EMOJI = {'green': ':large_green_circle:', 'amber': ':large_orange_circle:', 'red': ':red_circle:'}

INCIDENT = 'Incident'


def _parse_dt(value: str) -> Optional[datetime]:
    if not value:
        return None
    try:
        # Jira: 2026-11-03T10:15:30.123+0400
        return datetime.strptime(value, '%Y-%m-%dT%H:%M:%S.%f%z')
    except ValueError:
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return None


def _option_value(raw) -> Optional[str]:
    if raw is None:
        return None
    if isinstance(raw, list):
        return ', '.join(filter(None, (_option_value(r) for r in raw))) or None
    if isinstance(raw, dict):
        return raw.get('value') or raw.get('name')
    return str(raw)


def _rank(value: str, order: List[str]) -> int:
    return order.index(value) if value in order else len(order)


def _plural(n: int, word: str, plural: str = None) -> str:
    return f"{n} {word if n == 1 else (plural or word + 's')}"


def _short(text: str, limit: int = 60) -> str:
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(' ', 1)[0].rstrip(' -:,;') + '…'


# Severity mapped onto the priority scale, so a Sev-0 "Medium" still sorts with Critical
_SEVERITY_AS_PRIORITY = {'Sev-0': 'Critical', 'Sev-1': 'High', 'Sev-2': 'Medium', 'Sev-3': 'Low'}


def _urgency(t: Dict) -> int:
    by_severity = _SEVERITY_AS_PRIORITY.get(t['severity'])
    ranks = [_rank(t['priority'], PRIORITY_ORDER)]
    if by_severity:
        ranks.append(_rank(by_severity, PRIORITY_ORDER))
    return min(ranks)


def normalize_issue(issue: Dict, jira_domain: str, severity_field: str, now: datetime) -> Dict:
    f = issue.get('fields', {})
    created = _parse_dt(f.get('created'))
    updated = _parse_dt(f.get('updated'))
    status = f.get('status') or {}
    return {
        'key': issue.get('key', ''),
        'url': f"{jira_domain}/browse/{issue.get('key', '')}",
        'type': (f.get('issuetype') or {}).get('name', 'Unknown'),
        'summary': (f.get('summary') or '').strip(),
        'status': status.get('name', 'Unknown'),
        'status_category': (status.get('statusCategory') or {}).get('key', ''),
        'priority': (f.get('priority') or {}).get('name') or 'None',
        'severity': (_option_value(f.get(severity_field)) if severity_field else None) or 'Not set',
        'assignee': (f.get('assignee') or {}).get('displayName'),
        'created': created.isoformat() if created else None,
        'updated': updated.isoformat() if updated else None,
        'age_days': (now - created).days if created else None,
        'idle_days': (now - updated).days if updated else None,
    }


def _ordered_counts(counter: Counter, order: List[str]) -> 'OrderedDict[str, int]':
    keys = sorted(counter, key=lambda k: (_rank(k, order), k))
    return OrderedDict((k, counter[k]) for k in keys)


def _status_phrase(tickets: List[Dict]) -> str:
    counts = Counter(t['status'] for t in tickets)
    return ', '.join(f"{n} {s}" for s, n in counts.most_common())


def _is_critical(t: Dict) -> bool:
    return t['priority'] in CRITICAL_PRIORITIES or t['severity'] in CRITICAL_SEVERITIES


def compute_rag(tickets: List[Dict], stale_days: int) -> Dict:
    incidents = [t for t in tickets if t['type'] == INCIDENT]
    others = [t for t in tickets if t['type'] != INCIDENT]
    critical_inc = [t for t in incidents if _is_critical(t)]
    urgent_ops = [t for t in others if t['priority'] in URGENT_PRIORITIES]
    unassigned_urgent = [t for t in tickets if not t['assignee']
                         and (t['priority'] in URGENT_PRIORITIES or t['type'] == INCIDENT)]
    stale = [t for t in tickets if (t['idle_days'] or 0) >= stale_days]

    red, amber = [], []
    if critical_inc:
        red.append(f"{_plural(len(critical_inc), 'critical incident')} open")
    if len(critical_inc) == 0 and incidents:
        amber.append(f"{_plural(len(incidents), 'incident')} open, none critical")
    if urgent_ops:
        amber.append(f"{_plural(len(urgent_ops), 'high-priority operations ticket')} open")
    if unassigned_urgent:
        amber.append(f"{_plural(len(unassigned_urgent), 'urgent ticket')} unassigned")
    if stale and len(stale) >= max(5, len(tickets) // 4):
        amber.append(f"{_plural(len(stale), 'ticket')} idle for {stale_days}+ days")

    if red:
        level, reasons = 'red', red + amber
    elif amber:
        level, reasons = 'amber', amber
    else:
        level, reasons = 'green', ['No incidents or high-priority operations tickets open']
    return {'level': level, 'reasons': reasons}


def build_highlights(tickets: List[Dict], now: datetime, stale_days: int) -> List[str]:
    incidents = [t for t in tickets if t['type'] == INCIDENT]
    others = [t for t in tickets if t['type'] != INCIDENT]
    lines = []

    critical_inc = [t for t in incidents if _is_critical(t)]
    if critical_inc:
        lines.append(f"{_plural(len(critical_inc), 'critical incident')} need attention: "
                     + '; '.join(f"{t['key']} {_short(t['summary'], 45)}" for t in critical_inc[:3]))
    else:
        lines.append('No critical incidents open today')

    if incidents:
        lines.append(f"{_plural(len(incidents), 'Incident')} open — {_status_phrase(incidents)}")
    else:
        lines.append('No open Incidents')

    by_type = Counter(t['type'] for t in others)
    for type_name, n in by_type.most_common():
        group = [t for t in others if t['type'] == type_name]
        lines.append(f"{n} {type_name} tickets open — {_status_phrase(group)}")

    since = now - timedelta(days=1)
    new = [t for t in tickets if t['created'] and datetime.fromisoformat(t['created']) >= since]
    moved = [t for t in tickets if t['updated'] and datetime.fromisoformat(t['updated']) >= since]
    if new:
        lines.append(f"{_plural(len(new), 'new ticket')} raised in the last 24h "
                     f"({', '.join(t['key'] for t in new[:5])}{'…' if len(new) > 5 else ''})")
    else:
        lines.append('No new tickets raised in the last 24h')
    if moved:
        lines.append(f"{_plural(len(moved), 'ticket')} updated in the last 24h")

    on_hold = [t for t in tickets if t['status'].lower() in ON_HOLD_STATUSES]
    if on_hold:
        lines.append(f"{_plural(len(on_hold), 'ticket')} On-hold / Blocked")

    unassigned = [t for t in tickets if not t['assignee']]
    if unassigned:
        inc_un = sum(1 for t in unassigned if t['type'] == INCIDENT)
        lines.append(f"{_plural(len(unassigned), 'ticket')} unassigned"
                     + (f" (incl. {_plural(inc_un, 'incident')})" if inc_un else ''))

    stale = sorted((t for t in tickets if (t['idle_days'] or 0) >= stale_days),
                   key=lambda t: -(t['idle_days'] or 0))
    if stale:
        lines.append(f"{_plural(len(stale), 'ticket')} with no update for {stale_days}+ days — "
                     f"longest idle {stale[0]['key']} ({stale[0]['idle_days']}d)")
    return lines


def key_tickets(tickets: List[Dict], limit: int = 15) -> List[Dict]:
    """Incidents and high-priority tickets, most severe first."""
    chosen = [t for t in tickets if t['type'] == INCIDENT or t['priority'] in URGENT_PRIORITIES]
    chosen.sort(key=lambda t: (
        _urgency(t),
        _rank(t['priority'], PRIORITY_ORDER),
        _rank(t['severity'], SEVERITY_ORDER),
        0 if t['type'] == INCIDENT else 1,
        t['created'] or '',
    ))
    return chosen[:limit]


def dev_updates(notes: List[Dict], ticket_info: Dict[str, Dict], jira_domain: str) -> List[Dict]:
    """Attach current Jira status + link to every ticket key mentioned in an update."""
    out = []
    for note in notes:
        refs = []
        for key in note.get('tickets') or []:
            info = ticket_info.get(key, {})
            refs.append({
                'key': key,
                'url': f"{jira_domain}/browse/{key}",
                'type': info.get('type'),
                'summary': info.get('summary'),
                'status': info.get('status'),
                'priority': info.get('priority'),
                'severity': info.get('severity') if info.get('severity') != 'Not set' else None,
                'assignee': info.get('assignee'),
            })
        out.append({**note, 'ticket_refs': refs})
    return out


def build_report(tickets: List[Dict], *, day: str, now: datetime, issue_types: List[str],
                 stale_days: int, notes: List[Dict] = None, rag_override: str = None,
                 dashboard_url: str = '', jql: str = '', jira_domain: str = '',
                 ticket_prefixes: List[str] = None, ticket_info: Dict[str, Dict] = None) -> Dict:
    types = list(issue_types) + sorted({t['type'] for t in tickets} - set(issue_types))
    by_type = Counter(t['type'] for t in tickets)

    priority = OrderedDict()
    for p in _ordered_counts(Counter(t['priority'] for t in tickets), PRIORITY_ORDER):
        priority[p] = {ty: sum(1 for t in tickets if t['type'] == ty and t['priority'] == p) for ty in types}

    severity_counter = Counter(t['severity'] for t in tickets if t['type'] == INCIDENT)
    for s in SEVERITY_ORDER:
        severity_counter.setdefault(s, 0)

    status = OrderedDict()
    for s, _ in Counter(t['status'] for t in tickets).most_common():
        status[s] = {ty: sum(1 for t in tickets if t['type'] == ty and t['status'] == s) for ty in types}

    auto_rag = compute_rag(tickets, stale_days)
    level = rag_override or auto_rag['level']

    return {
        'day': day,
        'generated_at': now.isoformat(timespec='seconds'),
        'date_label': now.strftime('%-d %b %Y'),
        'jql': jql,
        'dashboard_url': dashboard_url,
        'jira_browse_url': f"{jira_domain}/browse/",
        'ticket_prefixes': ticket_prefixes or [],
        'issue_types': types,
        'totals': {
            'total': len(tickets),
            'by_type': {ty: by_type.get(ty, 0) for ty in types},
            'critical_high': sum(1 for t in tickets if t['priority'] in URGENT_PRIORITIES
                                 or t['severity'] in CRITICAL_SEVERITIES),
            'unassigned': sum(1 for t in tickets if not t['assignee']),
            'new_24h': sum(1 for t in tickets if t['created']
                           and datetime.fromisoformat(t['created']) >= now - timedelta(days=1)),
        },
        'rag': {
            'level': level,
            'label': RAG_LABELS[level],
            'auto_level': auto_rag['level'],
            'overridden': bool(rag_override),
            'reasons': auto_rag['reasons'],
        },
        'highlights': build_highlights(tickets, now, stale_days),
        'dev_updates': dev_updates(notes or [], {**{t['key']: t for t in tickets}, **(ticket_info or {})},
                                   jira_domain),
        'key_tickets': key_tickets(tickets),
        'breakdown': {
            'priority': priority,
            'severity': _ordered_counts(severity_counter, SEVERITY_ORDER),
            'status': status,
        },
        'tickets': sorted(tickets, key=lambda t: (
            _urgency(t), 0 if t['type'] == INCIDENT else 1, t['created'] or '')),
    }


def _slack_escape(text: str) -> str:
    return text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def _slack_rich(text: str, report: Dict) -> str:
    """Escape for Slack and turn ticket keys into Jira links."""
    text = _slack_escape(text)
    prefixes = '|'.join(re.escape(p) for p in report.get('ticket_prefixes') or [])
    if not prefixes:
        return text
    base = report['jira_browse_url']
    return re.sub(rf'\b((?:{prefixes})-\d+)\b', lambda m: f"<{base}{m.group(1)}|{m.group(1)}>", text)


def slack_text(report: Dict) -> str:
    """Short Slack message posted with the dashboard screenshot — the image carries the detail."""
    rag = report['rag']
    totals = report['totals']
    counts = ' · '.join(f"*{n}* {ty}{'' if n == 1 or ty.endswith('s') else 's'}"
                        for ty, n in totals['by_type'].items())
    lines = [
        f"*Naar Data Operations — {report['date_label']}*",
        f"{RAG_EMOJI[rag['level']]} *{rag['label']}* · {counts} · *{totals['critical_high']}* Critical/High"
        f" · *{totals['unassigned']}* Unassigned",
    ]

    if report['dev_updates']:
        lines += ['', '*Developer updates*']
        for note in report['dev_updates']:
            refs = [r for r in note['ticket_refs'] if r.get('status')]
            if len(refs) == 1:
                status = f" · _{refs[0]['status']}_"
            elif refs:
                status = ' · _' + ', '.join(f"{r['key']} {r['status']}" for r in refs) + '_'
            else:
                status = ''
            author = f" — {_slack_escape(note['author'])}" if note.get('author') else ''
            lines.append(f"• {_slack_rich(note['text'], report)}{status}{author}")

    critical = [t for t in report['key_tickets'] if _urgency(t) == 0]
    if critical:
        lines += ['', '*Needs attention*']
        for t in critical[:3]:
            details = ' · '.join(filter(None, [
                t['status'],
                t['severity'] if t['severity'] != 'Not set' else t['priority'],
                t['assignee'] or 'Unassigned',
            ]))
            lines.append(f"• <{t['url']}|{t['key']}> {_slack_escape(_short(t['summary'], 40))} — _{_slack_escape(details)}_")
        if len(critical) > 3:
            lines.append(f"_+{len(critical) - 3} more on the dashboard_")

    if report.get('dashboard_url'):
        lines += ['', f"<{report['dashboard_url']}/ndo|View full dashboard →>"]
    return '\n'.join(lines)
