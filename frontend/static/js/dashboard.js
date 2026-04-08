// ============================================================
// DASHBOARD.JS — Entry point
// ============================================================

import { loadSettingsFromStorage } from './modules/state.js';
import { registerChartPlugins }    from './modules/chart-plugins.js';
import { initSettingsPanel }       from './modules/settings-panel.js';
import { setupHighlightsToggle, loadHighlights } from './modules/highlights.js';
import { fetchSprints, setupDropdowns, setupSprintEventListeners, loadIssuesForSprints } from './modules/sprints.js';
import { renderEpicTable, initEpicColumnDropdown } from './modules/epic-table.js';
import { refreshAllChartsAndMetrics } from './modules/orchestrator.js';
import { initEpicStatusFilter } from './modules/platform.js';

async function initDashboard() {
    loadSettingsFromStorage();
    registerChartPlugins();
    initSettingsPanel();
    setupHighlightsToggle();
    loadHighlights();

    try {
        await fetchSprints();
        setupDropdowns();
        setupSprintEventListeners();
    } catch (error) {
        console.error('Failed to initialize sprints:', error);
    }

    document.getElementById('epicSearchInput')
        ?.addEventListener('input', () => renderEpicTable());

    initEpicColumnDropdown();
    initEpicStatusFilter();

    document.addEventListener('naar:settingsChanged', () => refreshAllChartsAndMetrics());

    // ── Refresh button ──────────────────────────────────────
    const refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
            if (refreshBtn.classList.contains('spinning')) return;
            refreshBtn.classList.add('spinning');
            refreshBtn.disabled = true;
            try {
                await Promise.all([loadHighlights(), loadIssuesForSprints()]);
            } finally {
                setTimeout(() => { refreshBtn.classList.remove('spinning'); refreshBtn.disabled = false; }, 600);
            }
        });
    }

    initExportMenu();
}

// ── Export ──────────────────────────────────────────────────
function initExportMenu() {
    const trigger = document.getElementById('exportTriggerBtn');
    const menu    = document.getElementById('exportMenu');
    if (!trigger || !menu) return;

    trigger.addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('show'); });
    document.addEventListener('click', e => {
        if (!trigger.contains(e.target) && !menu.contains(e.target)) menu.classList.remove('show');
    });

    document.getElementById('exportPng')?.addEventListener('click',  () => { menu.classList.remove('show'); exportDashboard('png');  });
    document.getElementById('exportJpeg')?.addEventListener('click', () => { menu.classList.remove('show'); exportDashboard('jpeg'); });
    document.getElementById('exportPdf')?.addEventListener('click',  () => { menu.classList.remove('show'); exportDashboard('pdf');  });
}

async function exportDashboard(format) {
    // Load html2canvas on demand
    if (!window.html2canvas) {
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js');
    }

    const trigger = document.getElementById('exportTriggerBtn');
    const origHTML = trigger ? trigger.innerHTML : '';
    if (trigger) { trigger.disabled = true; trigger.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }

    // Scroll to top so html2canvas captures from the beginning
    const prevScroll = window.scrollY;
    window.scrollTo(0, 0);

    // Small delay to let page settle after scroll
    await new Promise(r => setTimeout(r, 300));

    try {
        const container = document.querySelector('.dashboard-container');
        const canvas = await html2canvas(container, {
            scale:           2,
            useCORS:         true,
            allowTaint:      true,
            backgroundColor: '#f4f5f7',
            logging:         false,
            // Capture full scrollable height
            height:          container.scrollHeight,
            windowHeight:    container.scrollHeight,
        });

        const fileName = `naar-dashboard-${new Date().toISOString().slice(0, 10)}`;

        if (format === 'pdf') {
            if (!window.jspdf) {
                await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
            }
            const { jsPDF } = window.jspdf;
            const imgData   = canvas.toDataURL('image/jpeg', 0.92);
            // A4 landscape, scale image to fit width
            const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
            const pdfW = pdf.internal.pageSize.getWidth();
            const pdfH = (canvas.height / canvas.width) * pdfW;
            let yPos = 0;
            const pageH = pdf.internal.pageSize.getHeight();
            // Multi-page if tall
            while (yPos < pdfH) {
                if (yPos > 0) pdf.addPage();
                pdf.addImage(imgData, 'JPEG', 0, -yPos, pdfW, pdfH);
                yPos += pageH;
            }
            pdf.save(`${fileName}.pdf`);
        } else {
            const mime    = format === 'jpeg' ? 'image/jpeg' : 'image/png';
            const quality = format === 'jpeg' ? 0.92 : 1.0;
            const link    = document.createElement('a');
            link.download = `${fileName}.${format}`;
            link.href     = canvas.toDataURL(mime, quality);
            link.click();
        }
    } catch (err) {
        console.error('Export failed:', err);
        alert('Export failed — please try again.');
    } finally {
        window.scrollTo(0, prevScroll);
        if (trigger) { trigger.disabled = false; trigger.innerHTML = origHTML; }
    }
}

function loadScript(src) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
        const s = document.createElement('script');
        s.src = src; s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
    });
}

document.addEventListener('DOMContentLoaded', initDashboard);