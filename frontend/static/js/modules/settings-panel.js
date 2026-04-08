// ============================================================
// SETTINGS-PANEL.JS
//   Tab 1: Display  (sort, legend)
//   Tab 2: Columns  (only Issue Count + Due Date)
//   Tab 3: Colors   (chart colors + status colors — clean)
// ============================================================

import { Settings, saveSettingsToStorage } from './state.js';

// ── Only 2 optional columns (removed Assignee, Priority, Sprint) ─
export const EPIC_EXTRA_COLUMNS = [
    { key: 'dueDate',    label: 'Due Date'    },
    { key: 'components', label: 'Components'  },
];

export const EpicColumns = { visible: new Set(['issueCount']) };

export function loadEpicColumnsFromStorage() {
    try {
        const raw = localStorage.getItem('naar_epic_columns');
        if (raw) EpicColumns.visible = new Set(JSON.parse(raw));
    } catch (_) {}
}
export function saveEpicColumnsToStorage() {
    try { localStorage.setItem('naar_epic_columns', JSON.stringify([...EpicColumns.visible])); } catch (_) {}
}

// ── Status color definitions ─────────────────────────────────
export const STATUS_COLOR_DEFS = [
    { key: 'status-backlog',     label: 'Product Backlog',  bg: '#e4e5e7', text: '#42526e' },
    { key: 'status-research',    label: 'In Research',      bg: '#fff8cc', text: '#7d6100' },
    { key: 'status-design',      label: 'In Design',        bg: '#fff8cc', text: '#7d6100' },
    { key: 'status-readyfordev', label: 'Ready for Dev.',   bg: '#f0e6ff', text: '#5e00cc' },
    { key: 'status-development', label: 'In Development',   bg: '#fff8cc', text: '#7d6100' },
    { key: 'status-onhold',      label: 'On-hold',          bg: '#fff0db', text: '#a05000' },
    { key: 'status-cancelled',   label: 'Cancelled',        bg: '#ffe8e5', text: '#9e2a14' },
    { key: 'status-done',        label: 'Done',             bg: '#e3fcef', text: '#006644' },
    { key: 'status-inprogress',  label: 'In Progress',      bg: '#deebff', text: '#0052cc' },
    { key: 'status-todo',        label: 'To Do / Other',    bg: '#f4f5f7', text: '#42526e' },
];
export const StatusColors = {};

export function loadStatusColorsFromStorage() {
    try {
        const raw = localStorage.getItem('naar_status_colors');
        if (raw) Object.assign(StatusColors, JSON.parse(raw));
    } catch (_) {}
    applyStatusColorsToDOM();
}
export function saveStatusColorsToStorage() {
    try { localStorage.setItem('naar_status_colors', JSON.stringify(StatusColors)); } catch (_) {}
}
export function applyStatusColorsToDOM() {
    STATUS_COLOR_DEFS.forEach(def => {
        const ov   = StatusColors[def.key] || {};
        const bg   = ov.bg   || def.bg;
        const text = ov.text || def.text;
        let el = document.getElementById(`sc-${def.key}`);
        if (!el) { el = document.createElement('style'); el.id = `sc-${def.key}`; document.head.appendChild(el); }
        el.textContent = `.${def.key}{background:${bg}!important;color:${text}!important;}`;
    });
}

// ── Panel HTML ───────────────────────────────────────────────
function buildPanelHTML() {
    return `
    <div id="settingsOverlay" class="settings-overlay"></div>
    <div id="settingsPanel" class="settings-panel" role="dialog" aria-label="Dashboard Settings">
        <div class="settings-header">
            <div class="settings-title"><i class="fas fa-sliders-h"></i> Dashboard Settings</div>
            <button id="settingsCloseBtn" class="settings-close-btn" title="Close"><i class="fas fa-times"></i></button>
        </div>
        <div class="settings-tabs">
            <button class="settings-tab active" data-tab="display"><i class="fas fa-desktop"></i> Display</button>
            <button class="settings-tab" data-tab="columns"><i class="fas fa-columns"></i> Columns</button>
            <button class="settings-tab" data-tab="colors"><i class="fas fa-palette"></i> Colors</button>
        </div>

        <!-- TAB: DISPLAY -->
        <div class="settings-body settings-tab-pane active" id="tab-display">
            <div class="settings-section">
                <div class="settings-section-label"><i class="fas fa-sort-amount-down-alt"></i> Sort Order (Bar Charts)</div>
                <div class="settings-radio-group">
                    <label class="settings-radio-option">
                        <input type="radio" name="sortOrder" value="high-to-low">
                        <span class="radio-custom"></span><span class="radio-label">High to Low</span>
                    </label>
                    <label class="settings-radio-option">
                        <input type="radio" name="sortOrder" value="low-to-high">
                        <span class="radio-custom"></span><span class="radio-label">Low to High</span>
                    </label>
                </div>
            </div>
            <div class="settings-section">
                <div class="settings-section-label"><i class="fas fa-list-ul"></i> Legend Style</div>
                <div class="settings-radio-group">
                    <label class="settings-radio-option">
                        <input type="radio" name="legendStyle" value="pills">
                        <span class="radio-custom"></span><span class="radio-label">Pills (compact)</span>
                    </label>
                    <label class="settings-radio-option">
                        <input type="radio" name="legendStyle" value="table">
                        <span class="radio-custom"></span><span class="radio-label">Table (S.No · Title · Count)</span>
                    </label>
                </div>
            </div>
            <div class="settings-section settings-section-reset">
                <button id="settingsResetBtn" class="settings-reset-btn"><i class="fas fa-undo-alt"></i> Reset Display</button>
            </div>
        </div>

        <!-- TAB: COLUMNS -->
        <div class="settings-body settings-tab-pane" id="tab-columns">
            <div class="settings-section">
                <div class="settings-section-label"><i class="fas fa-table"></i> Epic Table Columns</div>
                <p class="settings-hint">Epic Key &amp; Summary are always visible. Toggle extras:</p>
                <div class="column-toggle-list" id="epicColumnToggles"></div>
            </div>
            <div class="settings-section settings-section-reset">
                <button id="columnsResetBtn" class="settings-reset-btn"><i class="fas fa-undo-alt"></i> Reset Columns</button>
            </div>
        </div>

        <!-- TAB: COLORS -->
        <div class="settings-body settings-tab-pane" id="tab-colors">
            <!-- Chart colors -->
            <div class="settings-section">
                <div class="settings-section-label"><i class="fas fa-chart-bar"></i> Issue Type Colors</div>
                <div class="color-grid" id="issueTypeColorGrid"></div>
            </div>
            <div class="settings-section">
                <div class="settings-section-label"><i class="fas fa-cubes"></i> Component Colors</div>
                <div class="color-grid" id="componentColorGrid"></div>
            </div>
            <div class="settings-section">
                <div class="settings-section-label"><i class="fas fa-fire"></i> Heat Chart Colors</div>
                <div class="color-grid" id="heatColorGrid"></div>
            </div>
            <!-- Status colors — compact pill-only format -->
            <div class="settings-section">
                <div class="settings-section-label"><i class="fas fa-tag"></i> Epic Status Colors</div>
                <p class="settings-hint">Click any status pill to change its color.</p>
                <div class="status-pill-grid" id="statusColorList"></div>
            </div>
            <div class="settings-section settings-section-reset">
                <button id="colorsResetBtn" class="settings-reset-btn"><i class="fas fa-undo-alt"></i> Reset Colors</button>
            </div>
        </div>

        <div class="settings-footer">
            <button id="settingsApplyBtn" class="settings-apply-btn"><i class="fas fa-check"></i> Apply Settings</button>
        </div>
    </div>`;
}

// ── Defaults ─────────────────────────────────────────────────
const DEFAULT_COLORS = {
    issueType:    ['#16ecac', '#25d6ee', '#d63a0a', '#ffaa00', '#4d4d4d', '#0755ae'],
    component:    ['#d03100', '#e07d03', '#00aac0', '#00b17c', '#484848', '#0563cf'],
    heatBug:      '#d03100',
    heatIncident: '#e07d03',
};
const ISSUE_TYPE_LABELS = ['Story', 'Improvement', 'Bug', 'Incident', 'Type 5', 'Type 6'];
const COMPONENT_LABELS  = ['Comp 1', 'Comp 2', 'Comp 3', 'Comp 4', 'Comp 5', 'Comp 6'];

// ── Color grid (chart colors) ─────────────────────────────────
function wireColorPair(native, hex) {
    native.addEventListener('input', () => { hex.value = native.value; });
    hex.addEventListener('input', () => { if (/^#[0-9a-fA-F]{6}$/.test(hex.value.trim())) native.value = hex.value.trim(); });
    hex.addEventListener('blur', () => {
        let v = hex.value.trim();
        if (v && !v.startsWith('#')) v = '#' + v;
        if (/^#[0-9a-fA-F]{6}$/.test(v)) { hex.value = v; native.value = v; }
        else hex.value = native.value;
    });
}

function buildColorGrid(containerId, colorArray, labelArray) {
    const grid = document.getElementById(containerId);
    if (!grid) return;
    grid.innerHTML = '';
    colorArray.forEach((color, i) => {
        const item = document.createElement('div');
        item.className = 'color-grid-item';
        item.innerHTML = `
            <span class="color-swatch-name">${labelArray[i] || `Item ${i+1}`}</span>
            <div class="color-inputs">
                <input type="color" class="color-picker-native" data-index="${i}" data-target="${containerId}" value="${color}">
                <input type="text"  class="color-hex-input" data-index="${i}" data-target="${containerId}" value="${color}" maxlength="7" placeholder="#000000" spellcheck="false">
            </div>`;
        wireColorPair(item.querySelector('.color-picker-native'), item.querySelector('.color-hex-input'));
        grid.appendChild(item);
    });
}

function buildHeatColorGrid() {
    const grid = document.getElementById('heatColorGrid');
    if (!grid) return;
    grid.innerHTML = '';
    [{ label:'Bug', key:'heatBug', color: Settings.barColors.heat.Bug },
     { label:'Incident', key:'heatIncident', color: Settings.barColors.heat.Incident }]
    .forEach(({ label, key, color }) => {
        const item = document.createElement('div');
        item.className = 'color-grid-item';
        item.innerHTML = `
            <span class="color-swatch-name">${label}</span>
            <div class="color-inputs">
                <input type="color" class="color-picker-native" data-heat-key="${key}" value="${color}">
                <input type="text"  class="color-hex-input" data-heat-key="${key}" value="${color}" maxlength="7" placeholder="#000000" spellcheck="false">
            </div>`;
        wireColorPair(item.querySelector('.color-picker-native'), item.querySelector('.color-hex-input'));
        grid.appendChild(item);
    });
}

// ── Status colors — compact pill-click design ────────────────
function buildStatusColorList() {
    const container = document.getElementById('statusColorList');
    if (!container) return;
    container.innerHTML = '';

    STATUS_COLOR_DEFS.forEach(def => {
        const ov   = StatusColors[def.key] || {};
        const bg   = ov.bg   || def.bg;
        const text = ov.text || def.text;

        const wrap = document.createElement('div');
        wrap.className = 'status-pill-edit-wrap';

        // The pill itself is the trigger
        wrap.innerHTML = `
            <div class="status-pill-edit-row">
                <span class="status-pill ${def.key} status-pill-editable"
                      style="background:${bg};color:${text};"
                      title="Click to edit colors">
                    ${def.label}
                </span>
                <div class="status-inline-pickers" style="display:none;">
                    <label class="status-picker-compact" title="Background color">
                        <span>BG</span>
                        <input type="color" data-status-key="${def.key}" data-type="bg" value="${bg}">
                        <input type="text" class="color-hex-input" data-status-key="${def.key}" data-type="bg" value="${bg}" maxlength="7">
                    </label>
                    <label class="status-picker-compact" title="Text color">
                        <span>Text</span>
                        <input type="color" data-status-key="${def.key}" data-type="text" value="${text}">
                        <input type="text" class="color-hex-input" data-status-key="${def.key}" data-type="text" value="${text}" maxlength="7">
                    </label>
                </div>
            </div>`;

        // Toggle pickers on pill click
        const pill    = wrap.querySelector('.status-pill-editable');
        const pickers = wrap.querySelector('.status-inline-pickers');
        pill.addEventListener('click', () => {
            const isOpen = pickers.style.display !== 'none';
            // Close all others
            container.querySelectorAll('.status-inline-pickers').forEach(p => { p.style.display = 'none'; });
            pickers.style.display = isOpen ? 'none' : 'flex';
        });

        // Wire pickers to update pill preview live
        wrap.querySelectorAll('label.status-picker-compact').forEach(lbl => {
            const native = lbl.querySelector('input[type=color]');
            const hex    = lbl.querySelector('input[type=text]');
            const sync = () => {
                const bgN   = wrap.querySelector(`input[type=color][data-type="bg"]`)?.value;
                const textN = wrap.querySelector(`input[type=color][data-type="text"]`)?.value;
                if (bgN)   pill.style.background = bgN;
                if (textN) pill.style.color = textN;
            };
            native.addEventListener('input', () => { hex.value = native.value; sync(); });
            hex.addEventListener('input', () => {
                const v = hex.value.trim();
                if (/^#[0-9a-fA-F]{6}$/.test(v)) { native.value = v; sync(); }
            });
            hex.addEventListener('blur', () => {
                let v = hex.value.trim();
                if (v && !v.startsWith('#')) v = '#' + v;
                if (/^#[0-9a-fA-F]{6}$/.test(v)) { hex.value = v; native.value = v; sync(); }
                else hex.value = native.value;
            });
        });

        container.appendChild(wrap);
    });
}

function collectStatusColors() {
    document.querySelectorAll('#statusColorList input[type=color]').forEach(native => {
        const key  = native.dataset.statusKey;
        const type = native.dataset.type;
        if (!key || !type) return;
        if (!StatusColors[key]) StatusColors[key] = {};
        StatusColors[key][type] = native.value;
    });
}

// ── Column toggles ────────────────────────────────────────────
function buildColumnToggles() {
    const list = document.getElementById('epicColumnToggles');
    if (!list) return;
    list.innerHTML = '';
    EPIC_EXTRA_COLUMNS.forEach(col => {
        const isOn = EpicColumns.visible.has(col.key);
        const row  = document.createElement('div');
        row.className = 'column-toggle-row';
        row.innerHTML = `
            <span class="column-toggle-label">${col.label}</span>
            <label class="toggle-switch">
                <input type="checkbox" data-col-key="${col.key}" ${isOn ? 'checked' : ''}>
                <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>`;
        list.appendChild(row);
    });
}

// ── Tabs ──────────────────────────────────────────────────────
function setupTabs() {
    document.querySelectorAll('.settings-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.settings-tab-pane').forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(`tab-${tab.dataset.tab}`)?.classList.add('active');
        });
    });
}

// ── Collect & apply ───────────────────────────────────────────
function collectAndApply() {
    const sortR = document.querySelector('input[name="sortOrder"]:checked');
    if (sortR) Settings.sortOrder = sortR.value;

    const legR = document.querySelector('input[name="legendStyle"]:checked');
    if (legR) Settings.legendStyle = legR.value;

    document.querySelectorAll('#issueTypeColorGrid .color-picker-native').forEach(inp => {
        Settings.barColors.issueType[+inp.dataset.index] = inp.value;
    });
    document.querySelectorAll('#componentColorGrid .color-picker-native').forEach(inp => {
        Settings.barColors.component[+inp.dataset.index] = inp.value;
    });
    document.querySelectorAll('#heatColorGrid .color-picker-native').forEach(inp => {
        if (inp.dataset.heatKey === 'heatBug')      Settings.barColors.heat.Bug      = inp.value;
        if (inp.dataset.heatKey === 'heatIncident') Settings.barColors.heat.Incident = inp.value;
    });

    EpicColumns.visible.clear();
    document.querySelectorAll('#epicColumnToggles input[type=checkbox]:checked').forEach(cb => {
        EpicColumns.visible.add(cb.dataset.colKey);
    });

    collectStatusColors();
    saveStatusColorsToStorage();
    applyStatusColorsToDOM();
    saveSettingsToStorage();
    saveEpicColumnsToStorage();
    document.dispatchEvent(new CustomEvent('naar:settingsChanged'));
    closePanel();
}

function syncDisplayForm() {
    const s = document.querySelector(`input[name="sortOrder"][value="${Settings.sortOrder}"]`);
    if (s) s.checked = true;
    const l = document.querySelector(`input[name="legendStyle"][value="${Settings.legendStyle}"]`);
    if (l) l.checked = true;
}

function syncFormToSettings() {
    syncDisplayForm();
    buildColorGrid('issueTypeColorGrid', Settings.barColors.issueType, ISSUE_TYPE_LABELS);
    buildColorGrid('componentColorGrid',  Settings.barColors.component,  COMPONENT_LABELS);
    buildHeatColorGrid();
    buildColumnToggles();
    buildStatusColorList();
}

function openPanel() {
    syncFormToSettings();
    document.getElementById('settingsPanel')?.classList.add('open');
    document.getElementById('settingsOverlay')?.classList.add('open');
}
function closePanel() {
    document.getElementById('settingsPanel')?.classList.remove('open');
    document.getElementById('settingsOverlay')?.classList.remove('open');
}

export function initSettingsPanel() {
    loadEpicColumnsFromStorage();
    loadStatusColorsFromStorage();

    const mount = document.createElement('div');
    mount.innerHTML = buildPanelHTML();
    document.body.appendChild(mount);
    setupTabs();

    const headerRight = document.querySelector('.header-right');
    if (headerRight) {
        const btn = document.createElement('button');
        btn.id = 'settingsTriggerBtn'; btn.className = 'settings-trigger-btn';
        btn.title = 'Dashboard Settings'; btn.innerHTML = `<i class="fas fa-sliders-h"></i>`;
        btn.addEventListener('click', openPanel);
        headerRight.appendChild(btn);
    }

    document.getElementById('settingsCloseBtn')?.addEventListener('click', closePanel);
    document.getElementById('settingsOverlay')?.addEventListener('click', closePanel);
    document.getElementById('settingsApplyBtn')?.addEventListener('click', collectAndApply);
    document.getElementById('settingsResetBtn')?.addEventListener('click', () => {
        Settings.sortOrder = 'high-to-low'; Settings.legendStyle = 'pills'; syncDisplayForm();
    });
    document.getElementById('colorsResetBtn')?.addEventListener('click', () => {
        Settings.barColors.issueType     = [...DEFAULT_COLORS.issueType];
        Settings.barColors.component     = [...DEFAULT_COLORS.component];
        Settings.barColors.heat.Bug      = DEFAULT_COLORS.heatBug;
        Settings.barColors.heat.Incident = DEFAULT_COLORS.heatIncident;
        buildColorGrid('issueTypeColorGrid', Settings.barColors.issueType, ISSUE_TYPE_LABELS);
        buildColorGrid('componentColorGrid',  Settings.barColors.component, COMPONENT_LABELS);
        buildHeatColorGrid();
        // Reset status colors
        Object.keys(StatusColors).forEach(k => delete StatusColors[k]);
        buildStatusColorList();
    });
    document.getElementById('columnsResetBtn')?.addEventListener('click', () => {
        EpicColumns.visible = new Set(['issueCount']); buildColumnToggles();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });
}