"""
Application configuration.

Every value comes from the environment, loaded from ``backend/.env``.
Nothing deployment-specific (domains, credentials, IDs) is hardcoded here —
copy ``.env.example`` to ``.env`` and fill it in.
"""
import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent

# Load backend/.env regardless of the working directory the app is started from.
# Real environment variables (e.g. from systemd EnvironmentFile) take precedence.
load_dotenv(BASE_DIR / '.env', override=False)


class ConfigError(RuntimeError):
    """Raised when a required environment variable is missing or invalid."""


def _get(name: str, default: str = '') -> str:
    return (os.getenv(name) or default).strip()


def _required(name: str) -> str:
    value = _get(name)
    if not value:
        raise ConfigError(
            f"Missing required environment variable '{name}'. "
            f"Add it to {BASE_DIR / '.env'} (see .env.example)."
        )
    return value


def _bool(name: str, default: bool = False) -> bool:
    value = _get(name)
    if not value:
        return default
    return value.lower() in ('1', 'true', 'yes', 'on')


def _int(name: str, default: int) -> int:
    value = _get(name)
    if not value:
        return default
    try:
        return int(value)
    except ValueError:
        raise ConfigError(f"Environment variable '{name}' must be an integer, got '{value}'.")


def _list(name: str, default: str = '') -> list:
    return [item.strip() for item in _get(name, default).split(',') if item.strip()]


class Config:
    """Base configuration"""
    APP_ENV = _get('APP_ENV') or _get('FLASK_ENV', 'production')

    # Jira connection (required)
    JIRA_DOMAIN = _required('JIRA_DOMAIN').rstrip('/')
    JIRA_EMAIL = _required('JIRA_EMAIL')
    JIRA_API_TOKEN = _required('JIRA_API_TOKEN')
    JIRA_TIMEOUT_SECONDS = _int('JIRA_TIMEOUT_SECONDS', 30)

    # Sprint dashboard
    JIRA_BOARD_ID = _required('JIRA_BOARD_ID')
    JIRA_PROJECT_KEY = _required('JIRA_PROJECT_KEY')
    EPIC_TABLE_PAGE_SIZE = _int('EPIC_TABLE_PAGE_SIZE', 10)
    JIRA_FIELD_PLATFORM = _get('JIRA_FIELD_PLATFORM')
    JIRA_FIELD_HIGHLIGHTS = _get('JIRA_FIELD_HIGHLIGHTS')
    JIRA_HIGHLIGHTS_TICKET = _get('JIRA_HIGHLIGHTS_TICKET')

    # Naar Data / Operations (NDO) page
    NDO_PROJECT_KEY = _get('NDO_PROJECT_KEY', 'NDO')
    NDO_ISSUE_TYPES = _list('NDO_ISSUE_TYPES', 'Incident,Operations')
    NDO_EXCLUDED_STATUSES = _list('NDO_EXCLUDED_STATUSES', 'Done,Rejected')
    JIRA_FIELD_SEVERITY = _get('JIRA_FIELD_SEVERITY')
    NDO_STALE_DAYS = _int('NDO_STALE_DAYS', 14)
    NDO_CACHE_SECONDS = _int('NDO_CACHE_SECONDS', 120)
    # Tickets moved to an excluded status (Done / Rejected) today become developer updates,
    # written by the AI from the ticket summary and its comments
    NDO_CLOSED_TICKET_UPDATES = _bool('NDO_CLOSED_TICKET_UPDATES', True)
    REPORT_TIMEZONE = _get('REPORT_TIMEZONE', 'Asia/Kolkata')
    DASHBOARD_URL = _get('DASHBOARD_URL').rstrip('/')

    # Ticket keys in these projects are turned into Jira links in updates
    TICKET_KEY_PREFIXES = _list('TICKET_KEY_PREFIXES') or sorted({NDO_PROJECT_KEY, JIRA_PROJECT_KEY})

    # Slack (optional — Slack features are disabled until token + summary channel are set)
    SLACK_BOT_TOKEN = _get('SLACK_BOT_TOKEN')
    # Name shown on the bot's messages (needs the chat:write.customize scope). Blank = bot profile name
    SLACK_BOT_NAME = _get('SLACK_BOT_NAME')
    # Channel the daily summary is posted to
    SLACK_CHANNEL_ID = _get('SLACK_CHANNEL_ID')
    # Channel developers post their updates in (read + rephrased into "Developer Updates")
    SLACK_DEV_UPDATES_CHANNEL_ID = _get('SLACK_DEV_UPDATES_CHANNEL_ID')
    # Channel for the "1 hour left" reminder (defaults to the developer updates channel)
    SLACK_REMINDER_CHANNEL_ID = _get('SLACK_REMINDER_CHANNEL_ID') or SLACK_DEV_UPDATES_CHANNEL_ID or SLACK_CHANNEL_ID
    SLACK_REMINDER_MENTION = _get('SLACK_REMINDER_MENTION') or _get('SLACK_PROMPT_MENTION')
    # Shown in the reminder text only — the schedule itself lives in cron / systemd timers
    NDO_POST_TIME_LABEL = _get('NDO_POST_TIME_LABEL', '7:00 PM IST')
    # Minimum seconds between automatic Slack fetches when the dashboard is opened
    NDO_DEV_SYNC_SECONDS = _int('NDO_DEV_SYNC_SECONDS', 300)

    # Slack image = real screenshot of the /ndo page (header, tiles, Highlights), taken with
    # headless Chromium via Playwright. Falls back to a drawn summary card if that fails.
    # Where the screenshot job can reach this app (the app must be running)
    SNAPSHOT_BASE_URL = (_get('SNAPSHOT_BASE_URL') or f"http://127.0.0.1:{_int('PORT', 5005)}").rstrip('/')
    # Blank = Playwright's bundled Chromium; "chrome" = use the installed Google Chrome
    SNAPSHOT_BROWSER_CHANNEL = _get('SNAPSHOT_BROWSER_CHANNEL')
    SNAPSHOT_WIDTH = _int('SNAPSHOT_WIDTH', 1600)

    # AI endpoint used to rephrase developer updates (optional — raw text is used if unset)
    AI_ENDPOINT_URL = _get('AI_ENDPOINT_URL')
    AI_API_KEY = _get('AI_API_KEY')
    # openai_chat  → POST {model, messages}  → choices[0].message.content
    # simple       → POST {prompt, system}    → value at AI_RESPONSE_FIELD (dot path, e.g. data.text)
    AI_API_FORMAT = _get('AI_API_FORMAT', 'openai_chat').lower()
    AI_MODEL = _get('AI_MODEL')
    AI_AUTH_HEADER = _get('AI_AUTH_HEADER', 'Authorization')
    # Set to empty (AI_AUTH_PREFIX=) for Azure's "api-key: <key>" header, which has no prefix
    AI_AUTH_PREFIX = os.getenv('AI_AUTH_PREFIX', 'Bearer').strip()
    AI_RESPONSE_FIELD = _get('AI_RESPONSE_FIELD', 'text')
    AI_TIMEOUT_SECONDS = _int('AI_TIMEOUT_SECONDS', 30)

    # Storage / logs
    DATA_DIR = Path(_get('DATA_DIR') or BASE_DIR / 'data')
    LOG_DIR = Path(_get('LOG_DIR') or BASE_DIR / 'logs')

    # Flask
    SECRET_KEY = _required('SECRET_KEY')
    DEBUG = _bool('DEBUG', False)
    PORT = _int('PORT', 5005)

    # CORS
    CORS_ORIGINS = _list('CORS_ORIGINS', 'http://localhost:3000')

    @classmethod
    def slack_enabled(cls) -> bool:
        return bool(cls.SLACK_BOT_TOKEN and cls.SLACK_CHANNEL_ID)

    @classmethod
    def ai_enabled(cls) -> bool:
        return bool(cls.AI_ENDPOINT_URL)


class DevelopmentConfig(Config):
    """Development configuration"""
    DEBUG = True


class ProductionConfig(Config):
    """Production configuration"""
    DEBUG = False


# Configuration dictionary
config = {
    'development': DevelopmentConfig,
    'production': ProductionConfig,
    'default': ProductionConfig
}
