"""
Screenshot of the live /ndo page (header, tiles and the Highlights section) for Slack.

Uses headless Chromium through Playwright. The web app must be running and reachable
at SNAPSHOT_BASE_URL. One-time setup on a server:
    venv/bin/python -m playwright install --with-deps chromium
"""
import logging

from config import Config

logger = logging.getLogger(__name__)


class SnapshotError(RuntimeError):
    pass


def capture_dashboard(timeout_ms: int = 45000) -> bytes:
    try:
        from playwright.sync_api import Error as PlaywrightError, sync_playwright
    except ImportError:
        raise SnapshotError('Playwright is not installed (pip install -r requirements.txt)')

    url = f"{Config.SNAPSHOT_BASE_URL}/ndo?snapshot=1"
    try:
        with sync_playwright() as p:
            launch = {'headless': True}
            if Config.SNAPSHOT_BROWSER_CHANNEL:
                launch['channel'] = Config.SNAPSHOT_BROWSER_CHANNEL
            browser = p.chromium.launch(**launch)
            try:
                page = browser.new_page(viewport={'width': Config.SNAPSHOT_WIDTH, 'height': 1000},
                                        device_scale_factor=2)
                page.goto(url, wait_until='networkidle', timeout=timeout_ms)
                page.wait_for_selector('body[data-ready]', timeout=timeout_ms)
                if page.get_attribute('body', 'data-ready') != '1':
                    raise SnapshotError(f"Dashboard failed to load data at {url}")
                page.evaluate('document.fonts.ready.then(() => true)')
                return page.locator('#ndoSnapshotArea').screenshot(type='png', animations='disabled')
            finally:
                browser.close()
    except PlaywrightError as e:
        raise SnapshotError(f"Dashboard screenshot failed ({url}): {str(e).splitlines()[0]}")
