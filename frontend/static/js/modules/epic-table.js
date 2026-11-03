// ============================================================
// EPIC-TABLE.JS — Epics table with dynamic + draggable columns
// ============================================================

import { State } from './state.js';
import { escapeHtml, getStatusClass } from './helpers.js';
import { EpicColumns, EPIC_EXTRA_COLUMNS, saveEpicColumnsToStorage } from './settings-panel.js';

const EPIC_PAGE_SIZE = typeof DASHBOARD_EPIC_PAGE_SIZE !== 'undefined' ? DASHBOARD_EPIC_PAGE_SIZE : 8;
let epicTableData   = [];
let epicCurrentPage = 1;

// Column order persisted in localStorage
let columnOrder = null; // will be initialized from EPIC_EXTRA_COLUMNS keys

function getColumnOrder() {
    if (!columnOrder) {
        try {
            const raw = localStorage.getItem('naar_col_order');
            columnOrder = raw ? JSON.parse(raw) : EPIC_EXTRA_COLUMNS.map(c => c.key);
        } catch (_) {
            columnOrder = EPIC_EXTRA_COLUMNS.map(c => c.key);
        }
    }
    return columnOrder;
}

function saveColumnOrder() {
    try { localStorage.setItem('naar_col_order', JSON.stringify(columnOrder)); } catch (_) {}
}

// Returns visible columns in current drag order
function getOrderedVisibleCols() {
    const order = getColumnOrder();
    return order
        .map(key => EPIC_EXTRA_COLUMNS.find(c => c.key === key))
        .filter(c => c && EpicColumns.visible.has(c.key));
}

// ── Resolve epic — only epic-level assignee ──────────────────
function getParentEpic(issue) {
    const fields = issue.fields || {};
    const parent = fields.parent;
    if (parent?.key) return {
        key:      parent.key,
        summary:  parent.fields?.summary || parent.key,
        status:   parent.fields?.status?.name || '—',
        assignee: parent.fields?.assignee?.displayName || '—',
        dueDate:  parent.fields?.duedate || '—',
    };
    const epic = fields.epic;
    if (epic?.key) return {
        key:      epic.key,
        summary:  epic.summary || epic.name || epic.key,
        status:   epic.status?.name || '—',
        assignee: epic.assignee?.displayName || '—',
        dueDate:  '—',
    };
    const epicLinkKey = fields['customfield_10014'];
    if (epicLinkKey && typeof epicLinkKey === 'string') return {
        key: epicLinkKey, summary: fields['customfield_10008'] || epicLinkKey,
        status: '—', assignee: '—', dueDate: '—',
    };
    return null;
}

// ── Build data ───────────────────────────────────────────────
export function buildEpicTableData() {
    const epicMap = new Map();

    State.currentIssues.forEach(issue => {
        const epic = getParentEpic(issue);
        if (!epic) return;

        if (!epicMap.has(epic.key)) {
            epicMap.set(epic.key, {
                key:         epic.key,
                summary:     epic.summary,
                status:      epic.status,
                // Epic-level assignee from parent/epic field directly
                assignee:    epic.assignee,
                dueDate:     epic.dueDate,
                issueCount:  0,
                dueDates:    epic.dueDate !== '—' ? [epic.dueDate] : [],
                sprintNames: new Set(),
                priorities:  new Map(),
                componentSet:new Set(),
            });
        }

        const row    = epicMap.get(epic.key);
        const fields = issue.fields || {};
        row.issueCount++;

        // Due date from child issues as fallback
        if (fields.duedate && !row.dueDates.includes(fields.duedate)) {
            row.dueDates.push(fields.duedate);
        }

        // Sprint name from customfield_10020
        const sf = fields.customfield_10020;
        if (Array.isArray(sf)) {
            sf.forEach(s => { const n = s?.name || s?.sprintName; if (n) row.sprintNames.add(n); });
        } else if (sf?.name) {
            row.sprintNames.add(sf.name);
        }

        // Priority tally
        const pName = fields.priority?.name || 'None';
        row.priorities.set(pName, (row.priorities.get(pName) || 0) + 1);

        // Components
        (fields.components || []).forEach(c => { if (c.name) row.componentSet.add(c.name); });
    });

    epicTableData = Array.from(epicMap.values()).map(r => {
        // Nearest upcoming due date
        let dueDate = r.dueDate;
        if (r.dueDates.length > 0) {
            const today  = new Date().toISOString().slice(0, 10);
            const sorted = [...r.dueDates].sort();
            const future = sorted.filter(d => d >= today);
            dueDate = future.length > 0 ? future[0] : sorted[sorted.length - 1];
        }

        const topPriorities = [...r.priorities.entries()]
            .sort((a, b) => b[1] - a[1]).map(([k]) => k);

        return {
            key:        r.key,
            summary:    r.summary,
            status:     r.status,
            issueCount: r.issueCount,
            assignee:   r.assignee,   // Epic-level only
            dueDate,
            sprint:     r.sprintNames.size > 0 ? [...r.sprintNames].join(', ') : '—',
            priority:   topPriorities.length > 0 ? topPriorities.join(', ') : '—',
            components: r.componentSet.size > 0 ? [...r.componentSet].join(', ') : '—',
        };
    }).sort((a, b) => {
        const doneA = a.status.toLowerCase() === 'done' ? 1 : 0;
        const doneB = b.status.toLowerCase() === 'done' ? 1 : 0;
        if (doneA !== doneB) return doneA - doneB;
        return b.issueCount - a.issueCount;
    });

    epicCurrentPage = 1;
    syncTableHeader();
    renderEpicTable();
}

// ── Sync thead ───────────────────────────────────────────────
function syncTableHeader() {
    const thead = document.querySelector('.epic-table thead tr');
    if (!thead) return;
    thead.querySelectorAll('th[data-extra-col]').forEach(th => th.remove());

    getOrderedVisibleCols().forEach(col => {
        const th = document.createElement('th');
        th.setAttribute('data-extra-col', col.key);
        th.setAttribute('draggable', 'true');
        th.style.whiteSpace  = 'nowrap';
        th.style.cursor      = 'grab';
        th.style.userSelect  = 'none';
        th.innerHTML = `${col.label} <i class="fas fa-grip-vertical" style="font-size:0.6rem;opacity:0.4;margin-left:4px;"></i>`;
        attachDragToTh(th, col.key);
        thead.appendChild(th);
    });
}

// ── Drag-and-drop for column reorder ────────────────────────
let dragSrcKey = null;

function attachDragToTh(th, key) {
    th.addEventListener('dragstart', e => {
        dragSrcKey = key;
        e.dataTransfer.effectAllowed = 'move';
        th.style.opacity = '0.4';
    });
    th.addEventListener('dragend', () => { th.style.opacity = '1'; });
    th.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
    th.addEventListener('drop', e => {
        e.preventDefault();
        if (dragSrcKey && dragSrcKey !== key) {
            const order  = getColumnOrder();
            const fromIdx = order.indexOf(dragSrcKey);
            const toIdx   = order.indexOf(key);
            if (fromIdx !== -1 && toIdx !== -1) {
                order.splice(fromIdx, 1);
                order.splice(toIdx, 0, dragSrcKey);
                columnOrder = order;
                saveColumnOrder();
                syncTableHeader();
                renderEpicTable();
            }
        }
        dragSrcKey = null;
    });
}

// ── Render rows ──────────────────────────────────────────────
export function renderEpicTable() {
    const tbody   = document.getElementById('epicTableBody');
    const countEl = document.getElementById('epicTableCount');
    if (!tbody) return;

    const visibleCols = getOrderedVisibleCols();
    const totalCols   = 3 + visibleCols.length;

    const searchQ  = (document.getElementById('epicSearchInput')?.value || '').toLowerCase();
    const filtered = searchQ
        ? epicTableData.filter(r =>
            r.summary.toLowerCase().includes(searchQ) ||
            r.key.toLowerCase().includes(searchQ) ||
            r.status.toLowerCase().includes(searchQ))
        : epicTableData;

    if (countEl) countEl.textContent = filtered.length;
    const totalPages = Math.max(1, Math.ceil(filtered.length / EPIC_PAGE_SIZE));
    if (epicCurrentPage > totalPages) epicCurrentPage = totalPages;

    const start    = (epicCurrentPage - 1) * EPIC_PAGE_SIZE;
    const pageRows = filtered.slice(start, start + EPIC_PAGE_SIZE);

    tbody.innerHTML = '';

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${totalCols}" style="text-align:center;color:#5e6c84;padding:28px 0;">
            ${State.currentIssues.length === 0 ? 'Select a sprint to load Epic data' : 'No epics found'}
        </td></tr>`;
        renderEpicPagination(0, 1, 1);
        return;
    }

    pageRows.forEach(row => {
        const tr = document.createElement('tr');
        let cells = `
            <td><span class="issue-key">${escapeHtml(row.key)}</span></td>
            <td class="summary-cell" title="${escapeHtml(row.summary)}">${escapeHtml(row.summary)}</td>
            <td><span class="status-pill ${getStatusClass(row.status)}">${escapeHtml(row.status)}</span></td>
        `;
        visibleCols.forEach(col => {
            let val = row[col.key];
            if (val === undefined || val === null || val === '') val = '—';
            else if (col.key === 'dueDate' && val !== '—') {
                const d   = new Date(val);
                const fmt = isNaN(d.getTime()) ? val : d.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
                const isOverdue = new Date(val) < new Date();
                cells += `<td style="white-space:nowrap;font-size:0.8rem;${isOverdue ? 'color:#bf2600;font-weight:600;' : ''}">${fmt}${isOverdue ? ' ⚠' : ''}</td>`;
            } else {
                cells += `<td style="font-size:0.8rem;color:#44546f;max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(String(val))}">${escapeHtml(String(val))}</td>`;
            }
        });
        tr.innerHTML = cells;
        tbody.appendChild(tr);
    });

    renderEpicPagination(filtered.length, epicCurrentPage, totalPages);
}

// ── Pagination ───────────────────────────────────────────────
function renderEpicPagination(total, currentPage, totalPages) {
    const container = document.getElementById('epicPagination');
    if (!container) return;
    if (totalPages <= 1 && total === 0) { container.innerHTML = ''; return; }
    const start = (currentPage - 1) * EPIC_PAGE_SIZE + 1;
    const end   = Math.min(currentPage * EPIC_PAGE_SIZE, total);
    container.innerHTML = `
        <div class="pagination-info">
            ${total > 0 ? `Showing <strong>${start}–${end}</strong> of <strong>${total}</strong> epics` : ''}
        </div>
        <div class="pagination-controls">
            <button class="page-btn${currentPage <= 1 ? ' disabled' : ''}" id="epicPrevBtn" ${currentPage <= 1 ? 'disabled' : ''}>
                <i class="fas fa-chevron-left"></i> Prev
            </button>
            <span class="page-indicator">${currentPage} / ${totalPages}</span>
            <button class="page-btn${currentPage >= totalPages ? ' disabled' : ''}" id="epicNextBtn" ${currentPage >= totalPages ? 'disabled' : ''}>
                Next <i class="fas fa-chevron-right"></i>
            </button>
        </div>
    `;
    document.getElementById('epicPrevBtn')?.addEventListener('click', () => {
        if (epicCurrentPage > 1) { epicCurrentPage--; renderEpicTable(); }
    });
    document.getElementById('epicNextBtn')?.addEventListener('click', () => {
        if (epicCurrentPage < totalPages) { epicCurrentPage++; renderEpicTable(); }
    });
}

// ── Column dropdown ──────────────────────────────────────────
export function initEpicColumnDropdown() {
    const btn  = document.getElementById('epicAddColumnBtn');
    const menu = document.getElementById('epicColumnMenu');
    if (!btn || !menu) return;

    function rebuildMenu() {
        menu.innerHTML = '';
        getColumnOrder()
            .map(key => EPIC_EXTRA_COLUMNS.find(c => c.key === key))
            .filter(Boolean)
            .forEach(col => {
                const isOn = EpicColumns.visible.has(col.key);
                const item = document.createElement('label');
                item.className = 'epic-col-menu-item';
                item.innerHTML = `
                    <span class="epic-col-checkbox-wrap">
                        <input type="checkbox" data-col-key="${col.key}" ${isOn ? 'checked' : ''}>
                        <span class="epic-col-custom-check"></span>
                    </span>
                    <span>${col.label}</span>
                `;
                item.querySelector('input').addEventListener('change', e => {
                    if (e.target.checked) EpicColumns.visible.add(col.key);
                    else                  EpicColumns.visible.delete(col.key);
                    saveEpicColumnsToStorage();
                    syncTableHeader();
                    renderEpicTable();
                });
                menu.appendChild(item);
            });
    }

    btn.addEventListener('click', e => { e.stopPropagation(); rebuildMenu(); menu.classList.toggle('show'); });
    document.addEventListener('click', e => {
        if (!btn.contains(e.target) && !menu.contains(e.target)) menu.classList.remove('show');
    });
}