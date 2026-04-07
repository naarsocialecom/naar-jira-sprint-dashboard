// ============================================================
// HIGHLIGHTS.JS — Highlights section fetch + render
// Isolated: change only this file for highlights changes.
// ============================================================

import { adfToHtml } from './adf-renderer.js';
import { escapeHtml, API_BASE } from './helpers.js';

export async function loadHighlights() {
    const body   = document.getElementById('highlightsBody');
    const sumLbl = document.getElementById('highlightsSummaryLabel');
    if (!body) return;

    try {
        const res  = await fetch(`${API_BASE}/highlights`);
        const data = await res.json();

        if (!res.ok || data.error) {
            body.innerHTML = `<div class="highlights-error"><i class="fas fa-exclamation-triangle"></i> ${escapeHtml(data.error || 'Failed to load highlights')}</div>`;
            return;
        }
        if (sumLbl && data.summary) sumLbl.textContent = `— ${data.summary}`;

        const highlights = data.highlights;
        if (!highlights) {
            body.innerHTML = `<div style="color:#5e6c84;font-size:0.88rem;padding:0.5rem 0;">No highlights content found for ${escapeHtml(data.key)}.</div>`;
            return;
        }
        body.innerHTML = `<div class="adf-content">${adfToHtml(highlights)}</div>`;
    } catch (err) {
        console.error('Highlights load error:', err);
        body.innerHTML = `<div class="highlights-error"><i class="fas fa-exclamation-triangle"></i> Unable to connect to Jira API. Check your configuration.</div>`;
    }
}

export function setupHighlightsToggle() {
    const header = document.getElementById('highlightsToggle');
    const body   = document.getElementById('highlightsBody');
    const btn    = document.getElementById('highlightsToggleBtn');
    if (!header || !body || !btn) return;
    header.addEventListener('click', () => {
        const collapsed = body.classList.toggle('collapsed');
        btn.classList.toggle('collapsed', collapsed);
    });
}
