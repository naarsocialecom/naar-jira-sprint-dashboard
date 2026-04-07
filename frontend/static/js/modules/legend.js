// ============================================================
// LEGEND.JS — Renders legends below charts
// legendStyle: 'table'  → new table with S.No | Title | Count | Total row
//              'pills'  → old pill-style (default fallback)
// ============================================================

import { Settings } from './state.js';

// ── Internal helper ──────────────────────────────────────────
function getOrCreateContainer(chartId, extraClass = '') {
    const canvas = document.getElementById(chartId);
    if (!canvas) return null;
    const chartCard = canvas.closest('.chart-card, .heat-chart-container');
    if (!chartCard) return null;
    chartCard.querySelector('.compact-legend')?.remove();
    const div = document.createElement('div');
    div.className = 'compact-legend' + (extraClass ? ' ' + extraClass : '');
    chartCard.appendChild(div);
    return div;
}

// ── Table-style legend (new design) ─────────────────────────
function renderTableLegend(container, labels, colors, data, isDonut = false) {
    const total = data.reduce((a, b) => a + b, 0);
    const table = document.createElement('table');
    table.className = 'legend-table';
    table.innerHTML = `
        <thead>
            <tr>
                <th>#</th>
                <th>Title</th>
                <th>Count</th>
                ${isDonut ? '<th>%</th>' : ''}
            </tr>
        </thead>
    `;
    const tbody = document.createElement('tbody');
    labels.forEach((label, i) => {
        const pct = isDonut && total > 0 ? ((data[i] / total) * 100).toFixed(1) : null;
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${i + 1}</td>
            <td><span class="legend-swatch" style="background:${colors[i]};border-radius:${isDonut?'50%':'3px'}"></span>${label}</td>
            <td><strong>${data[i]}</strong></td>
            ${isDonut ? `<td>${pct}%</td>` : ''}
        `;
        tbody.appendChild(tr);
    });
    // Total row
    const tfootTr = document.createElement('tr');
    tfootTr.className = 'legend-total-row';
    tfootTr.innerHTML = `
        <td colspan="${isDonut ? 2 : 2}" style="font-weight:700;">Total</td>
        <td><strong>${total}</strong></td>
        ${isDonut ? '<td>100%</td>' : ''}
    `;
    tbody.appendChild(tfootTr);
    table.appendChild(tbody);
    container.appendChild(table);
}

// ── Pill-style legend (original design) ─────────────────────
function renderPillLegend(container, labels, colors, data, isDonut = false) {
    const total = data.reduce((a, b) => a + b, 0);
    labels.forEach((label, i) => {
        const item = document.createElement('div');
        const pct  = isDonut && total > 0 ? ` – ${((data[i]/total)*100).toFixed(1)}%` : '';
        item.innerHTML = `
            <span style="background-color:${colors[i]};width:12px;height:12px;display:inline-block;border-radius:${isDonut?'50%':'3px'};"></span>
            <span style="font-size:11px;font-weight:500;color:#5e6c84;">${label} (${data[i]}${pct})</span>
        `;
        container.appendChild(item);
    });
}

// ── Public API ───────────────────────────────────────────────
export function addCompactLegend(chartId, labels, colors, data) {
    const container = getOrCreateContainer(chartId);
    if (!container) return;
    if (Settings.legendStyle === 'table') {
        container.classList.add('legend-table-mode');
        renderTableLegend(container, labels, colors, data, false);
    } else {
        renderPillLegend(container, labels, colors, data, false);
    }
}

export function addDonutCompactLegend(chartId, labels, colors, data, _total) {
    const container = getOrCreateContainer(chartId, 'donut-legend');
    if (!container) return;
    if (Settings.legendStyle === 'table') {
        container.classList.add('legend-table-mode');
        renderTableLegend(container, labels, colors, data, true);
    } else {
        renderPillLegend(container, labels, colors, data, true);
    }
}
