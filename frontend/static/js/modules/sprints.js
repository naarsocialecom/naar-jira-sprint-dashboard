// ============================================================
// SPRINTS.JS — Sprint selector, checklist rendering, data fetch
// Isolated: change only this file for sprint selector changes.
// ============================================================

import { State } from './state.js';
import { sortSprints, filterOutSubtasks, escapeHtml, API_BASE } from './helpers.js';
import { refreshAllChartsAndMetrics } from './orchestrator.js';

export async function fetchSprints() {
    try {
        const response = await fetch(`${API_BASE}/sprints`);
        if (!response.ok) throw new Error('Failed to fetch sprints');
        const data = await response.json();
        State.allSprintsList = sortSprints(data.values || []);

        const activeSprints = State.allSprintsList.filter(s => s.state === 'active');
        State.selectedSprintIds.clear();
        if (activeSprints.length > 0) {
            activeSprints.forEach(sp => State.selectedSprintIds.add(sp.id));
        } else if (State.allSprintsList.length > 0) {
            State.selectedSprintIds.add(State.allSprintsList[0].id);
        }

        renderSprintChecklist();
        updateSelectedSprintText();
        if (State.selectedSprintIds.size > 0) await loadIssuesForSprints();
    } catch (error) {
        console.error('Error fetching sprints:', error);
        const container = document.getElementById('sprintChecklist');
        if (container) container.innerHTML = `<div class="error-message">Error loading sprints: ${error.message}</div>`;
    }
}

export function renderSprintChecklist() {
    const container = document.getElementById('sprintChecklist');
    if (!container) return;
    if (!State.allSprintsList.length) {
        container.innerHTML = '<div class="error-message">No sprints found</div>';
        return;
    }
    container.innerHTML = '';

    State.allSprintsList.forEach(sprint => {
        const isChecked = State.selectedSprintIds.has(sprint.id);
        const isActive  = sprint.state === 'active';

        const div = document.createElement('div');
        div.className = `checkbox-item${isActive ? ' sprint-active-row' : ''}`;

        const cb = document.createElement('input');
        cb.type    = 'checkbox';
        cb.value   = sprint.id;
        cb.id      = `sprint_${sprint.id}`;
        cb.checked = isChecked;

        const customBox = document.createElement('span');
        customBox.className = `custom-checkbox${isChecked ? ' is-checked' : ''}`;
        customBox.innerHTML = isChecked ? CHECK_SVG : '';

        cb.addEventListener('change', async (e) => {
            if (e.target.checked) {
                State.selectedSprintIds.add(sprint.id);
                customBox.classList.add('is-checked');
                customBox.innerHTML = CHECK_SVG;
            } else {
                State.selectedSprintIds.delete(sprint.id);
                customBox.classList.remove('is-checked');
                customBox.innerHTML = '';
            }
            updateSelectedSprintText();
            await loadIssuesForSprints();
        });

        const label = document.createElement('label');
        label.htmlFor = `sprint_${sprint.id}`;
        const stateTag = isActive
            ? `<span class="sprint-state-tag active-tag">🔥 Active</span>`
            : `<span class="sprint-state-tag closed-tag">${sprint.state || 'closed'}</span>`;
        label.innerHTML = `<span class="sprint-name-text">${escapeHtml(sprint.name)}</span>${stateTag}`;

        div.appendChild(cb);
        div.appendChild(customBox);
        div.appendChild(label);
        container.appendChild(div);
    });
}

export function updateSelectedSprintText() {
    const labelSpan = document.getElementById('selectedSprintsLabel');
    const badgeSpan = document.getElementById('activeSprintBadge');
    if (State.selectedSprintIds.size === 0) {
        if (labelSpan) labelSpan.textContent = 'Select sprints...';
        if (badgeSpan) badgeSpan.textContent  = 'No sprint selected';
        return;
    }
    const selectedNames = State.allSprintsList
        .filter(s => State.selectedSprintIds.has(s.id))
        .map(s => s.name);
    if (labelSpan) labelSpan.textContent = selectedNames.length <= 2 ? selectedNames.join(', ') : `${selectedNames.length} sprints selected`;
    if (badgeSpan) badgeSpan.textContent  = selectedNames.join(', ');
}

export async function loadIssuesForSprints() {
    if (State.selectedSprintIds.size === 0) {
        State.currentIssues = [];
        refreshAllChartsAndMetrics();
        return;
    }
    const idsParam = Array.from(State.selectedSprintIds).join(',');
    try {
        const response = await fetch(`${API_BASE}/issues?sprintIds=${encodeURIComponent(idsParam)}`);
        if (!response.ok) throw new Error('Failed to fetch issues');
        const data = await response.json();
        State.currentIssues = filterOutSubtasks(data.issues || []);

        for (let sid of State.selectedSprintIds) {
            if (!State.sprintDetailsMap.has(sid)) {
                try {
                    const sprRes = await fetch(`${API_BASE}/sprint/${sid}`);
                    State.sprintDetailsMap.set(sid, await sprRes.json());
                } catch(e) { console.error(`Sprint ${sid} detail fail:`, e); }
            }
        }
        refreshAllChartsAndMetrics();
    } catch (error) {
        console.error('Error loading issues:', error);
        showError('Failed to load issues');
    }
}

export function setupDropdowns() {
    const trigger = document.getElementById('sprintDropdownTrigger');
    const menu    = document.getElementById('sprintDropdownMenu');
    if (trigger && menu) {
        trigger.addEventListener('click', e => {
            e.stopPropagation();
            menu.classList.toggle('show');
            trigger.classList.toggle('open');
        });
        document.addEventListener('click', e => {
            if (!trigger.contains(e.target) && !menu.contains(e.target)) {
                menu.classList.remove('show');
                trigger.classList.remove('open');
            }
        });
    }
}

export function setupSprintEventListeners() {
    const clearBtn = document.getElementById('clearAllSprintsBtn');
    if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
            State.selectedSprintIds.clear();
            renderSprintChecklist();
            updateSelectedSprintText();
            await loadIssuesForSprints();
            document.getElementById('sprintDropdownMenu')?.classList.remove('show');
        });
    }
    // Epic search is wired in dashboard.js to avoid circular imports
}

function showError(message) {
    console.error(message);
    const container = document.getElementById('sprintChecklist');
    if (container && !container.querySelector('.error-message')) {
        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-message';
        errorDiv.innerHTML = `<i class="fas fa-exclamation-triangle"></i> ${message}`;
        container.prepend(errorDiv);
        setTimeout(() => errorDiv.remove(), 5000);
    }
}

const CHECK_SVG = `<svg width="11" height="9" viewBox="0 0 11 9" fill="none"><path d="M1 4L4 7.5L10 1" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
