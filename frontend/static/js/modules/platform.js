// ============================================================
// PLATFORM.JS — Platform-wise Breakdown cards
// Isolated: change only this file for platform section changes.
// ============================================================

import { State } from './state.js';
import { getPlatformValue, escapeHtml, PLATFORM_FIELD } from './helpers.js';

export function updatePlatformBreakdown() {
    const platformMap = new Map();

    State.currentIssues.forEach(issue => {
        const platform = getPlatformValue(issue, PLATFORM_FIELD) || 'Unassigned';
        if (platform.toLowerCase().includes('disabled')) return;

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

    const iconPool = [
        'fa-mobile-alt', 'fa-globe', 'fa-user-cog', 'fa-server',
        'fa-desktop', 'fa-tablet-alt', 'fa-cloud', 'fa-cogs'
    ];

    sortedPlatforms.forEach(([name, data], idx) => {
        const pct  = data.total > 0 ? (data.done / data.total) * 100 : 0;
        const icon = iconPool[idx % iconPool.length];
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
            </div>
        `;
        grid.appendChild(card);
    });

    if (sortedPlatforms.length === 0) {
        grid.innerHTML = `<div style="color:#5e6c84;font-size:0.88rem;padding:0.5rem;">
            No platform data found. Check if <code>${PLATFORM_FIELD}</code> is filled in Jira.
        </div>`;
    }
}
