"""
Small JSON-file store for the NDO daily update: team notes, RAG override and
Slack bookkeeping, grouped by report date (YYYY-MM-DD in REPORT_TIMEZONE).

Gunicorn runs several worker processes, so every read-modify-write takes an
exclusive file lock and writes atomically (temp file + rename).
"""
import fcntl
import json
import os
import tempfile
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from config import Config

KEEP_DAYS = 90
VALID_RAG = ('green', 'amber', 'red')


class NdoStore:
    def __init__(self, data_dir: Path = None):
        self.data_dir = Path(data_dir or Config.DATA_DIR)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.path = self.data_dir / 'ndo_state.json'
        self.lock_path = self.data_dir / 'ndo_state.lock'

    # ── Low-level ────────────────────────────────────────────
    @contextmanager
    def _locked(self):
        with open(self.lock_path, 'a') as lock_file:
            fcntl.flock(lock_file, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock_file, fcntl.LOCK_UN)

    def _read(self) -> Dict:
        if not self.path.exists():
            return {'days': {}}
        try:
            with open(self.path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            data.setdefault('days', {})
            return data
        except (OSError, ValueError):
            # Corrupt file: keep a copy for inspection and start fresh
            self.path.replace(self.path.with_suffix(f'.corrupt-{int(datetime.now().timestamp())}.json'))
            return {'days': {}}

    def _write(self, data: Dict) -> None:
        days = data.get('days', {})
        for old in sorted(days)[:-KEEP_DAYS]:
            days.pop(old, None)
        fd, tmp = tempfile.mkstemp(dir=self.data_dir, prefix='.ndo_state.', suffix='.tmp')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            os.replace(tmp, self.path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise

    @staticmethod
    def _day(data: Dict, day: str) -> Dict:
        entry = data['days'].setdefault(day, {})
        entry.setdefault('notes', [])
        return entry

    # ── Public API ───────────────────────────────────────────
    def get_day(self, day: str) -> Dict:
        with self._locked():
            data = self._read()
        entry = data['days'].get(day, {})
        return {
            'notes': entry.get('notes', []),
            'rag_override': entry.get('rag_override'),
            'slack_posted_at': entry.get('slack_posted_at'),
            'reminder_ts': entry.get('reminder_ts'),
            'dev_synced_at': entry.get('dev_synced_at'),
            'dev_sync_error': entry.get('dev_sync_error'),
        }

    def add_note(self, day: str, text: str, author: str = '', source: str = 'dashboard',
                 slack_ts: Optional[str] = None, extra: Optional[Dict] = None) -> Optional[Dict]:
        """Add a note. Returns None if a Slack message with this ts was already imported."""
        text = text.strip()
        if not text:
            raise ValueError('Note text is empty')
        with self._locked():
            data = self._read()
            entry = self._day(data, day)
            if slack_ts and any(n.get('slack_ts') == slack_ts for n in entry['notes']):
                return None
            note = {
                'id': uuid.uuid4().hex[:12],
                'text': text[:2000],
                'author': author.strip()[:80],
                'source': source,
                'slack_ts': slack_ts,
                'created_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
                **(extra or {}),
            }
            entry['notes'].append(note)
            self._write(data)
            return note

    def sync_slack_notes(self, day: str, messages: List[Dict]) -> Dict[str, int]:
        """
        Replace the day's Slack-sourced notes with `messages` (each: slack_ts, raw_text,
        text, author, rephrased, posted_at). Dashboard notes are left untouched.
        """
        with self._locked():
            data = self._read()
            entry = self._day(data, day)
            existing = {n['slack_ts']: n for n in entry['notes'] if n.get('slack_ts')}
            manual = [n for n in entry['notes'] if not n.get('slack_ts')]
            synced, added, changed = [], 0, 0
            for msg in messages:
                old = existing.get(msg['slack_ts'])
                if old is None:
                    added += 1
                elif old.get('raw_text') != msg['raw_text'] or old.get('text') != msg['text']:
                    changed += 1
                synced.append({
                    'id': old['id'] if old else uuid.uuid4().hex[:12],
                    'source': 'slack',
                    **msg,
                    'created_at': msg.get('posted_at') or datetime.now(timezone.utc).isoformat(timespec='seconds'),
                })
            removed = len(set(existing) - {m['slack_ts'] for m in messages})
            entry['notes'] = sorted(manual + synced, key=lambda n: n.get('created_at') or '')
            self._write(data)
            return {'added': added, 'changed': changed, 'removed': removed}

    def delete_note(self, day: str, note_id: str) -> bool:
        with self._locked():
            data = self._read()
            entry = self._day(data, day)
            before = len(entry['notes'])
            entry['notes'] = [n for n in entry['notes'] if n.get('id') != note_id]
            removed = len(entry['notes']) != before
            if removed:
                self._write(data)
            return removed

    def set_rag_override(self, day: str, level: Optional[str]) -> None:
        if level is not None and level not in VALID_RAG:
            raise ValueError(f"RAG must be one of {', '.join(VALID_RAG)} or empty")
        with self._locked():
            data = self._read()
            self._day(data, day)['rag_override'] = level
            self._write(data)

    def set_value(self, day: str, key: str, value) -> None:
        with self._locked():
            data = self._read()
            self._day(data, day)[key] = value
            self._write(data)

    def claim_daily_post(self, day: str, force: bool = False) -> bool:
        """
        Atomically mark today's Slack post as in progress so the scheduled job
        and the dashboard button can't both post. Returns False if already posted.
        """
        with self._locked():
            data = self._read()
            entry = self._day(data, day)
            if entry.get('slack_posted_at') and not force:
                return False
            entry['slack_posted_at'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
            self._write(data)
            return True

    def release_daily_post(self, day: str) -> None:
        """Undo claim_daily_post after a failed post so it can be retried."""
        self.set_value(day, 'slack_posted_at', None)

    def notes(self, day: str) -> List[Dict]:
        return self.get_day(day)['notes']
