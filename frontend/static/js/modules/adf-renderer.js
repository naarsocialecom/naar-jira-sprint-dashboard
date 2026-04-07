// ============================================================
// ADF-RENDERER.JS — Converts Atlassian Document Format → HTML
// Completely self-contained. Touch only this file if Jira
// changes their ADF schema.
// ============================================================

import { escapeHtml } from './helpers.js';

export function adfToHtml(raw) {
    if (!raw) return '';
    let doc = raw;

    if (typeof doc === 'string') {
        const macroMatch = doc.match(/\{adf[^}]*\}([\s\S]*?)\{adf\}/i);
        const jsonStr = macroMatch ? macroMatch[1].trim() : doc.trim();
        try { doc = JSON.parse(jsonStr); }
        catch (_) { return `<p>${escapeHtml(doc)}</p>`; }
    }

    function renderNode(node) {
        if (!node) return '';
        const type = node.type;
        switch (type) {
            case 'doc':         return (node.content || []).map(renderNode).join('');
            case 'paragraph':   return `<p>${(node.content || []).map(renderNode).join('')}</p>`;
            case 'bulletList':  return `<ul>${(node.content || []).map(renderNode).join('')}</ul>`;
            case 'orderedList': return `<ol>${(node.content || []).map(renderNode).join('')}</ol>`;
            case 'listItem':    return `<li>${(node.content || []).map(renderNode).join('')}</li>`;
            case 'blockquote':  return `<blockquote style="border-left:3px solid #dfe1e6;padding-left:0.8rem;color:#5e6c84;">${(node.content || []).map(renderNode).join('')}</blockquote>`;
            case 'codeBlock':   return `<pre style="background:#f4f5f7;padding:0.6rem;border-radius:6px;overflow-x:auto;"><code>${(node.content || []).map(renderNode).join('')}</code></pre>`;
            case 'rule':        return `<hr style="border:none;border-top:1px solid #e9ecef;margin:0.6rem 0;">`;
            case 'heading': {
                const lvl   = node.attrs?.level || 2;
                const sizes = { 1:'1.3rem', 2:'1.1rem', 3:'1rem', 4:'0.95rem', 5:'0.9rem', 6:'0.85rem' };
                return `<h${lvl} style="font-size:${sizes[lvl]||'1rem'};font-weight:700;margin:0.5rem 0 0.2rem;">${(node.content || []).map(renderNode).join('')}</h${lvl}>`;
            }
            case 'table': {
                const rows = (node.content || []).map(renderNode).join('');
                return `<table style="width:100%;border-collapse:collapse;border-radius:8px;overflow:hidden;margin:0.4rem 0;">${rows}</table>`;
            }
            case 'tableRow': {
                const cells    = node.content || [];
                const isHeader = cells.every(c => c.type === 'tableHeader');
                const firstBg  = cells[0]?.attrs?.background;
                const rowStyle = firstBg ? `background-color:${firstBg};` : (isHeader ? 'background:#f4f5f7;' : '');
                return `<tr style="${rowStyle}">${cells.map(c => renderNode(c)).join('')}</tr>`;
            }
            case 'tableHeader':
            case 'tableCell': {
                const attrs   = node.attrs || {};
                const colspan = attrs.colspan  ? `colspan="${attrs.colspan}"` : '';
                const rowspan = attrs.rowspan  ? `rowspan="${attrs.rowspan}"` : '';
                const bg      = attrs.background ? `background-color:${attrs.background};` : '';
                const isHdr   = type === 'tableHeader';
                const tdStyle = `border:1px solid #d0d7de;padding:0.5rem 0.9rem;vertical-align:top;${bg}${isHdr?'font-weight:700;':''}`;
                const tag     = isHdr ? 'th' : 'td';
                const inner   = (node.content || []).map(renderNode).join('');
                return `<${tag} ${colspan} ${rowspan} style="${tdStyle}">${inner}</${tag}>`;
            }
            case 'text': {
                let text = escapeHtml(node.text || '');
                (node.marks || []).forEach(mark => {
                    switch (mark.type) {
                        case 'strong':          text = `<strong>${text}</strong>`; break;
                        case 'em':              text = `<em>${text}</em>`; break;
                        case 'underline':       text = `<u>${text}</u>`; break;
                        case 'strike':          text = `<s>${text}</s>`; break;
                        case 'code':            text = `<code style="background:#f4f5f7;border:1px solid #dfe1e6;border-radius:3px;padding:1px 4px;font-family:monospace;font-size:0.82em;">${text}</code>`; break;
                        case 'textColor':       text = `<span style="color:${mark.attrs?.color||'inherit'};">${text}</span>`; break;
                        case 'backgroundColor': text = `<span style="background-color:${mark.attrs?.color||'transparent'};">${text}</span>`; break;
                        case 'link':            text = `<a href="${escapeHtml(mark.attrs?.href||'#')}" target="_blank" rel="noopener" style="color:#0052cc;text-decoration:underline;">${text}</a>`; break;
                    }
                });
                return text;
            }
            case 'hardBreak':   return '<br>';
            case 'mention':     return `<span style="background:#e8f0fe;color:#1a56db;border-radius:4px;padding:1px 5px;font-size:0.82em;">@${escapeHtml(node.attrs?.text||node.attrs?.id||'user')}</span>`;
            case 'emoji':       return escapeHtml(node.attrs?.text || node.attrs?.shortName || '');
            case 'date': {
                const ts = node.attrs?.timestamp;
                if (!ts) return '<span class="adf-date-chip"><i class="fas fa-calendar-alt"></i> —</span>';
                const d   = isNaN(Number(ts)) ? new Date(ts) : new Date(Number(ts));
                const lbl = isNaN(d.getTime()) ? escapeHtml(String(ts)) : d.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
                return `<span class="adf-date-chip"><i class="fas fa-calendar-alt"></i> ${lbl}</span>`;
            }
            case 'inlineCard': return `<a href="${escapeHtml(node.attrs?.url||'#')}" target="_blank" style="color:#0052cc;font-size:0.82em;">${escapeHtml(node.attrs?.url||'link')}</a>`;
            case 'mediaGroup':
            case 'mediaSingle': return `<div style="color:#5e6c84;font-size:0.78em;font-style:italic;">[Attachment]</div>`;
            case 'panel': {
                const pc = { info:{bg:'#deebff',border:'#0052cc',icon:'ℹ️'}, note:{bg:'#fffae6',border:'#f79233',icon:'📝'}, warning:{bg:'#fffae6',border:'#f79233',icon:'⚠️'}, error:{bg:'#ffebe6',border:'#bf2600',icon:'🚫'}, success:{bg:'#e3fcef',border:'#006644',icon:'✅'} };
                const pt = node.attrs?.panelType || 'info';
                const c  = pc[pt] || pc.info;
                return `<div style="background:${c.bg};border-left:4px solid ${c.border};border-radius:6px;padding:0.6rem 0.9rem;margin:0.4rem 0;">${c.icon} ${(node.content||[]).map(renderNode).join('')}</div>`;
            }
            default:
                if (node.content && node.content.length) return (node.content).map(renderNode).join('');
                return '';
        }
    }
    return renderNode(doc);
}
