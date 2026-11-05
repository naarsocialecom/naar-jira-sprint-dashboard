"""
Minimal Slack Web API client (bot token) — no SDK dependency.

Required bot scopes:
  chat:write         post the reminder / summary
  files:write        upload the snapshot image
  channels:history   read the developer updates channel (groups:history for private channels)
  users:read         show developer names instead of user IDs (optional)
  chat:write.customize  post under SLACK_BOT_NAME instead of the bot's profile name (optional)
"""
import html
import logging
import re
import time
from typing import Dict, List, Optional

import requests

from config import Config

logger = logging.getLogger(__name__)

SLACK_API = 'https://slack.com/api'


class SlackError(RuntimeError):
    """Slack returned ok=false or the request failed."""

    HINTS = {
        'not_in_channel':  'Invite the bot to the channel: /invite @<bot name>',
        'channel_not_found': 'Check SLACK_CHANNEL_ID (use the channel ID, not its name) and invite the bot.',
        'missing_scope':   'Add the missing scope to the Slack app, then reinstall it to the workspace.',
        'invalid_auth':    'SLACK_BOT_TOKEN is invalid or revoked.',
        'not_authed':      'SLACK_BOT_TOKEN is not set.',
    }

    def __init__(self, code: str, detail: str = ''):
        self.code = code
        hint = self.HINTS.get(code, '')
        super().__init__(f"Slack error '{code}'{': ' + detail if detail else ''}{' — ' + hint if hint else ''}")


def is_user_id(target: str) -> bool:
    """A member ID (U…/W…) means a direct message to that person, not a channel."""
    return bool(target) and target[0] in 'UW'


class SlackClient:
    def __init__(self, token: str = None, channel_id: str = None):
        self.token = token or Config.SLACK_BOT_TOKEN
        self.channel_id = channel_id or Config.SLACK_CHANNEL_ID
        self.session = requests.Session()
        self.session.headers['Authorization'] = f'Bearer {self.token}'
        self._names: Dict[str, str] = {}

    def _call(self, method: str, http: str = 'POST', **kwargs) -> Dict:
        if not self.token:
            raise SlackError('not_authed')
        try:
            resp = self.session.request(http, f'{SLACK_API}/{method}', timeout=30, **kwargs)
            resp.raise_for_status()
            data = resp.json()
        except (requests.RequestException, ValueError) as e:
            logger.error(f"Slack {method} request failed: {e}")
            raise SlackError('request_failed', str(e))
        if not data.get('ok'):
            needed = data.get('needed', '')
            raise SlackError(data.get('error', 'unknown_error'), f"needs {needed}" if needed else '')
        return data

    def post_message(self, text: str, blocks: Optional[List[Dict]] = None, thread_ts: str = None,
                     channel: str = None) -> Dict:
        payload = {'channel': channel or self.channel_id, 'text': text, 'unfurl_links': False}
        if blocks:
            payload['blocks'] = blocks
        if thread_ts:
            payload['thread_ts'] = thread_ts
        # Slack keeps showing the bot's first-install profile name; a per-message name always wins
        if Config.SLACK_BOT_NAME:
            try:
                return self._call('chat.postMessage', json={**payload, 'username': Config.SLACK_BOT_NAME})
            except SlackError as e:
                if e.code != 'missing_scope':
                    raise
                logger.warning("SLACK_BOT_NAME needs the chat:write.customize scope — posting under the default bot name")
        return self._call('chat.postMessage', json=payload)

    def _upload(self, png: bytes, filename: str) -> str:
        ticket = self._call('files.getUploadURLExternal', data={'filename': filename, 'length': len(png)})
        try:
            put = requests.post(ticket['upload_url'], files={'file': (filename, png, 'image/png')}, timeout=60)
            put.raise_for_status()
        except requests.RequestException as e:
            raise SlackError('upload_failed', str(e))
        return ticket['file_id']

    def post_image_message(self, png: bytes, filename: str, title: str, text: str) -> Dict:
        """
        One message with the text and the image, sent through chat.postMessage so SLACK_BOT_NAME
        applies (a plain file share always shows the bot's profile name).
        """
        file_id = self._upload(png, filename)
        self._call('files.completeUploadExternal', json={'files': [{'id': file_id, 'title': title}]})
        chunks = [text[i:i + 2900] for i in range(0, len(text), 2900)] or [title]
        blocks = [{'type': 'section', 'text': {'type': 'mrkdwn', 'text': c}} for c in chunks]
        blocks.append({'type': 'image', 'slack_file': {'id': file_id}, 'alt_text': title})
        for attempt in range(4):
            try:
                return self.post_message(text, blocks=blocks)
            except SlackError as e:
                # The uploaded file can take a moment to be processed before a block may show it
                if e.code != 'invalid_blocks' or attempt == 3:
                    raise
                time.sleep(2)

    def upload_image(self, png: bytes, filename: str, title: str, initial_comment: str = '',
                     thread_ts: str = None) -> Dict:
        """Upload a PNG into the channel using the external upload flow."""
        complete = {
            'files': [{'id': self._upload(png, filename), 'title': title}],
            'channel_id': self.channel_id,
        }
        if initial_comment:
            complete['initial_comment'] = initial_comment
        if thread_ts:
            complete['thread_ts'] = thread_ts
        return self._call('files.completeUploadExternal', json=complete)

    @staticmethod
    def _is_human(msg: Dict) -> bool:
        return not msg.get('bot_id') and msg.get('subtype') in (None, 'thread_broadcast')

    def thread_replies(self, thread_ts: str, channel: str = None) -> List[Dict]:
        """Human replies in a thread (excludes the parent message and bot messages)."""
        replies: List[Dict] = []
        cursor = None
        while True:
            params = {'channel': channel or self.channel_id, 'ts': thread_ts, 'limit': 200}
            if cursor:
                params['cursor'] = cursor
            data = self._call('conversations.replies', http='GET', params=params)
            for msg in data.get('messages', []):
                if msg.get('ts') == thread_ts or not self._is_human(msg):
                    continue
                replies.append(msg)
            cursor = (data.get('response_metadata') or {}).get('next_cursor')
            if not cursor:
                break
        return replies

    def check(self, channels: Dict[str, str]) -> List[str]:
        """
        Read-only setup check: token, granted scopes, and read access to each channel.
        Returns problems found (empty list = all good). Posts nothing.
        """
        problems: List[str] = []
        try:
            resp = self.session.post(f'{SLACK_API}/auth.test', timeout=30)
            data = resp.json()
        except (requests.RequestException, ValueError) as e:
            return [f"Could not reach Slack: {e}"]
        if not data.get('ok'):
            return [str(SlackError(data.get('error', 'unknown_error')))]
        granted = {s.strip() for s in resp.headers.get('x-oauth-scopes', '').split(',') if s.strip()}
        logger.info(f"Bot '{data.get('user')}' in workspace '{data.get('team')}', scopes: {', '.join(sorted(granted))}")
        missing = [s for s in ('chat:write', 'files:write', 'channels:history', 'users:read') if s not in granted]
        if missing:
            problems.append(f"Missing scopes: {', '.join(missing)} — add them under OAuth & Permissions, then Reinstall to Workspace")
        for label, channel in channels.items():
            if not channel:
                problems.append(f"{label}: channel ID not set in .env")
                continue
            if is_user_id(channel):
                # Posting to a person needs only chat:write; there is no channel history to read
                logger.info(f"{label} ({channel}): direct message to a person")
                continue
            try:
                self._call('conversations.history', http='GET', params={'channel': channel, 'limit': 1})
                logger.info(f"{label} ({channel}): OK")
            except SlackError as e:
                problems.append(f"{label} ({channel}): {e}")
        return problems

    def channel_messages(self, channel: str, oldest: float) -> List[Dict]:
        """
        Human messages posted in a channel since `oldest` (unix ts), including
        thread replies, oldest first.
        """
        found: Dict[str, Dict] = {}
        parents: List[str] = []
        cursor = None
        while True:
            params = {'channel': channel, 'oldest': f'{oldest:.6f}', 'limit': 200, 'inclusive': 'true'}
            if cursor:
                params['cursor'] = cursor
            data = self._call('conversations.history', http='GET', params=params)
            for msg in data.get('messages', []):
                if msg.get('reply_count'):
                    parents.append(msg['ts'])
                if self._is_human(msg):
                    found[msg['ts']] = msg
            cursor = (data.get('response_metadata') or {}).get('next_cursor')
            if not cursor:
                break
        for parent_ts in parents:
            for reply in self.thread_replies(parent_ts, channel=channel):
                if float(reply['ts']) >= oldest:
                    found[reply['ts']] = reply
        return sorted(found.values(), key=lambda m: float(m['ts']))

    def user_name(self, user_id: str) -> str:
        """Display name for a user id; falls back to the id (needs users:read, optional)."""
        if user_id in self._names:
            return self._names[user_id]
        try:
            profile = self._call('users.info', http='GET', params={'user': user_id})['user']
            name = (profile.get('profile', {}).get('display_name')
                    or profile.get('real_name') or user_id)
        except SlackError:
            name = user_id
        self._names[user_id] = name
        return name

    def plain_text(self, text: str) -> str:
        """Slack mrkdwn → plain text: resolve <@U..> mentions, unwrap links, unescape entities."""
        def mention(m):
            return '@' + self.user_name(m.group(1))
        text = re.sub(r'<@([A-Z0-9]+)(?:\|[^>]*)?>', mention, text)
        text = re.sub(r'<#[A-Z0-9]+\|([^>]*)>', r'#\1', text)
        text = re.sub(r'<!(?:subteam\^[A-Z0-9]+\|)?([^>|]+)(?:\|[^>]*)?>', r'@\1', text)
        text = re.sub(r'<(https?://[^>|]+)\|([^>]+)>', r'\2', text)
        text = re.sub(r'<(https?://[^>]+)>', r'\1', text)
        return html.unescape(text).strip()
