"""
Rephrases a raw developer update (from Slack) into a crisp status line using
the configured AI endpoint. If the endpoint is not configured or fails, the
cleaned original text is returned, so the daily flow never blocks on AI.
"""
import hashlib
import logging
import re
from typing import List, Tuple

import requests

from config import Config

logger = logging.getLogger(__name__)

# Shared by both prompts: the summary goes to a wide channel, so no personal or customer details
PRIVACY_RULES = (
    "Privacy: never include names of people, sellers, stores, shops, brands or customers — not even when "
    "they appear in the ticket title — write 'a seller' or 'a customer' instead (e.g. 'Address update - "
    "Sunrise Textiles' becomes 'a seller's address was updated'). Never include street addresses, cities "
    "or areas, phone numbers or email addresses. Product, system and service names (like AFS or live "
    "stream) and order or ticket IDs may stay. "
)

SYSTEM_PROMPT = (
    "You rewrite developer status updates for a daily operations summary read by managers. "
    "Rewrite it as one short, plain sentence of at most 18 words, in past or present tense — "
    "the outcome or next step only, no filler like 'successfully' or 'as requested'. "
    "Keep every ticket key (like NDO-123) exactly as written. Keep numbers, dates and environments "
    "(staging, prod) exactly. " + PRIVACY_RULES +
    "Do not invent progress, causes or dates that are not in the update. "
    "If the update covers several tickets, write one such line per ticket. "
    "Reply with only the rewritten text — no preamble, no quotes, no markdown headings."
)

CLOSED_TICKET_PROMPT = (
    "You write one brief line for a daily operations summary read by managers, about a Jira ticket that "
    "was closed today. You get the ticket's details: title, type, final status, description, today's status "
    "changes, and — only when they exist — comments and open follow-up tickets. "
    "Write ONE short sentence of at most 18 words, in this shape: 'NDO-123: <what was resolved>' and, "
    "only when an open follow-up ticket is listed, '; follow-up NDO-456 (<its status>) on <topic in 3-5 words>'. "
    "Start the text after the colon with a capital letter. "
    "Example: 'NDO-101: Checkout timeout fixed; follow-up NDO-102 (To Do) on retry alerts.' "
    "Base the outcome on the comments when there are any, otherwise on the title and description. "
    "No filler like 'successfully' or 'as requested'. Never remark on anything missing — no 'no comments', "
    "'no linked tickets' or 'no follow-up'. " + PRIVACY_RULES +
    "Keep every ticket key (like NDO-123) exactly as written. Use only facts from the details — do not "
    "invent causes, fixes or dates. Reply with only the update text — no preamble, quotes, markdown or "
    "bullet points."
)


def prompt_id(system_prompt: str) -> str:
    """Short fingerprint of a prompt, stored with each rephrased text so a prompt change re-rephrases it."""
    return hashlib.sha1(system_prompt.encode('utf-8')).hexdigest()[:10]


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
    # 'NDO-12: a seller…' → 'NDO-12: A seller…'
    out = re.sub(r'^((?:[A-Z][A-Z0-9]*-\d+(?:, )?)+: )([a-z])', lambda m: m.group(1) + m.group(2).upper(), out)
    # Never lose a ticket reference, even if the model dropped one: lead with it like "NDO-12: ..."
    missing = [k for k in ticket_keys(text) if k not in ticket_keys(out)]
    if missing:
        out = f"{', '.join(missing)}: {out}"
    return out, True
