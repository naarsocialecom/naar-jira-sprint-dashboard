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
    "Rewrite the update as a brief, clear, professional sentence or two in past or present tense. "
    "Keep every ticket key (like NDO-123) exactly as written. Keep numbers, dates and environments "
    "(staging, prod) exactly. Never include names of people, sellers, stores, shops or customers — "
    "write 'a seller' or 'a customer' instead; product, system and service names (like AFS) may stay. "
    "Do not invent progress, causes or dates that are not in the update. "
    "If the update covers several tickets, write one line per ticket. "
    "Reply with only the rewritten text — no preamble, no quotes, no markdown headings."
)

CLOSED_TICKET_PROMPT = (
    "You write one brief entry for a daily operations summary read by managers, about a Jira ticket that "
    "was closed today. You get the ticket's details: title, type, final status, description, today's status "
    "changes, comments and linked tickets. Write at most two short sentences: what was resolved (or why it "
    "was rejected), treating the comments as the main source of truth; then, if any linked ticket is still "
    "open, the follow-up by its key and status. "
    "Never include names of people, sellers, stores, shops or customers — write 'a seller' or 'a customer' "
    "instead (e.g. 'stream loading fixed for Sunrise Textiles' becomes 'stream loading fixed for a seller'). "
    "Product, system and service names (like AFS or live stream) may stay. "
    "Keep every ticket key (like NDO-123) exactly as written. Use only facts from the details — do not "
    "invent causes, fixes or dates. Reply with only the update text — no preamble, quotes, markdown or "
    "bullet points."
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


def _call_endpoint(text: str, system_prompt: str) -> str:
    headers = {'Content-Type': 'application/json'}
    if Config.AI_API_KEY:
        prefix = f"{Config.AI_AUTH_PREFIX} " if Config.AI_AUTH_PREFIX else ''
        headers[Config.AI_AUTH_HEADER] = f"{prefix}{Config.AI_API_KEY}"

    if Config.AI_API_FORMAT == 'openai_chat':
        body = {
            'messages': [
                {'role': 'system', 'content': system_prompt},
                {'role': 'user', 'content': text},
            ],
        }
        if Config.AI_MODEL:
            body['model'] = Config.AI_MODEL
        path = 'choices.0.message.content'
    elif Config.AI_API_FORMAT == 'simple':
        body = {'system': system_prompt, 'prompt': text}
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


def rephrase(text: str, system_prompt: str = SYSTEM_PROMPT, fallback: str = None) -> Tuple[str, bool]:
    """
    Returns (text, rephrased). Falls back to `fallback` (default: the original text)
    when AI is off or fails.
    """
    text = text.strip()
    fallback = (fallback or text).strip()
    if not Config.ai_enabled() or len(text) < 3:
        return fallback, False
    try:
        out = _call_endpoint(text, system_prompt)
    except AIError as e:
        logger.warning(f"Rephrase failed, using fallback text: {e}")
        return fallback, False
    out = out.strip().strip('"').strip()
    # Never lose a ticket reference, even if the model dropped one
    missing = [k for k in ticket_keys(text) if k not in ticket_keys(out)]
    if missing:
        out = f"{out} ({', '.join(missing)})"
    return out, True
