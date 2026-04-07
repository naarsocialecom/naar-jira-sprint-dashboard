// ============================================================
// CHART-HEAT.JS — Heat Distribution (Bug × Incident by Priority)
// To change this chart's appearance or logic, edit ONLY this file.
// ============================================================

import { Settings } from '../modules/state.js';
import { addCompactLegend } from '../modules/legend.js';
import { PRIORITY_ORDER } from '../modules/helpers.js';

let _instance = null;

export function updateHeatClusteredChart(heatData) {
    const ctx = document.getElementById('heatChart');
    if (!ctx) return;

    const typeColors = {
        Bug:      Settings.barColors.heat.Bug,
        Incident: Settings.barColors.heat.Incident
    };
    const issueTypes = ['Bug', 'Incident'];

    const prioritiesWithData = PRIORITY_ORDER.filter(
        p => (heatData.Bug?.[p] || 0) > 0 || (heatData.Incident?.[p] || 0) > 0
    );

    const datasets = issueTypes.map(type => ({
        label: type,
        data: prioritiesWithData.map(p => heatData[type]?.[p] || 0),
        backgroundColor: typeColors[type],
        borderWidth: 0,
        borderRadius: 4,
        barPercentage: 0.85,
        categoryPercentage: 0.85
    }));

    if (_instance) { _instance.destroy(); _instance = null; }

    _instance = new Chart(ctx, {
        type: 'bar',
        data: { labels: prioritiesWithData, datasets },
        options: {
            responsive: true, maintainAspectRatio: true,
            layout: { padding: { top: 28 } },
            plugins: {
                legend: { display: false },
                tooltip: {
                    mode: 'index', intersect: false,
                    callbacks: { label: c => `${c.dataset.label}: ${c.raw} issues` }
                }
            },
            scales: {
                x: {
                    title: { display: true, text: 'Priority', font: { weight: 'bold', size: 13 } },
                    grid: { display: false }, stacked: false
                },
                y: {
                    beginAtZero: true,
                    title: { display: true, text: 'Issue Count', font: { weight: 'bold', size: 13 } },
                    grid: { display: false },
                    ticks: { stepSize: 1, precision: 0 },
                    afterFit: s => {
                        const m = Math.max(...datasets.flatMap(d => d.data), 0);
                        s.max = m + Math.max(2, m * 0.15);
                    }
                }
            }
        }
    });

    addCompactLegend(
        'heatChart',
        issueTypes,
        issueTypes.map(t => typeColors[t]),
        issueTypes.map(t => prioritiesWithData.reduce((sum, p) => sum + (heatData[t]?.[p] || 0), 0))
    );
}

export function destroyHeatChart() {
    if (_instance) { _instance.destroy(); _instance = null; }
}
