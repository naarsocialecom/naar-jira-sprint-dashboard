// ============================================================
// CHART-PLUGINS.JS — Chart.js custom plugins
// Register once, used by all charts.
// ============================================================

const verticalBarLabelsPlugin = {
    id: 'verticalBarLabels',
    afterDatasetsDraw(chart) {
        if (chart.config.options?.indexAxis === 'y') return;
        const { ctx } = chart;
        ctx.save();
        ctx.font = 'bold 13px Inter, system-ui, sans-serif';
        ctx.fillStyle = '#1e2a3a';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        chart.data.datasets.forEach((dataset, di) => {
            const meta = chart.getDatasetMeta(di);
            if (!meta || meta.hidden) return;
            meta.data.forEach((bar, i) => {
                const value = dataset.data[i];
                if (value > 0) ctx.fillText(String(value), bar.x, bar.y - 4);
            });
        });
        ctx.restore();
    }
};

const horizontalBarLabelsPlugin = {
    id: 'horizontalBarLabels',
    afterDatasetsDraw(chart) {
        if (chart.config.options?.indexAxis !== 'y') return;
        const { ctx } = chart;
        ctx.save();
        ctx.font = 'bold 12px Inter, system-ui, sans-serif';
        ctx.fillStyle = '#1e2a3a';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        chart.data.datasets.forEach((dataset, di) => {
            const meta = chart.getDatasetMeta(di);
            if (!meta || meta.hidden) return;
            meta.data.forEach((bar, i) => {
                const value = dataset.data[i];
                if (value > 0) ctx.fillText(String(value), bar.x + 5, bar.y);
            });
        });
        ctx.restore();
    }
};

const donutCenterPlugin = {
    id: 'donutCenter',
    afterDraw(chart) {
        if (chart.config.type !== 'doughnut') return;
        const { ctx, chartArea } = chart;
        if (!chartArea) return;
        const cx = (chartArea.left + chartArea.right)  / 2;
        const cy = (chartArea.top  + chartArea.bottom) / 2;
        const outerRadius = Math.min(chartArea.right - chartArea.left, chartArea.bottom - chartArea.top) / 2;
        const innerRadius = outerRadius * 0.60;
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, innerRadius - 2, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        const total = chart.data.datasets[0].data.reduce((a, b) => Number(a) + Number(b), 0);
        ctx.font = 'bold 26px Inter, system-ui, sans-serif';
        ctx.fillStyle = '#172b4d';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(total), cx, cy - 9);
        ctx.font = '500 11px Inter, system-ui, sans-serif';
        ctx.fillStyle = '#5e6c84';
        ctx.fillText('Total', cx, cy + 13);
        ctx.restore();
    }
};

export function registerChartPlugins() {
    Chart.register(verticalBarLabelsPlugin, horizontalBarLabelsPlugin, donutCenterPlugin);
}
