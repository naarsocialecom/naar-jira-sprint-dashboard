// ============================================================
// CHART-PRIORITY.JS — Priority Distribution Donut Chart
// To change this chart's appearance or logic, edit ONLY this file.
// ============================================================

import { addDonutCompactLegend } from '../modules/legend.js';

let _instance = null;

const priorityColors = {
    'Critical': '#bf2600',
    'High':     '#ff8b00',
    'Medium':   '#3ad3e8',
    'Low':      '#47bc8a',
    'Lowest':   '#84e2bb',
    'None':     '#8993a4'
};

export function updatePriorityDonutChart(priorityCountMap) {
    const ctx = document.getElementById('priorityChart');
    if (!ctx) return;

    const sortedEntries    = Array.from(priorityCountMap.entries())
        .filter(([, c]) => c > 0)
        .sort((a, b) => b[1] - a[1]);
    const labels           = sortedEntries.map(([name]) => name);
    const data             = sortedEntries.map(([, count]) => count);
    const total            = data.reduce((a, b) => a + b, 0);
    const backgroundColors = labels.map(l => priorityColors[l] || '#79ccb3');

    if (_instance) { _instance.destroy(); _instance = null; }

    _instance = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{
                data,
                backgroundColor: backgroundColors,
                borderWidth: 3,
                borderColor: '#ffffff',
                cutout: '60%'
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: true,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: c => `${c.label}: ${c.raw} (${total > 0 ? ((c.raw/total)*100).toFixed(1) : 0}%)`
                    }
                }
            }
        }
    });
    addDonutCompactLegend('priorityChart', labels, backgroundColors, data, total);
}

export function destroyPriorityDonutChart() {
    if (_instance) { _instance.destroy(); _instance = null; }
}
