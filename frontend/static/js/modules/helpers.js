// ============================================================
// HELPERS.JS — Pure utility functions, no DOM, no side-effects
// ============================================================

export const ISSUE_TYPE_ORDER = ['Story', 'Improvement', 'Bug', 'Incident', 'Task'];
export const PRIORITY_ORDER   = ['Critical', 'High', 'Medium', 'Low', 'Lowest'];
export const API_BASE         = '/api';

export const PLATFORM_FIELD = (typeof JIRA_PLATFORM_FIELD !== 'undefined' && JIRA_PLATFORM_FIELD)
    ? JIRA_PLATFORM_FIELD
    : 'customfield_10054';

export function isSubtask(issue)          { return issue.fields?.issuetype?.subtask === true; }
export function filterOutSubtasks(issues) { return issues.filter(i => !isSubtask(i)); }
export function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function getStatusClass(status) {
    const s = (status || '').toLowerCase().trim();

    // Exact / specific matches first
    if (s === 'done' || s === 'closed' || s === 'resolved')          return 'status-done';
    if (s === 'cancelled' || s === 'canceled')                        return 'status-cancelled';
    if (s === 'on-hold'   || s === 'on hold')                         return 'status-onhold';
    if (s === 'product backlog' || s === 'backlog')                    return 'status-backlog';
    if (s === 'in research')                                           return 'status-research';
    if (s === 'in design'  || s === 'design')                         return 'status-design';
    if (s === 'ready for dev.' || s === 'ready for dev' || s === 'ready for development') return 'status-readyfordev';
    if (s === 'in development' || s === 'development')                 return 'status-development';

    // Broad fallbacks
    if (s.includes('progress') || s.includes('review') || s.includes('testing')) return 'status-inprogress';
    if (s.includes('block'))                                           return 'status-blocked';
    if (s.includes('hold'))                                            return 'status-onhold';
    if (s.includes('cancel'))                                          return 'status-cancelled';
    if (s.includes('backlog'))                                         return 'status-backlog';
    if (s.includes('research'))                                        return 'status-research';
    if (s.includes('design'))                                          return 'status-design';
    if (s.includes('ready'))                                           return 'status-readyfordev';
    if (s.includes('development') || s.includes('dev'))                return 'status-development';

    return 'status-todo';
}

export function sortSprints(sprints) {
    return [...sprints].sort((a, b) => {
        if (a.state === 'active' && b.state !== 'active') return -1;
        if (a.state !== 'active' && b.state === 'active') return  1;
        if (a.state === 'active' && b.state === 'active')
            return (new Date(a.endDate || '9999') - new Date(b.endDate || '9999'));
        if (a.state === 'closed' && b.state === 'closed')
            return (new Date(b.endDate || '0') - new Date(a.endDate || '0'));
        return (new Date(a.startDate || '9999') - new Date(b.startDate || '9999'));
    });
}

export function sortIssueTypesByCount(entries, direction = 'high-to-low') {
    const sorted = [...entries].sort((a, b) => {
        const diff = direction === 'low-to-high' ? a[1] - b[1] : b[1] - a[1];
        if (diff !== 0) return diff;
        const ai = ISSUE_TYPE_ORDER.indexOf(a[0]);
        const bi = ISSUE_TYPE_ORDER.indexOf(b[0]);
        if (ai === -1 && bi === -1) return 0;
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
    });
    return new Map(sorted);
}

export function getWeekdaysRemaining(endDateStr) {
    if (!endDateStr) return null;
    const end   = new Date(endDateStr);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (end < today) return 0;
    let days = 0, current = new Date(today);
    while (current <= end) {
        const d = current.getDay();
        if (d !== 0 && d !== 6) days++;
        current.setDate(current.getDate() + 1);
    }
    return days;
}

export function getPlatformValue(issue, platformField) {
    if (!issue || !issue.fields || !platformField) return null;
    const fieldVal = issue.fields[platformField];
    if (!fieldVal) return null;
    if (Array.isArray(fieldVal))        return fieldVal.map(v => v.value || v.name || '').filter(Boolean).join(', ');
    if (typeof fieldVal === 'object')   return fieldVal.value || fieldVal.name || null;
    return String(fieldVal);
}
