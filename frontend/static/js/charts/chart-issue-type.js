// ============================================================
// CHART-ISSUE-TYPE.JS — Issue Types Bar Chart
// To change this chart's appearance or logic, edit ONLY this file.
// ============================================================

import { Settings } from '../modules/state.js';
import { addCompactLegend } from '../modules/legend.js';

let _instance = null;

export function updateIssueBarChart(sortedTypeMap) {
    const ctx = document.getElementById('issueTypeChart');
    if (!ctx) return;

    const labels    = Array.from(sortedTypeMap.keys());
    const data      = Array.from(sortedTypeMap.values());
    const colors    = Settings.barColors.issueType;
    const barColors = data.map((_, i) => colors[i % colors.length]);

    if (_instance) { _instance.destroy(); _instance = null; }

    _instance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Number of Issues',
                data,
                backgroundColor: barColors,
                borderWidth: 0,
                borderRadius: 8,
                barPercentage: 0.7,
                categoryPercentage: 0.8
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: true,
            layout: { padding: { top: 28 } },
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: c => `${c.raw} issues` } }
            },
            scales: {
                y: {
                    beginAtZero: true, grid: { display: false },
                    title: { display: true, text: 'Issue Count', font: { weight: 'bold' } },
                    ticks: { stepSize: 1 }
                },
                x: { grid: { display: false }, ticks: { font: { weight: '500' } } }
            }
        }
    });
    addCompactLegend('issueTypeChart', labels, barColors, data);
}

export function destroyIssueBarChart() {
    if (_instance) { _instance.destroy(); _instance = null; }
}
