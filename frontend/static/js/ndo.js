// ============================================================
// NDO.JS — Naar Data Operations page (entry point)
// Data: /api/ndo/report · Notes / RAG / Slack: /api/ndo/*
// ============================================================

import { escapeHtml, getStatusClass, API_BASE } from './modules/helpers.js';

const NDO_API = `${API_BASE}/ndo`;
const $ = id => document.getElementById(id);

let report      = null;
let typeFilter  = 'All';
// ?day=YYYY-MM-DD shows a past day's summary (read-only)
const VIEW_DAY  = new URLSearchParams(location.search).get('day');

const SOURCE_ICONS = {
    slack:     '<i class="fab fa-slack" title="From Slack"></i>',
    jira:      '<i class="fab fa-jira" title="Ticket closed today — written from its Jira comments"></i>',
    dashboard: '<i class="fas fa-keyboard" title="Added on dashboard"></i>',
};

// ── API ──────────────────────────────────────────────────────
async function api(path, options = {}) {
    const res = await fetch(`${NDO_API}${path}`, {
        headers: { 'Content-Type': 'application/json', 'X-NDO-Request': '1' },
        ...options,
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* non-JSON error page */ }
    if (!res.ok && res.status !== 409) throw new Error(data.error || `Request failed (${res.status})`);
    return { status: res.status, data };
}

async function loadReport(refresh = false) {
    try {
        const params = new URLSearchParams();
        if (refresh) params.set('refresh', '1');
        if (VIEW_DAY) params.set('day', VIEW_DAY);
        const { data } = await api(`/report${params.toString() ? `?${params}` : ''}`);
        report = data;
        $('ndoError').classList.add('ndo-hidden');
        render();
        document.body.dataset.ready = '1';   // signals the Slack screenshot job that data is drawn
    } catch (err) {
        console.error('NDO report error:', err);
        const box = $('ndoError');
        box.innerHTML = `<i class="fas fa-exclamation-triangle"></i> ${escapeHtml(err.message)}`;
        box.classList.remove('ndo-hidden');
        $('ndoUpdatedLabel').textContent = 'Failed to load';
        document.body.dataset.ready = 'error';
    }
}

// ── Render ───────────────────────────────────────────────────
const chipClass = v => String(v).replace(/[^A-Za-z0-9-]/g, '-');
const chip      = (v, prefix = '') => `<span class="ndo-chip ndo-chip--${prefix}${chipClass(v)}">${escapeHtml(v)}</span>`;
const keyLink   = t => `<a href="${escapeHtml(t.url)}" target="_blank" rel="noopener" class="ndo-key">${escapeHtml(t.key)}</a>`;
const timeLabel = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// Escapes text and turns ticket keys (e.g. NDO-873) into Jira links
function linkify(text) {
    const html     = escapeHtml(text);
    const prefixes = (report?.ticket_prefixes || []).map(p => p.replace(/[^A-Za-z0-9]/g, '')).filter(Boolean);
    if (!prefixes.length) return html;
    const re = new RegExp(`\\b((?:${prefixes.join('|')})-\\d+)\\b`, 'gi');
    return html.replace(re, key => {
        const k = key.toUpperCase();
        return `<a href="${escapeHtml(report.jira_browse_url + k)}" target="_blank" rel="noopener">${k}</a>`;
    });
}

function render() {
    const { totals, rag } = report;
    $('ndoUpdatedLabel').textContent = report.is_today ? `Updated ${timeLabel(report.generated_at)}` : `Past day · ${report.date_label}`;
    document.body.classList.toggle('ndo-past', !report.is_today);
    $('ndoTitleCell').textContent = `Daily Update · ${report.date_label}`;
    $('ndoJql').textContent = report.jql;

    $('tileIncident').textContent   = totals.by_type.Incident ?? 0;
    $('tileOps').textContent        = totals.by_type.Operations ?? 0;
    $('tileCritical').textContent   = totals.critical_high;
    $('tileUnassigned').textContent = totals.unassigned;
    $('tileNew').textContent        = totals.new_24h;

    // RAG banner
    $('ndoRagCell').className = `ndo-rag-banner ndo-rag--${rag.level}`;
    $('ndoRagLabel').textContent = rag.overridden ? `${rag.label} · set manually` : rag.label;
    $('ndoRagSelect').value = rag.overridden ? rag.level : '';
    $('ndoRagReasons').innerHTML = rag.reasons.map(r => `<li>${escapeHtml(r)}</li>`).join('');

    renderDevUpdates();
    renderBreakdowns();
    renderSlackStatus();
    renderTypeFilter();
    renderTickets();
}

function renderDevUpdates() {
    const updates = report.dev_updates || [];
    const s       = report.slack;
    $('ndoDevCount').textContent = updates.length;

    // Only problems are shown here; a healthy sync stays quiet
    const meta = $('ndoDevMeta');
    meta.textContent = s.dev_sync_error ? `Slack: ${s.dev_sync_error}`
        : (!s.enabled || !s.dev_channel_id) ? 'Slack updates channel not connected' : '';
    meta.className   = 'ndo-panel-meta ndo-panel-meta--warn';

    $('ndoDevDetails').hidden = !updates.length;
    if (!updates.length) {
        $('ndoDigest').innerHTML = report.is_today
            ? `<li class="ndo-dev-empty"><i class="fas fa-hourglass-half"></i>
                <span><b>No developer updates yet today.</b> The ${escapeHtml(s.post_time)} Slack post is skipped until one is in.</span></li>`
            : '<li class="ndo-dev-empty"><i class="fas fa-inbox"></i><span>No developer updates were recorded for this day.</span></li>';
        $('ndoDevUpdates').innerHTML = '';
        return;
    }
    $('ndoDigest').innerHTML = (report.digest || []).map(line =>
        `<li><i class="ndo-digest-dot" aria-hidden="true"></i><span>${linkify(line)}</span></li>`).join('');
    // Compact timeline: time · status dot · one-line update · small ticket tags
    $('ndoDevUpdates').innerHTML = updates.map(u => {
        const refs  = u.ticket_refs || [];
        const state = ticketState(refs[0]?.status);
        const tags  = refs.map(r => {
            const level = r.severity || (URGENT.has(r.priority) ? r.priority : '');
            const tip   = r.summary ? `${r.key} — ${r.summary}` : `${r.key} — not found in Jira`;
            return `<a class="ndo-tag ndo-tag--${ticketState(r.status)}" href="${escapeHtml(r.url)}" target="_blank"
                       rel="noopener" title="${escapeHtml(tip)}"><b>${escapeHtml(r.key)}</b>${r.status ? ` · ${escapeHtml(r.status)}` : ''}${level ? ` · ${escapeHtml(level)}` : ''}</a>`;
        }).join('');
        // Jira briefs can hold customer details from the description, so only Slack/typed originals are shown
        const original = u.rephrased && u.raw_text && u.source !== 'jira' ? ` title="Original: ${escapeHtml(u.raw_text)}"` : '';
        return `<li class="ndo-tl ndo-tl--${state}">
            <span class="ndo-tl-time">${timeLabel(u.created_at)}</span>
            <span class="ndo-tl-dot" aria-hidden="true"></span>
            <div class="ndo-tl-body">
                <div class="ndo-dev-text"${original}>${linkify(u.text)}</div>
                <div class="ndo-tl-tags">${tags}
                    <span class="ndo-tl-src">${SOURCE_ICONS[u.source] || SOURCE_ICONS.dashboard}${u.rephrased ? '<span class="ndo-dev-ai" title="Rephrased by AI">AI</span>' : ''}</span>
                </div>
            </div>
            ${u.source === 'slack' || u.source === 'jira' ? '' : `<button class="ndo-note-del" data-id="${escapeHtml(u.id)}" title="Remove update" aria-label="Remove update"><i class="fas fa-times"></i></button>`}
        </li>`;
    }).join('');
}

const URGENT = new Set(['Critical', 'Highest', 'High']);

// done / active / hold / todo — drives the timeline dot and tag colours
function ticketState(status) {
    const cls = getStatusClass(status || '');
    if (!status) return 'none';
    if (cls === 'status-done' || cls === 'status-cancelled') return 'done';
    if (cls === 'status-onhold' || cls === 'status-blocked') return 'hold';
    if (cls === 'status-todo' || cls === 'status-backlog')   return 'todo';
    return 'active';
}

function renderBreakdowns() {
    // Today: closed (from tickets closed today) and how many open tickets are moving or stuck
    const closed = (report.dev_updates || []).filter(u => u.source === 'jira').length;
    const byState = { active: 0, hold: 0 };
    Object.entries(report.breakdown.status).forEach(([status, byType]) => {
        const st = ticketState(status);
        if (st in byState) byState[st] += Object.values(byType).reduce((a, b) => a + b, 0);
    });
    $('ndoTodayStats').innerHTML = [
        ['done', closed, report.is_today ? 'Closed today' : 'Closed that day'], ['active', byState.active, 'In progress'], ['hold', byState.hold, 'On hold'],
    ].map(([cls, n, label]) => `<div class="ndo-today-stat ndo-today--${cls}"><b>${n}</b><span>${label}</span></div>`).join('');

    $('ndoSeverity').innerHTML = Object.entries(report.breakdown.severity).map(([sev, n]) =>
        `<div class="ndo-sev ndo-sev--${chipClass(sev)}${n ? '' : ' is-zero'}"><b>${n}</b><span>${escapeHtml(sev)}</span></div>`
    ).join('');

    const rows  = Object.entries(report.breakdown.priority)
        .map(([name, byType]) => [name, Object.values(byType).reduce((a, b) => a + b, 0)]);
    const total = rows.reduce((a, [, n]) => a + n, 0) || 1;
    $('ndoPriorityBars').innerHTML = rows.map(([name, n]) => `
        <div class="ndo-bar-row">
            <span class="ndo-bar-label">${escapeHtml(name)}</span>
            <div class="ndo-bar-track"><div class="ndo-bar-fill ndo-bar--${chipClass(name)}" style="width:${Math.max(2, n / total * 100).toFixed(1)}%"></div></div>
            <span class="ndo-bar-value">${n}</span>
        </div>`).join('');
}

function renderSlackStatus() {
    const s   = report.slack;
    const box = $('ndoSlackStatus');
    const n   = (report.dev_updates || []).length;
    let cls = '', html;
    if (!s.enabled) {
        cls  = 'ndo-slack-status--off';
        html = '<i class="fas fa-plug"></i> Slack not connected — set <code>SLACK_BOT_TOKEN</code>, <code>SLACK_CHANNEL_ID</code> and <code>SLACK_DEV_UPDATES_CHANNEL_ID</code> in <code>backend/.env</code>.';
    } else if (s.posted_at) {
        cls  = 'ndo-slack-status--done';
        html = `<i class="fas fa-check-circle"></i> Today's update was posted at ${timeLabel(s.posted_at)}.`;
    } else if (!n) {
        cls  = 'ndo-slack-status--off';
        html = `<i class="fas fa-hourglass-half"></i> No developer updates yet — the ${escapeHtml(s.post_time)} post will be skipped until updates come in.${s.reminder_sent ? ' Reminder sent.' : ''}`;
    } else {
        html = `<i class="fab fa-slack"></i> ${n} developer update${n === 1 ? '' : 's'} ready · posts at ${escapeHtml(s.post_time)}${s.reminder_sent ? ' · reminder sent' : ''}.`;
    }
    box.className = `ndo-slack-status ${cls}`;
    box.innerHTML = html;
    const devReady = s.enabled && !!s.dev_channel_id;
    $('ndoSlackSync').disabled   = !devReady;
    $('ndoDevSyncBtn').disabled  = !devReady;
    $('ndoSlackRemind').disabled = !s.enabled;
    $('ndoSlackPost').disabled   = !s.enabled || n === 0;
    $('ndoPostHint').textContent = n === 0
        ? 'Disabled — add or fetch developer updates first.'
        : `Runs automatically at ${s.post_time}.`;
}

function renderTypeFilter() {
    const options = ['All', ...report.issue_types];
    $('ndoTypeFilter').innerHTML = options.map(t =>
        `<button type="button" data-type="${escapeHtml(t)}" class="${t === typeFilter ? 'active' : ''}">${escapeHtml(t)}</button>`
    ).join('');
}

// Incidents first, then Operations (order of NDO_ISSUE_TYPES); newest ticket number first within each
function ticketOrder(a, b) {
    const rank = t => { const i = report.issue_types.indexOf(t.type); return i === -1 ? report.issue_types.length : i; };
    const num  = t => parseInt(t.key.split('-').pop(), 10) || 0;
    return rank(a) - rank(b) || num(b) - num(a);
}

function renderTickets() {
    const q = $('ndoSearch').value.trim().toLowerCase();
    const list = report.tickets.filter(t =>
        (typeFilter === 'All' || t.type === typeFilter) &&
        (!q || [t.key, t.summary, t.assignee || '', t.status].some(v => v.toLowerCase().includes(q)))
    ).sort(ticketOrder);
    $('ndoTicketCount').textContent = list.length;
    $('ndoTicketBody').innerHTML = list.length
        ? list.map(t => `<tr>
            <td>${keyLink(t)}</td>
            <td>${chip(t.type, 'type-')}</td>
            <td>${escapeHtml(t.summary)}</td>
            <td><span class="status-pill ${getStatusClass(t.status)}">${escapeHtml(t.status)}</span></td>
            <td>${chip(t.priority)}</td>
            <td>${t.severity !== 'Not set' ? chip(t.severity) : '<span class="ndo-muted">—</span>'}</td>
            <td>${t.assignee ? escapeHtml(t.assignee) : '<span class="ndo-unassigned">Unassigned</span>'}</td>
            <td>${t.age_days ?? '–'}d</td>
          </tr>`).join('')
        : '<tr><td colspan="8" class="ndo-empty">No tickets match</td></tr>';
}

// ── Actions ──────────────────────────────────────────────────
let toastTimer;
function toast(message, isError = false) {
    const el = $('ndoToast');
    el.textContent = message;
    el.classList.toggle('ndo-toast--error', isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 7000 : 3500);
}

async function withBusy(button, fn) {
    if (button.disabled) return;
    button.disabled = true;
    button.classList.add('is-busy');
    try { await fn(); }
    catch (err) { toast(err.message, true); }
    finally {
        button.classList.remove('is-busy');
        button.disabled = false;
        if (report) renderSlackStatus();
    }
}

function bindEvents() {
    // Highlights collapse (same behaviour as the sprint dashboard)
    $('highlightsToggle').addEventListener('click', e => {
        if (e.target.closest('select')) return;
        const collapsed = $('highlightsBody').classList.toggle('collapsed');
        $('highlightsToggleBtn').classList.toggle('collapsed', collapsed);
    });

    const refreshBtn = $('refreshBtn');
    refreshBtn.addEventListener('click', async () => {
        if (refreshBtn.classList.contains('spinning')) return;
        refreshBtn.classList.add('spinning');
        try { await loadReport(true); }
        finally { setTimeout(() => refreshBtn.classList.remove('spinning'), 500); }
    });

    $('ndoRagSelect').addEventListener('change', async e => {
        try {
            await api('/rag', { method: 'POST', body: JSON.stringify({ level: e.target.value || null }) });
            await loadReport();
            toast(e.target.value ? 'RAG override saved for today' : 'RAG back to automatic');
        } catch (err) { toast(err.message, true); }
    });

    // Team notes
    try { $('ndoNoteAuthor').value = localStorage.getItem('ndo_author') || ''; } catch (_) {}
    $('ndoNoteForm').addEventListener('submit', async e => {
        e.preventDefault();
        const text   = $('ndoNoteText').value.trim();
        const author = $('ndoNoteAuthor').value.trim();
        if (!text) return;
        const btn = e.submitter || e.target.querySelector('button[type=submit]');
        await withBusy(btn, async () => {
            await api('/notes', { method: 'POST', body: JSON.stringify({ text, author }) });
            try { localStorage.setItem('ndo_author', author); } catch (_) {}
            $('ndoNoteText').value = '';
            await loadReport();
            toast('Developer update added');
        });
    });
    $('ndoDevUpdates').addEventListener('click', async e => {
        const btn = e.target.closest('.ndo-note-del');
        if (!btn || !confirm('Remove this update?')) return;
        await withBusy(btn, async () => {
            await api(`/notes/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
            await loadReport();
        });
    });

    // Slack
    const syncUpdates = btn => withBusy(btn, async () => {
        const { data } = await api('/slack/sync', { method: 'POST' });
        await loadReport();
        toast(`${data.total} developer update${data.total === 1 ? '' : 's'} today` +
              (data.added ? ` · ${data.added} new` : '') + (data.changed ? ` · ${data.changed} edited` : ''));
    });
    $('ndoSlackSync').addEventListener('click', e => syncUpdates(e.currentTarget));
    $('ndoDevSyncBtn').addEventListener('click', e => { e.stopPropagation(); syncUpdates(e.currentTarget); });
    $('ndoSlackRemind').addEventListener('click', e => withBusy(e.currentTarget, async () => {
        if (!confirm('Send the "1 hour left" reminder to Slack now?')) return;
        await api('/slack/remind', { method: 'POST' });
        await loadReport();
        toast('Reminder sent to Slack');
    }));
    $('ndoSlackPost').addEventListener('click', e => withBusy(e.currentTarget, async () => {
        const already = !!report?.slack?.posted_at;
        if (!confirm(already ? 'Today\'s update was already posted. Post it again?' : 'Post today\'s update to the Slack channel?')) return;
        const { status, data } = await api('/slack/post', { method: 'POST', body: JSON.stringify({ force: already }) });
        await loadReport();
        toast(status === 409 ? data.message : 'Daily update posted to Slack', status === 409);
    }));
    initPreviewModal();

    // Tickets table
    $('ndoSearch').addEventListener('input', () => report && renderTickets());
    $('ndoTypeFilter').addEventListener('click', e => {
        const btn = e.target.closest('button[data-type]');
        if (!btn) return;
        typeFilter = btn.dataset.type;
        renderTypeFilter();
        renderTickets();
    });
}

// ── Slack image preview modal ────────────────────────────────
function initPreviewModal() {
    const modal = $('ndoModal'), img = $('ndoModalImg'), body = $('ndoModalBody');
    let lastFocus = null;

    const close = () => {
        modal.hidden = true;
        document.body.classList.remove('ndo-modal-open');
        lastFocus?.focus();
    };
    const open = () => {
        lastFocus = document.activeElement;
        const src = `${NDO_API}/snapshot.png?t=${Date.now()}${VIEW_DAY ? `&day=${encodeURIComponent(VIEW_DAY)}` : ''}`;
        img.hidden = true;
        body.classList.remove('is-zoomed');
        $('ndoModalZoom').innerHTML = '<i class="fas fa-search-plus"></i> Actual size';
        $('ndoModalLoading').hidden = false;
        $('ndoModalLoading').innerHTML = '<div class="spinner"></div> Rendering the dashboard image…';
        $('ndoModalOpen').href = src;
        img.onload  = () => { $('ndoModalLoading').hidden = true; img.hidden = false; };
        img.onerror = () => { $('ndoModalLoading').innerHTML = '<i class="fas fa-exclamation-triangle"></i> Could not render the image — check the server log.'; };
        img.src = src;
        modal.hidden = false;
        document.body.classList.add('ndo-modal-open');
        $('ndoModalClose').focus();
    };
    const toggleZoom = () => {
        const zoomed = body.classList.toggle('is-zoomed');
        $('ndoModalZoom').innerHTML = zoomed
            ? '<i class="fas fa-search-minus"></i> Fit to screen'
            : '<i class="fas fa-search-plus"></i> Actual size';
    };

    $('ndoPreviewBtn').addEventListener('click', open);
    $('ndoModalClose').addEventListener('click', close);
    $('ndoModalZoom').addEventListener('click', toggleZoom);
    img.addEventListener('click', toggleZoom);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) close(); });
}

document.addEventListener('DOMContentLoaded', () => {
    // ?snapshot=1 → clean, non-interactive view used for the Slack image
    if (new URLSearchParams(location.search).has('snapshot')) document.body.classList.add('ndo-snapshot');
    bindEvents();
    loadReport();
});
