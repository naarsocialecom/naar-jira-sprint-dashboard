import json
import logging
from logging.handlers import RotatingFileHandler

from flask import Flask, jsonify, render_template, request
from flask_cors import CORS

from config import config, Config
from jira_apis import JiraClient
from ndo_routes import ndo_bp

# Initialize Flask app
app = Flask(__name__, 
           template_folder='../frontend/templates',
           static_folder='../frontend/static')

# Load configuration (all values come from backend/.env — see config.py)
app.config.from_object(config.get(Config.APP_ENV, config['default']))
app.config['MAX_CONTENT_LENGTH'] = 1 * 1024 * 1024   # reject request bodies over 1 MB

# Enable CORS
CORS(app, origins=Config.CORS_ORIGINS)

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s: %(message)s')
if not app.debug:
    Config.LOG_DIR.mkdir(parents=True, exist_ok=True)
    file_handler = RotatingFileHandler(Config.LOG_DIR / 'jira_dashboard.log', maxBytes=1_000_000, backupCount=10)
    file_handler.setFormatter(logging.Formatter(
        '%(asctime)s %(levelname)s: %(message)s [in %(pathname)s:%(lineno)d]'
    ))
    file_handler.setLevel(logging.INFO)
    app.logger.addHandler(file_handler)
    app.logger.setLevel(logging.INFO)
    app.logger.info('Jira Dashboard startup')

# Initialize Jira client
jira_client = JiraClient()

# Naar Data / Operations page + API
app.register_blueprint(ndo_bp)

def _render_sprint_dashboard():
    return render_template('index.html',
                         epic_page_size=Config.EPIC_TABLE_PAGE_SIZE,
                         platform_field=Config.JIRA_FIELD_PLATFORM,
                         highlights_ticket=Config.JIRA_HIGHLIGHTS_TICKET,
                         )

@app.route('/')
def index():
    """Serve the main dashboard page"""
    return _render_sprint_dashboard()

@app.route('/api/config', methods=['GET'])
def get_config():
    """Return configuration for frontend (excluding sensitive data)"""
    return jsonify({
        'jira_domain': Config.JIRA_DOMAIN,
        'board_id': Config.JIRA_BOARD_ID,
    })

@app.route('/api/sprints', methods=['GET'])
def get_sprints():
    """Get all sprints for the board"""
    try:
        board_id = request.args.get('boardId', Config.JIRA_BOARD_ID)
        sprints = jira_client.get_all_sprints()
        return jsonify({
            'values': sprints,
            'total': len(sprints)
        })
    except Exception as e:
        app.logger.error(f"Error fetching sprints: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/sprint/<int:sprint_id>', methods=['GET'])
def get_sprint(sprint_id):
    """Get details of a specific sprint"""
    try:
        sprint = jira_client.get_sprint_details(sprint_id)
        return jsonify(sprint)
    except Exception as e:
        app.logger.error(f"Error fetching sprint {sprint_id}: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/issues', methods=['GET'])
def get_issues():
    """Get issues for one or multiple sprints"""
    try:
        sprint_ids_param = request.args.get('sprintIds', '')
        if not sprint_ids_param:
            return jsonify({'error': 'No sprint IDs provided'}), 400
        
        sprint_ids = [int(id.strip()) for id in sprint_ids_param.split(',') if id.strip().isdigit()]
        
        if not sprint_ids:
            return jsonify({'error': 'Invalid sprint IDs'}), 400
        
        issues = jira_client.get_multiple_sprints_issues(sprint_ids)
        
        return jsonify({
            'issues': issues,
            'total': len(issues),
            'sprints': sprint_ids
        })
    except Exception as e:
        app.logger.error(f"Error fetching issues: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/active-sprint', methods=['GET'])
def get_active_sprint():
    """Get the currently active sprint"""
    try:
        active_sprints = jira_client.get_active_sprints()
        if active_sprints:
            return jsonify({
                'active_sprints': active_sprints,
                'count': len(active_sprints)
            })
        else:
            return jsonify({
                'active_sprints': [],
                'count': 0,
                'message': 'No active sprints found'
            })
    except Exception as e:
        app.logger.error(f"Error fetching active sprint: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/highlights', methods=['GET'])
def get_highlights():
    """
    Fetch the highlights ticket and return its ADF content
    from the configured custom field (JIRA_FIELD_HIGHLIGHTS).
    """
    try:
        data = jira_client.get_highlights_ticket()
        if not data:
            return jsonify({'error': 'Highlights ticket not found'}), 404

        field_name  = Config.JIRA_FIELD_HIGHLIGHTS
        fields      = data.get('fields', {})
        highlights_raw = fields.get(field_name)

        return jsonify({
            'key':       data.get('key', ''),
            'summary':   fields.get('summary', ''),
            'status':    fields.get('status', {}).get('name', ''),
            'highlights': highlights_raw,  # raw ADF value (dict or string)
            'field_used': field_name
        })
    except Exception as e:
        app.logger.error(f"Error fetching highlights: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/dashboard')
def dashboard():
    return _render_sprint_dashboard()

SETTINGS_FILE = Config.DATA_DIR / "settings.json"

def load_settings():
    if not SETTINGS_FILE.exists():
        return {}
    with open(SETTINGS_FILE, "r") as f:
        return json.load(f)

def save_settings(data):
    Config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(SETTINGS_FILE, "w") as f:
        json.dump(data, f, indent=4)

@app.route('/settings')
def settings_page():
    return render_template('settings.html')

@app.route('/api/settings', methods=['GET'])
def get_settings():
    return jsonify(load_settings())

@app.route('/api/settings', methods=['POST'])
def update_settings():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'Expected a JSON object'}), 400
    save_settings(data)
    return jsonify({"status": "saved"})

@app.after_request
def security_headers(response):
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('X-Frame-Options', 'SAMEORIGIN')
    response.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')
    if request.path.startswith('/api/'):
        response.headers.setdefault('Cache-Control', 'no-store')
    return response

@app.route('/healthz')
def healthz():
    return jsonify({'status': 'ok'})

@app.errorhandler(404)
def not_found_error(error):
    return jsonify({'error': 'Resource not found'}), 404

@app.errorhandler(500)
def internal_error(error):
    app.logger.error(f'Server Error: {error}')
    return jsonify({'error': 'Internal server error'}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=Config.PORT, debug=app.config['DEBUG'])