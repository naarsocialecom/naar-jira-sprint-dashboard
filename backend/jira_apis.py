import requests
from requests.adapters import HTTPAdapter
from requests.auth import HTTPBasicAuth
from urllib3.util.retry import Retry
import logging
from typing import List, Dict, Any
from config import Config

logger = logging.getLogger(__name__)

class JiraClient:
    """Jira API Client for handling all Jira interactions"""
    
    def __init__(self):
        self.domain = Config.JIRA_DOMAIN
        self.email = Config.JIRA_EMAIL
        self.api_token = Config.JIRA_API_TOKEN
        self.board_id = Config.JIRA_BOARD_ID
        self.project_key = Config.JIRA_PROJECT_KEY
        self.timeout = Config.JIRA_TIMEOUT_SECONDS
        self.auth = HTTPBasicAuth(self.email, self.api_token)
        self.headers = {
            "Accept": "application/json",
            "Content-Type": "application/json"
        }
        # Reuse TCP connections and retry transient failures (429 / 5xx)
        self.session = requests.Session()
        self.session.auth = self.auth
        self.session.headers.update(self.headers)
        retry = Retry(
            total=3,
            backoff_factor=1,
            status_forcelist=(429, 502, 503, 504),
            allowed_methods=('GET', 'POST'),
            respect_retry_after_header=True,
        )
        self.session.mount('https://', HTTPAdapter(max_retries=retry))
        self.session.mount('http://', HTTPAdapter(max_retries=retry))
        
    def _make_request(self, method: str, endpoint: str, params: Dict = None, json_body: Dict = None) -> Dict:
        """Make HTTP request to Jira API"""
        if self.domain.startswith('https://') or self.domain.startswith('http://'):
            url = f"{self.domain}{endpoint}"
        else:
            url = f"https://{self.domain}{endpoint}"
        
        try:
            response = self.session.request(
                method=method,
                url=url,
                params=params,
                json=json_body,
                timeout=self.timeout
            )
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            logger.error(f"Jira API request failed: {method} {endpoint}: {e}")
            raise
    
    def get_all_sprints(self) -> List[Dict]:
        """Fetch all sprints from the board"""
        endpoint = f"/rest/agile/1.0/board/{self.board_id}/sprint"
        params = {
            'state': 'future,active,closed',
            'maxResults': 100
        }
        data = self._make_request('GET', endpoint, params)
        return data.get('values', [])
    
    def get_sprint_details(self, sprint_id: int) -> Dict:
        """Fetch details of a specific sprint"""
        endpoint = f"/rest/agile/1.0/sprint/{sprint_id}"
        return self._make_request('GET', endpoint)
    
    def get_sprint_issues(self, sprint_id: int) -> List[Dict]:
        """Fetch all issues for a specific sprint."""
        endpoint = f"/rest/agile/1.0/sprint/{sprint_id}/issue"
        params = {
            'maxResults': 500,
            'fields': (
                'issuetype,priority,summary,status,components,'
                'description,assignee,duedate,'
                'parent,'
                'customfield_10014,'   # Epic Link (classic)
                'customfield_10008,'   # Epic Name (classic)
                'customfield_10010,'   # Parent/Epic (next-gen)
                'customfield_10020,'   # Sprint field
                'epic,'                # Epic object (agile API)
                f'{Config.JIRA_FIELD_PLATFORM}'   # Platform custom field
            )
        }
        data = self._make_request('GET', endpoint, params)
        return data.get('issues', [])
    
    def get_multiple_sprints_issues(self, sprint_ids: List[int]) -> List[Dict]:
        """Fetch issues for multiple sprints"""
        all_issues = []
        seen_keys = set()
        for sprint_id in sprint_ids:
            try:
                issues = self.get_sprint_issues(sprint_id)
                for issue in issues:
                    key = issue.get('key', '')
                    if key not in seen_keys:
                        seen_keys.add(key)
                        all_issues.append(issue)
            except Exception as e:
                logger.error(f"Failed to fetch issues for sprint {sprint_id}: {e}")
                continue
        return all_issues
    
    def get_active_sprints(self) -> List[Dict]:
        """Get only active sprints"""
        all_sprints = self.get_all_sprints()
        return [sprint for sprint in all_sprints if sprint.get('state') == 'active']
    
    def get_project_components(self) -> List[Dict]:
        """Fetch all components for the project"""
        try:
            endpoint = f"/rest/api/2/project/{self.project_key}/components"
            data = self._make_request('GET', endpoint)
            return data
        except Exception as e:
            logger.error(f"Failed to fetch components: {e}")
            return []
    
    def get_components_from_issues(self, sprint_ids: List[int]) -> Dict[str, Any]:
        """Fetch components directly from issues in sprints"""
        components_dict = {}
        all_issues = self.get_multiple_sprints_issues(sprint_ids)
        
        for issue in all_issues:
            issue_components = issue.get('fields', {}).get('components', [])
            for component in issue_components:
                comp_name = component.get('name', 'Unknown')
                comp_id = component.get('id', '')
                
                if comp_name not in components_dict:
                    components_dict[comp_name] = {
                        'id': comp_id,
                        'name': comp_name,
                        'issue_count': 0,
                        'issues': []
                    }
                components_dict[comp_name]['issue_count'] += 1
                components_dict[comp_name]['issues'].append({
                    'key': issue.get('key', ''),
                    'summary': issue.get('fields', {}).get('summary', ''),
                    'status': issue.get('fields', {}).get('status', {}).get('name', ''),
                    'priority': issue.get('fields', {}).get('priority', {}).get('name', '')
                })
        
        return components_dict

    def get_highlights_ticket(self) -> Dict:
        """
        Fetch the highlights ticket (e.g. NAAR-2531) using the REST v2 API
        so we get the full ADF body for customfield_11550.
        """
        ticket_key = Config.JIRA_HIGHLIGHTS_TICKET
        field_name  = Config.JIRA_FIELD_HIGHLIGHTS
        if not ticket_key or not field_name:
            logger.warning("JIRA_HIGHLIGHTS_TICKET / JIRA_FIELD_HIGHLIGHTS not configured")
            return {}
        try:
            endpoint = f"/rest/api/2/issue/{ticket_key}"
            params = {
                'fields': f'summary,{field_name},description,status'
            }
            data = self._make_request('GET', endpoint, params)
            return data
        except Exception as e:
            logger.error(f"Failed to fetch highlights ticket {ticket_key}: {e}")
            return {}

    def search_issues(self, jql: str, fields: List[str], page_size: int = 100, max_issues: int = 2000) -> List[Dict]:
        """
        Run a JQL search and return every matching issue.
        Uses the enhanced search endpoint (/rest/api/3/search/jql), which pages
        with nextPageToken instead of startAt.
        """
        issues: List[Dict] = []
        next_token = None
        while True:
            body = {'jql': jql, 'fields': fields, 'maxResults': page_size}
            if next_token:
                body['nextPageToken'] = next_token
            data = self._make_request('POST', '/rest/api/3/search/jql', json_body=body)
            issues.extend(data.get('issues', []))
            next_token = data.get('nextPageToken')
            if not next_token or data.get('isLast') or len(issues) >= max_issues:
                break
        return issues[:max_issues]
