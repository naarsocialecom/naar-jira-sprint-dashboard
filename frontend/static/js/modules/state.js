// ============================================================
// STATE.JS — Single source of truth for all dashboard state
// If you need to add a new global variable, it lives here.
// ============================================================

export const State = {
    allSprintsList:    [],
    selectedSprintIds: new Set(),
    currentIssues:     [],
    sprintDetailsMap:  new Map(),
};

// Settings managed separately — see settings-panel.js
export const Settings = {
    sortOrder: 'high-to-low',      // 'high-to-low' | 'low-to-high'
    barColors: {
        issueType:  ['#16ecac', '#25d6ee', '#d63a0a', '#ffaa00', '#4d4d4d', '#0755ae'],
        component:  ['#d03100', '#e07d03', '#00aac0', '#00b17c', '#484848', '#0563cf'],
        heat:       { Bug: '#d03100', Incident: '#e07d03' },
    },
    legendStyle: 'pills',          // 'pills' | 'table'
};

export function applySettings(incoming) {
    if (incoming.sortOrder) Settings.sortOrder = incoming.sortOrder;
    if (incoming.barColors) {
        Object.assign(Settings.barColors.issueType, incoming.barColors.issueType || []);
        Object.assign(Settings.barColors.component, incoming.barColors.component || []);
        if (incoming.barColors.heatBug)      Settings.barColors.heat.Bug      = incoming.barColors.heatBug;
        if (incoming.barColors.heatIncident) Settings.barColors.heat.Incident = incoming.barColors.heatIncident;
    }
}

export function loadSettingsFromStorage() {
    try {
        const raw = localStorage.getItem('naar_dashboard_settings');
        if (raw) applySettings(JSON.parse(raw));
    } catch (_) {}
}

export function saveSettingsToStorage() {
    try {
        localStorage.setItem('naar_dashboard_settings', JSON.stringify({
            sortOrder: Settings.sortOrder,
            barColors: {
                issueType:   Settings.barColors.issueType,
                component:   Settings.barColors.component,
                heatBug:     Settings.barColors.heat.Bug,
                heatIncident:Settings.barColors.heat.Incident,
            }
        }));
    } catch (_) {}
}
