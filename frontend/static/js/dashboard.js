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

    // ── Export dropdown ─────────────────────────────────────
    initExportMenu();
}

// ── Export: PNG / JPEG / PDF ─────────────────────────────────
function initExportMenu() {
    const trigger = document.getElementById('exportTriggerBtn');
    const menu    = document.getElementById('exportMenu');
    if (!trigger || !menu) return;

    trigger.addEventListener('click', e => {
        e.stopPropagation();
        menu.classList.toggle('show');
    });
    document.addEventListener('click', e => {
        if (!trigger.contains(e.target) && !menu.contains(e.target)) menu.classList.remove('show');
    });

    document.getElementById('exportPng')?.addEventListener('click',  () => { menu.classList.remove('show'); exportDashboard('png');  });
    document.getElementById('exportJpeg')?.addEventListener('click', () => { menu.classList.remove('show'); exportDashboard('jpeg'); });
    document.getElementById('exportPdf')?.addEventListener('click',  () => { menu.classList.remove('show'); exportDashboard('pdf');  });
}

async function exportDashboard(format) {
    // Load html2canvas if not available
    if (!window.html2canvas) {
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js');
    }

    const trigger = document.getElementById('exportTriggerBtn');
    if (trigger) {
        trigger.disabled = true;
        trigger.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    }

    try {
        const container = document.querySelector('.dashboard-container');

        // 🔥 Force Chart.js to fully render
        if (window.Chart) {
            Object.values(Chart.instances).forEach(chart => {
                chart.resize();
                chart.update();
            });
        }

        // 🔥 Wait for DOM + charts to settle
        await new Promise(resolve => setTimeout(resolve, 800));

        // 🔥 Capture FULL page in high quality
        const canvas = await html2canvas(container, {
            scale: 4, // HIGH QUALITY
            useCORS: true,
            backgroundColor: '#f4f5f7',
            scrollX: 0,
            scrollY: 0,
            windowWidth: document.body.scrollWidth,
            windowHeight: document.body.scrollHeight
        });

        const fileName = `naar-dashboard-${new Date().toISOString().slice(0,10)}`;

        // ── PDF Export ─────────────────────────────
        if (format === 'pdf') {
            if (!window.jspdf) {
                await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
            }

            const { jsPDF } = window.jspdf;
            const imgData = canvas.toDataURL('image/jpeg', 1.0);

            const pdf = new jsPDF({
                orientation: 'landscape',
                unit: 'px',
                format: [canvas.width, canvas.height]
            });

            pdf.addImage(imgData, 'JPEG', 0, 0, canvas.width, canvas.height);
            pdf.save(`${fileName}.pdf`);
        }

        // ── PNG / JPEG Export ─────────────────────
        else {
            const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';

            const link = document.createElement('a');
            link.download = `${fileName}.${format}`;
            link.href = canvas.toDataURL(mimeType, 1.0);
            link.click();
        }

    } catch (err) {
        console.error('Export failed:', err);
        alert('Export failed. Please try again.');
    } finally {
        if (trigger) {
            trigger.disabled = false;
            trigger.innerHTML = '<i class="fas fa-download"></i>';
        }
    }
}

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s   = document.createElement('script');
        s.src     = src;
        s.onload  = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

document.addEventListener('DOMContentLoaded', initDashboard);