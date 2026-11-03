"""
Rephrases a raw developer update (from Slack) into a crisp status line using
the configured AI endpoint. If the endpoint is not configured or fails, the
cleaned original text is returned, so the daily flow never blocks on AI.
"""
import logging
import re
from typing import List, Tuple

import requests

from config import Config

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "You rewrite developer status updates for a daily operations summary read by managers. "
    "Rewrite the update as one to three short, clear, professional sentences in past or present tense. "
    "Keep every ticket key (like NDO-123) exactly as written. Keep names, numbers, dates and environments "
    "(staging, prod) exactly. Do not invent progress, causes or dates that are not in the update. "
    "If the update covers several tickets, write one line per ticket. "
    "Reply with only the rewritten text — no preamble, no quotes, no markdown headings."
)


class AIError(RuntimeError):
    pass


def ticket_keys(text: str) -> List[str]:
    """Ticket keys in the configured projects, in order of appearance, de-duplicated."""
    prefixes = '|'.join(re.escape(p) for p in Config.TICKET_KEY_PREFIXES)
    if not prefixes:
        return []
    seen, keys = set(), []
    for key in re.findall(rf'\b(?:{prefixes})-\d+\b', text, flags=re.IGNORECASE):
        key = key.upper()
        if key not in seen:
            seen.add(key)
            keys.append(key)
    return keys


def _dig(data, path: str):
    for part in path.split('.'):
        if isinstance(data, list):
            data = data[int(part)]
        else:
            data = data[part]
    return data


def _call_endpoint(text: str) -> str:
    headers = {'Content-Type': 'application/json'}
    if Config.AI_API_KEY:
        prefix = f"{Config.AI_AUTH_PREFIX} " if Config.AI_AUTH_PREFIX else ''
        headers[Config.AI_AUTH_HEADER] = f"{prefix}{Config.AI_API_KEY}"

    if Config.AI_API_FORMAT == 'openai_chat':
        body = {
            'messages': [
                {'role': 'system', 'content': SYSTEM_PROMPT},
                {'role': 'user', 'content': text},
            ],
        }
        if Config.AI_MODEL:
            body['model'] = Config.AI_MODEL
        path = 'choices.0.message.content'
    elif Config.AI_API_FORMAT == 'simple':
        body = {'system': SYSTEM_PROMPT, 'prompt': text}
        if Config.AI_MODEL:
            body['model'] = Config.AI_MODEL
        path = Config.AI_RESPONSE_FIELD
    else:
        raise AIError(f"Unknown AI_API_FORMAT '{Config.AI_API_FORMAT}' (use openai_chat or simple)")

    try:
        resp = requests.post(Config.AI_ENDPOINT_URL, json=body, headers=headers, timeout=Config.AI_TIMEOUT_SECONDS)
        resp.raise_for_status()
        out = _dig(resp.json(), path)
    except requests.RequestException as e:
        raise AIError(f"AI endpoint request failed: {e}")
    except (ValueError, KeyError, IndexError, TypeError):
        raise AIError(f"AI endpoint response has no '{path}' field")
    if not isinstance(out, str) or not out.strip():
        raise AIError('AI endpoint returned an empty answer')
    return out.strip()


def rephrase(text: str) -> Tuple[str, bool]:
    """Returns (text, rephrased). Falls back to the original text on any failure."""
    text = text.strip()
    if not Config.ai_enabled() or len(text) < 3:
        return text, False
    try:
        out = _call_endpoint(text)
    except AIError as e:
        logger.warning(f"Rephrase failed, using original text: {e}")
        return text, False
    out = out.strip().strip('"').strip()
    # Never lose a ticket reference, even if the model dropped one
    missing = [k for k in ticket_keys(text) if k not in ticket_keys(out)]
    if missing:
        out = f"{out} ({', '.join(missing)})"
    return out, True
