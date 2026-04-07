// ============================================================
// CHART-COMPONENT.JS — Components Horizontal Bar Chart
// To change this chart's appearance or logic, edit ONLY this file.
// ============================================================

import { Settings } from '../modules/state.js';
import { addCompactLegend } from '../modules/legend.js';

let _instance = null;

export function updateComponentBarChart(componentCountMap) {
    const ctx = document.getElementById('componentChart');
    if (!ctx) return;

    const entries   = Array.from(componentCountMap.entries()); // already sorted high→low
    const labels    = entries.map(([name]) => name);
    const data      = entries.map(([, count]) => count);
    const colors    = Settings.barColors.component;
    const barColors = data.map((_, i) => colors[i % colors.length]);

    if (_instance) { _instance.destroy(); _instance = null; }

    _instance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Issues per Component',
                data,
                backgroundColor: barColors,
                borderWidth: 0,
                borderRadius: 6
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true, maintainAspectRatio: true,
            layout: { padding: { right: 50 } },
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: c => `${c.raw} issues` } }
            },
            scales: {
                x: {
                    beginAtZero: true, grid: { display: false },
                    title: { display: true, text: 'Issue Count' },
                    afterFit: s => {
                        const m = Math.max(...data, 0);
                        s.max = m + Math.max(10, m * 0.2);
                    }
                },
                y: { grid: { display: false }, ticks: { font: { size: 11, weight: '500' } } }
            }
        }
    });
    addCompactLegend('componentChart', labels, barColors, data);
}

export function destroyComponentBarChart() {
    if (_instance) { _instance.destroy(); _instance = null; }
}
