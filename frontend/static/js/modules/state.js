// ============================================================
// STATE.JS — Single source of truth for all dashboard state
// ============================================================

export const State = {
    allSprintsList:    [],
    selectedSprintIds: new Set(),
    currentIssues:     [],
    sprintDetailsMap:  new Map(),
};

export const Settings = {
    sortOrder:   'high-to-low',
    legendStyle: 'pills',
    barColors: {
        issueType: ['#16ecac', '#25d6ee', '#d63a0a', '#ffaa00', '#4d4d4d', '#0755ae'],
        component: ['#d03100', '#e07d03', '#00aac0', '#00b17c', '#484848', '#0563cf'],
        heat:      { Bug: '#d03100', Incident: '#e07d03' },
    },
};

export function applySettings(incoming) {
    if (incoming.sortOrder)   Settings.sortOrder   = incoming.sortOrder;
    if (incoming.legendStyle) Settings.legendStyle = incoming.legendStyle;
    if (incoming.barColors) {
        if (incoming.barColors.issueType)    Settings.barColors.issueType = incoming.barColors.issueType;
        if (incoming.barColors.component)    Settings.barColors.component = incoming.barColors.component;
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
            sortOrder:   Settings.sortOrder,
            legendStyle: Settings.legendStyle,
            barColors: {
                issueType:    Settings.barColors.issueType,
                component:    Settings.barColors.component,
                heatBug:      Settings.barColors.heat.Bug,
                heatIncident: Settings.barColors.heat.Incident,
            }
        }));
    } catch (_) {}
}