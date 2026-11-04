"""
Routes for the Naar Data / Operations page (/ndo) and its API (/api/ndo/*).
"""
import logging

import requests
from flask import Blueprint, Response, jsonify, render_template, request

from ndo_service import NdoService, SlackNotConfigured
from slack_client import SlackError

logger = logging.getLogger(__name__)

ndo_bp = Blueprint('ndo', __name__)
_service = None


def service() -> NdoService:
    global _service
    if _service is None:
        _service = NdoService()
    return _service


def _error(message: str, status: int):
    return jsonify({'error': message}), status


@ndo_bp.before_request
def _require_app_header():
    """
    State-changing calls must come from the dashboard's own JS. A custom header can't be
    sent by a plain cross-site form, and from another origin it triggers a CORS preflight
    that CORS_ORIGINS rejects — so another site can't make a logged-in browser post to Slack.
    """
    if request.method not in ('GET', 'HEAD', 'OPTIONS') and request.headers.get('X-NDO-Request') != '1':
        return _error('Missing X-NDO-Request header', 403)


@ndo_bp.errorhandler(SlackNotConfigured)
def _slack_not_configured(e):
    return _error(str(e), 400)


@ndo_bp.errorhandler(SlackError)
def _slack_error(e):
    logger.error(f"Slack: {e}")
    return _error(str(e), 502)


@ndo_bp.errorhandler(requests.RequestException)
def _jira_error(e):
    logger.error(f"Jira: {e}")
    status = getattr(getattr(e, 'response', None), 'status_code', None)
    hint = ' — check JIRA_EMAIL / JIRA_API_TOKEN in backend/.env' if status in (401, 403) else ''
    return _error(f"Jira request failed{f' ({status})' if status else ''}{hint}", 502)


@ndo_bp.route('/ndo')
def ndo_page():
    return render_template('ndo.html')


@ndo_bp.route('/api/ndo/report', methods=['GET'])
def get_report():
    svc = service()
    day = request.args.get('day') or None
    if not day:   # a past day is shown as stored; only today pulls fresh updates
        svc.maybe_sync_dev_updates()
    try:
        return jsonify(svc.report(refresh=request.args.get('refresh') == '1', day=day))
    except ValueError as e:
        return jsonify({'error': str(e)}), 400


@ndo_bp.route('/api/ndo/snapshot.png', methods=['GET'])
def get_snapshot():
    try:
        png = service().snapshot_png(refresh=request.args.get('refresh') == '1', day=request.args.get('day') or None)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    return Response(png, mimetype='image/png', headers={'Cache-Control': 'no-store'})


@ndo_bp.route('/api/ndo/notes', methods=['POST'])
def add_note():
    body = request.get_json(silent=True) or {}
    text = (body.get('text') or '').strip()
    if not text:
        return _error('Update text is required', 400)
    note = service().add_manual_update(text, author=body.get('author') or '')
    return jsonify(note), 201


@ndo_bp.route('/api/ndo/notes/<note_id>', methods=['DELETE'])
def delete_note(note_id):
    svc = service()
    if not svc.store.delete_note(svc.today(), note_id):
        return _error('Update not found', 404)
    return jsonify({'deleted': note_id})


@ndo_bp.route('/api/ndo/rag', methods=['POST'])
def set_rag():
    body = request.get_json(silent=True) or {}
    level = body.get('level') or None
    svc = service()
    try:
        svc.store.set_rag_override(svc.today(), level)
    except ValueError as e:
        return _error(str(e), 400)
    return jsonify({'level': level})


@ndo_bp.route('/api/ndo/slack/remind', methods=['POST'])
def slack_remind():
    return jsonify(service().send_reminder())


@ndo_bp.route('/api/ndo/slack/sync', methods=['POST'])
def slack_sync():
    return jsonify(service().sync_all_updates(raise_errors=True))


@ndo_bp.route('/api/ndo/slack/post', methods=['POST'])
def slack_post():
    body = request.get_json(silent=True) or {}
    result = service().post_daily(force=bool(body.get('force')))
    return jsonify(result), (200 if result['posted'] else 409)
