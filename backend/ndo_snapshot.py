"""
Renders the compact daily snapshot image posted to Slack (PNG, Pillow only —
no headless browser needed on the server).
"""
import io
from typing import Dict, List, Tuple

from PIL import Image, ImageDraw, ImageFont

SCALE = 2                     # render at 2x for crisp text on retina screens
WIDTH, HEIGHT = 960, 400

INK = '#172b4d'
MUTED = '#5e6c84'
LINE = '#dfe1e6'
BG = '#f4f5f7'
CARD = '#ffffff'
HEADER_BG = '#fff4cc'
RAG_COLORS = {'green': '#36b37e', 'amber': '#ffab00', 'red': '#de350b'}
TILE_COLORS = ['#de350b', '#0052cc', '#ff8b00', '#6554c0']
PRIORITY_COLORS = {
    'Critical': '#bf2600', 'Highest': '#de350b', 'High': '#ff8b00',
    'Medium': '#ffc400', 'Low': '#36b37e', 'Lowest': '#00875a', 'None': '#a5adba',
}
SEVERITY_COLORS = {'Sev-0': '#bf2600', 'Sev-1': '#ff5630', 'Sev-2': '#ffab00', 'Sev-3': '#4c9aff',
                   'Not set': '#c1c7d0'}

_FONT_CANDIDATES = {
    'regular': ['/System/Library/Fonts/Supplemental/Arial.ttf',
                '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
                '/usr/share/fonts/dejavu/DejaVuSans.ttf',
                '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'],
    'bold':    ['/System/Library/Fonts/Supplemental/Arial Bold.ttf',
                '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
                '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
                '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'],
}
_font_cache: Dict[Tuple[str, int], ImageFont.FreeTypeFont] = {}


def _font(size: int, weight: str = 'regular'):
    key = (weight, size)
    if key not in _font_cache:
        font = None
        for path in _FONT_CANDIDATES[weight]:
            try:
                font = ImageFont.truetype(path, size * SCALE)
                break
            except OSError:
                continue
        _font_cache[key] = font or ImageFont.load_default(size=size * SCALE)
    return _font_cache[key]


def _s(*values):
    return [v * SCALE for v in values]


def _fit(draw: ImageDraw.ImageDraw, text: str, font, max_width: int) -> str:
    if draw.textlength(text, font=font) <= max_width * SCALE:
        return text
    while text and draw.textlength(text + '…', font=font) > max_width * SCALE:
        text = text[:-1]
    return text.rstrip() + '…'


def _stacked_bar(draw, x: int, y: int, w: int, h: int, items: List[Tuple[str, int, str]], title: str):
    draw.text(_s(x, y), title, font=_font(12, 'bold'), fill=INK)
    y += 20
    total = sum(n for _, n, _ in items) or 1
    cx = x
    draw.rounded_rectangle(_s(x, y, x + w, y + h), radius=4 * SCALE, fill=LINE)
    for label, n, color in items:
        if n <= 0:
            continue
        seg = max(3, round(w * n / total))
        seg = min(seg, x + w - cx)
        draw.rectangle(_s(cx, y, cx + seg, y + h), fill=color)
        cx += seg
    # legend
    ly, lx = y + h + 9, x
    for label, n, color in items:
        if n <= 0:
            continue
        text = f"{label} {n}"
        tw = draw.textlength(text, font=_font(11)) / SCALE
        if lx + tw + 16 > x + w:
            lx, ly = x, ly + 17
        draw.rounded_rectangle(_s(lx, ly + 2, lx + 9, ly + 11), radius=2 * SCALE, fill=color)
        draw.text(_s(lx + 13, ly), text, font=_font(11), fill=MUTED)
        lx += tw + 26


def render_snapshot(report: Dict) -> bytes:
    img = Image.new('RGB', _s(WIDTH, HEIGHT), BG)
    d = ImageDraw.Draw(img)

    # Card + header band
    d.rounded_rectangle(_s(12, 12, WIDTH - 12, HEIGHT - 12), radius=14 * SCALE, fill=CARD)
    d.rounded_rectangle(_s(12, 12, WIDTH - 12, 64), radius=14 * SCALE, fill=HEADER_BG)
    d.rectangle(_s(12, 48, WIDTH - 12, 64), fill=HEADER_BG)
    d.line(_s(12, 64, WIDTH - 12, 64), fill=LINE, width=SCALE)
    d.rounded_rectangle(_s(12, 12, WIDTH - 12, HEIGHT - 12), radius=14 * SCALE, outline=LINE, width=SCALE)
    d.text(_s(32, 26), 'Naar Data Operations', font=_font(19, 'bold'), fill=INK)
    sub = f"Daily update · {report['date_label']}"
    d.text(_s(WIDTH - 32, 30), sub, font=_font(13), fill=MUTED, anchor='ra')

    # RAG pill
    rag = report['rag']
    pill = f"Overall RAG: {rag['label']}"
    pw = d.textlength(pill, font=_font(13, 'bold')) / SCALE + 28
    d.rounded_rectangle(_s(32, 80, 32 + pw, 108), radius=14 * SCALE, fill=RAG_COLORS[rag['level']])
    d.text(_s(46, 86), pill, font=_font(13, 'bold'), fill='#ffffff' if rag['level'] != 'amber' else INK)
    reason = _fit(d, rag['reasons'][0], _font(13), WIDTH - 32 - pw - 60)
    d.text(_s(32 + pw + 14, 86), reason, font=_font(13), fill=INK)

    # Tiles
    totals = report['totals']
    tiles = [(f"Open {ty}{'s' if not ty.endswith('s') else ''}", n) for ty, n in totals['by_type'].items()][:2]
    tiles += [('Critical / High', totals['critical_high']), ('Unassigned', totals['unassigned'])]
    tile_w, gap, ty0 = (WIDTH - 64 - 3 * 14) / 4, 14, 124
    for i, (label, value) in enumerate(tiles):
        x0 = 32 + i * (tile_w + gap)
        color = TILE_COLORS[i % len(TILE_COLORS)]
        d.rounded_rectangle(_s(x0, ty0, x0 + tile_w, ty0 + 78), radius=10 * SCALE, fill='#fafbfc',
                            outline=LINE, width=SCALE)
        d.rectangle(_s(x0, ty0 + 10, x0 + 4, ty0 + 68), fill=color)
        d.text(_s(x0 + 18, ty0 + 12), str(value), font=_font(30, 'bold'), fill=color)
        d.text(_s(x0 + 18, ty0 + 52), label, font=_font(12), fill=MUTED)

    # Breakdown bars
    col_w = (WIDTH - 64 - 30) / 2
    prio = [(p, sum(v.values()), PRIORITY_COLORS.get(p, '#a5adba'))
            for p, v in report['breakdown']['priority'].items()]
    _stacked_bar(d, 32, 222, int(col_w), 14, prio, 'Priority — all open tickets')
    sev = [(s, n, SEVERITY_COLORS.get(s, '#a5adba')) for s, n in report['breakdown']['severity'].items()]
    _stacked_bar(d, int(32 + col_w + 30), 222, int(col_w), 14, sev, 'Severity — incidents')

    # One-line summary
    d.line(_s(32, 312, WIDTH - 32, 312), fill=LINE, width=SCALE)
    updates = report.get('dev_updates') or []
    if updates:
        more = f"  (+{len(updates) - 2} more)" if len(updates) > 2 else ''
        summary_lines = [u['text'] for u in updates[:2]]
        summary_lines[-1] += more
    else:
        summary_lines = report['highlights'][:2]
    for i, line in enumerate(summary_lines):
        d.text(_s(32, 324 + i * 22), _fit(d, f"• {line}", _font(13), WIDTH - 64), font=_font(13), fill=INK)

    out = io.BytesIO()
    img.save(out, format='PNG', optimize=True)
    return out.getvalue()
