// ============================================================
// PLATFORM.JS — Platform-wise Breakdown
// Merges: Mobile + Android + iOS → "Mobile (All)"
// Status filter dropdown on the section header
// ============================================================

import { State } from './state.js';
import { getPlatformValue, escapeHtml, PLATFORM_FIELD } from './helpers.js';

// Which raw platform names map to the "Mobile (All)" group
const MOBILE_GROUP = ['mobile', 'android', 'ios'];

// Active status filter — null = show all
let activeStatusFilter = null;

function normalizePlatformName(raw) {
    const lower = raw.toLowerCase();
    if (MOBILE_GROUP.some(m => lower === m)) return 'Mobile (All)';
    return raw;
}

export function updatePlatformBreakdown() {
    const platformMap = new Map();

    State.currentIssues.forEach(issue => {
        const raw = getPlatformValue(issue, PLATFORM_FIELD) || 'Unassigned';
        if (raw.toLowerCase().includes('disabled')) return;

        // Apply status filter if active
        if (activeStatusFilter) {
            const statusName = issue.fields?.status?.name || '';
            if (!statusName.toLowerCase().includes(activeStatusFilter.toLowerCase())) return;
        }

        const platform       = normalizePlatformName(raw);
        const statusCategory = issue.fields?.status?.statusCategory?.key;

        if (!platformMap.has(platform)) {
            platformMap.set(platform, { total: 0, open: 0, inProgress: 0, done: 0 });
        }
        const p = platformMap.get(platform);
        p.total++;
        if (statusCategory === 'new')           p.open++;
        else if (statusCategory === 'indeterminate') p.inProgress++;
        else if (statusCategory === 'done')     p.done++;
    });

    const sortedPlatforms = [...platformMap.entries()].sort((a, b) => b[1].total - a[1].total);

    const grid = document.getElementById('platformGrid');
    if (!grid) return;
    grid.innerHTML = '';

    const iconMap = {
        'mobile (all)': 'fa-mobile-alt',
        'web app':       'fa-globe',
        'admin portal':  'fa-user-cog',
        'backend':       'fa-server',
        'frontend':      'fa-desktop',
        'infra':         'fa-cloud',
        'unassigned':    'fa-question-circle',
    };
    const iconPool = ['fa-mobile-alt','fa-globe','fa-user-cog','fa-server','fa-desktop','fa-tablet-alt','fa-cloud','fa-cogs'];

    sortedPlatforms.forEach(([name, data], idx) => {
        const pct  = data.total > 0 ? (data.done / data.total) * 100 : 0;
        const icon = iconMap[name.toLowerCase()] || iconPool[idx % iconPool.length];
        const card = document.createElement('div');
        card.className = 'platform-card';
        card.innerHTML = `
            <div class="platform-header">
                <div class="platform-header-left">
                    <i class="fas ${icon}"></i>
                    <h4>${escapeHtml(name)}</h4>
                </div>
                <div class="total-badge">${data.total} issues</div>
            </div>
            <div class="platform-stats">
                <div class="stat-row"><span class="stat-label">Open:</span><span class="stat-number">${data.open}</span></div>
                <div class="stat-row"><span class="stat-label">In Progress:</span><span class="stat-number">${data.inProgress}</span></div>
                <div class="stat-row"><span class="stat-label">Done:</span><span class="stat-number">${data.done}</span></div>
            </div>
            <div class="progress-bar-bg">
                <div class="progress-fill" style="width:${pct.toFixed(1)}%;"></div>
            </div>`;
        grid.appendChild(card);
    });

    if (sortedPlatforms.length === 0) {
        grid.innerHTML = `<div style="color:#5e6c84;font-size:0.88rem;padding:0.5rem;grid-column:1/-1;">
            No platform data found${activeStatusFilter ? ` for status "${activeStatusFilter}"` : ''}.
        </div>`;
    }
}

// ── Build status filter pill list in the epic table header area ──
export function initEpicStatusFilter() {
    const wrap = document.getElementById('epicStatusFilterWrap');
    if (!wrap) return;

    // Collect all unique statuses from current issues when called
    function getStatuses() {
        const set = new Set();
        State.currentIssues.forEach(i => {
            const s = i.fields?.status?.name;
            if (s) set.add(s);
        });
        return [...set].sort();
    }

    const trigger = document.getElementById('epicStatusFilterBtn');
    const menu    = document.getElementById('epicStatusFilterMenu');
    if (!trigger || !menu) return;

    trigger.addEventListener('click', e => {
        e.stopPropagation();
        // Build menu dynamically each open
        buildStatusFilterMenu(menu, getStatuses());
        menu.classList.toggle('show');
    });

    document.addEventListener('click', e => {
        if (!wrap.contains(e.target)) menu.classList.remove('show');
    });
}

function buildStatusFilterMenu(menu, statuses) {
    menu.innerHTML = '';

    // Clear option
    const clearItem = document.createElement('div');
    clearItem.className = `status-filter-item${!activeStatusFilter ? ' active' : ''}`;
    clearItem.innerHTML = `<span>All Statuses</span>${!activeStatusFilter ? '<i class="fas fa-check"></i>' : ''}`;
    clearItem.addEventListener('click', () => {
        activeStatusFilter = null;
        updateFilterBtnLabel();
        updatePlatformBreakdown();
        menu.classList.remove('show');
    });
    menu.appendChild(clearItem);

    statuses.forEach(s => {
        const item = document.createElement('div');
        const isActive = activeStatusFilter === s;
        item.className = `status-filter-item${isActive ? ' active' : ''}`;
        item.innerHTML = `<span>${escapeHtml(s)}</span>${isActive ? '<i class="fas fa-check"></i>' : ''}`;
        item.addEventListener('click', () => {
            activeStatusFilter = s;
            updateFilterBtnLabel();
            updatePlatformBreakdown();
            menu.classList.remove('show');
        });
        menu.appendChild(item);
    });
}

function updateFilterBtnLabel() {
    const btn = document.getElementById('epicStatusFilterBtn');
    if (!btn) return;
    if (activeStatusFilter) {
        btn.innerHTML = `<i class="fas fa-filter"></i> ${escapeHtml(activeStatusFilter)} <i class="fas fa-times" id="clearStatusFilter" style="margin-left:4px;opacity:0.6;"></i>`;
        btn.classList.add('filter-active');
        btn.querySelector('#clearStatusFilter')?.addEventListener('click', e => {
            e.stopPropagation();
            activeStatusFilter = null;
            updateFilterBtnLabel();
            updatePlatformBreakdown();
        });
    } else {
        btn.innerHTML = `<i class="fas fa-filter"></i> Status`;
        btn.classList.remove('filter-active');
    }
}