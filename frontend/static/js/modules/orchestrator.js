// ============================================================
// ORCHESTRATOR.JS — Coordinates all modules after data loads
// ============================================================

import { State, Settings } from './state.js';
import { getWeekdaysRemaining, sortIssueTypesByCount } from './helpers.js';
import { updateIssueBarChart }      from '../charts/chart-issue-type.js';
import { updatePriorityDonutChart } from '../charts/chart-priority.js';
import { updateComponentBarChart }  from '../charts/chart-component.js';
import { updateHeatClusteredChart } from '../charts/chart-heat.js';
import { updatePlatformBreakdown }  from './platform.js';
import { buildEpicTableData }       from './epic-table.js';

export function refreshAllChartsAndMetrics() {
    updateCombinedMetrics();
    updateFourMetricTiles();

    const typeCountMap      = new Map();
    const priorityCountMap  = new Map();
    const componentCountMap = new Map();
    const heatData          = { Bug: {}, Incident: {} };

    State.currentIssues.forEach(issue => {
        const typeName     = issue.fields?.issuetype?.name || 'Unknown';
        const priorityName = issue.fields?.priority?.name  || 'None';

        typeCountMap.set(typeName,     (typeCountMap.get(typeName)     || 0) + 1);
        priorityCountMap.set(priorityName, (priorityCountMap.get(priorityName) || 0) + 1);

        (issue.fields?.components || []).forEach(comp => {
            if (comp.name) componentCountMap.set(comp.name, (componentCountMap.get(comp.name) || 0) + 1);
        });

        if (typeName === 'Bug' || typeName === 'Incident') {
            if (!heatData[typeName][priorityName]) heatData[typeName][priorityName] = 0;
            heatData[typeName][priorityName]++;
        }
    });

    const sortedTypeEntries = sortIssueTypesByCount(Array.from(typeCountMap.entries()), Settings.sortOrder);
    const sortedComponents  = new Map(
        [...componentCountMap.entries()].sort((a, b) =>
            Settings.sortOrder === 'low-to-high' ? a[1] - b[1] : b[1] - a[1]
        )
    );

    safeRun('IssueTypeChart',     () => updateIssueBarChart(sortedTypeEntries));
    safeRun('PriorityDonutChart', () => updatePriorityDonutChart(priorityCountMap));
    safeRun('ComponentBarChart',  () => updateComponentBarChart(sortedComponents));
    safeRun('HeatChart',          () => updateHeatClusteredChart(heatData));
    safeRun('PlatformBreakdown',  () => updatePlatformBreakdown());
    safeRun('EpicTable',          () => buildEpicTableData());
}

function safeRun(name, fn) {
    try { fn(); } catch (err) { console.error(`[Orchestrator] ${name} failed:`, err); }
}

// ── Combined metrics ─────────────────────────────────────────
function updateCombinedMetrics() {
    const el = document.getElementById('totalTicketsCombined');
    if (el) el.textContent = State.currentIssues.length;

    const rem = document.getElementById('sprintDaysRemaining');
    if (!rem) return;

    if (State.selectedSprintIds.size === 0) { rem.textContent = '-'; return; }

    const selected = [...State.selectedSprintIds]
        .map(sid => State.allSprintsList.find(s => s.id === sid))
        .filter(Boolean);

    const activeSprints = selected.filter(s => s.state === 'active');
    const hasClosed     = selected.some(s => s.state === 'closed');

    // NA when: no active, more than 1 active, or mixing active+closed
    if (activeSprints.length === 0 || activeSprints.length > 1 || hasClosed) {
        rem.textContent = 'NA';
        return;
    }

    // Exactly 1 active sprint, no closed mixed in
    const sprint = activeSprints[0];
    if (!sprint.endDate) { rem.textContent = 'NA'; return; }

    const w = getWeekdaysRemaining(sprint.endDate);
    rem.textContent = (w !== null && w >= 0) ? w : 'NA';
}

// ── Four metric tiles ────────────────────────────────────────
function updateFourMetricTiles() {
    let bugs = 0, incidents = 0, improvements = 0, stories = 0;
    State.currentIssues.forEach(issue => {
        const t = issue.fields?.issuetype?.name || '';
        if      (t === 'Bug')         bugs++;
        else if (t === 'Incident')    incidents++;
        else if (t === 'Improvement') improvements++;
        else if (t === 'Story')       stories++;
    });
    const $ = id => document.getElementById(id);
    if ($('bugsCount'))         $('bugsCount').textContent         = bugs;
    if ($('incidentsCount'))    $('incidentsCount').textContent    = incidents;
    if ($('improvementsCount')) $('improvementsCount').textContent = improvements;
    if ($('storiesCountTile'))  $('storiesCountTile').textContent  = stories;
}