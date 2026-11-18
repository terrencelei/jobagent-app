"""His resume as data, and the exact layout it is printed in.

His standing resume comes from a react-pdf builder: US Letter, 40 pt margins, Times (the PDF base-14
fonts), a 30 pt bold name, 11 pt bold section titles over a 1 pt rule, and 9 pt body text on 10.8 pt
lines with Adobe kerning. `parse_pdf` reads such a PDF into a structure, `render_pdf` prints a
structure in that same layout (every position below was measured from his 2026-10-19 PDF and is
checked against it in tests), and `to_docx`/`from_docx` round-trip the text through Word so he can
edit a draft there. Formatting always comes from `render_pdf`, never from Word.
"""
import io
import json
import re
from pathlib import Path

from .. import identity

PAGE_W, PAGE_H, MARGIN = 612, 792, 40
RIGHT = PAGE_W - MARGIN
LINE = 10.8                 # 9 pt body lines
NAME_BASE, CONTACT_BASE = 67, 84.1
HEADER_GAP = 22.6           # last baseline -> section title baseline
FIRST_GAP = 22.4            # section title baseline -> first entry baseline
ENTRY_GAP = 20.8            # last line of an entry -> next entry
RULE_TOP, RULE_BOTTOM = 3.3, 4.3   # 1 pt rule under each section title
CONTACT_GAP, CONTACT_SEP = 9.553, 2.0
BULLET = {'education': (47.6, 57.0), 'experience': (48.0, 55.65)}
MAX_BASELINE = PAGE_H - MARGIN - 2   # lowest baseline that still prints inside the bottom margin
ROMAN, BOLD, ITALIC = 'Times-Roman', 'Times-Bold', 'Times-Italic'
SUBSTITUTE = {'→': '->', '≤': '<=', '≥': '>=', '≈': '~', ' ': ' ', ' ': ' ', ' ': ' ',
              '−': '-', '‑': '-', '‐': '-', 'µ': 'u'}

_kerning = None


def kerning():
    global _kerning
    if _kerning is None:
        _kerning = json.loads((Path(__file__).parent / 'data/times_kerning.json').read_text())
    return _kerning


_glyph = {}


def glyphs():
    """WinAnsi character -> Adobe glyph name, the names the kerning tables use."""
    if not _glyph:
        from reportlab.pdfbase.pdfmetrics import getEncoding
        for code, name in enumerate(getEncoding('WinAnsiEncoding').vector):
            try:
                if name:
                    _glyph[bytes([code]).decode('cp1252')] = name
            except UnicodeDecodeError:
                pass
    return _glyph


def clean(text):
    """Text the base-14 fonts can print (WinAnsi), with common symbols spelled out."""
    text = ''.join(SUBSTITUTE.get(c, c) for c in str(text or ''))
    text = re.sub(r'\s+', ' ', text).strip()
    return ''.join(c if c in glyphs() else '?' for c in text)


def _pairs(text, font):
    table, names = kerning()[font], glyphs()
    return [table.get(names.get(a), {}).get(names.get(b), 0) for a, b in zip(text, text[1:])]


def width(text, font, size):
    from reportlab.pdfbase.pdfmetrics import stringWidth
    return stringWidth(text, font, size) + sum(_pairs(text, font)) * size / 1000


def wrap(text, font, size, room):
    words, lines, line = text.split(' '), [], ''
    for word in words:
        trial = f'{line} {word}' if line else word
        if line and width(trial, font, size) > room:
            lines.append(line)
            line = word
        else:
            line = trial
    return lines + ([line] if line else [])


# ---------------------------------------------------------------- structure

def blank_entry():
    return {'org': '', 'dates': '', 'role': '', 'location': '', 'bullets': []}


def normalize(resume):
    """A clean, printable copy of a resume structure (also validates edits from the browser or Word)."""
    if not isinstance(resume, dict) or not isinstance(resume.get('sections'), list):
        raise ValueError('A resume needs a name, contact line and sections')
    out = {'name': clean(resume.get('name')), 'contact': [clean(c) for c in resume.get('contact') or [] if clean(c)], 'sections': []}
    for section in resume['sections']:
        title = clean(section.get('title')).upper()
        if not title:
            continue
        if section.get('kind') == 'skills' or section.get('lines'):
            lines = [{'label': clean(l.get('label')), 'text': clean(l.get('text'))} for l in section.get('lines') or []]
            out['sections'].append({'title': title, 'kind': 'skills', 'lines': [l for l in lines if l['label'] or l['text']]})
            continue
        entries = []
        for e in section.get('entries') or []:
            entry = {k: clean(e.get(k)) for k in ('org', 'dates', 'role', 'location')}
            entry['bullets'] = [clean(b) for b in e.get('bullets') or [] if clean(b)]
            if entry['org'] or entry['bullets']:
                entries.append(entry)
        style = section.get('style') or ('education' if title == 'EDUCATION' else 'experience')
        out['sections'].append({'title': title, 'kind': 'entries', 'style': style, 'entries': entries})
    if not out['name'] or not out['sections']:
        raise ValueError('A resume needs a name and at least one section')
    return out


def plain_text(resume):
    """What an applicant tracking system reads: every word, in order."""
    out = [resume['name'], ' | '.join(resume['contact'])]
    for s in resume['sections']:
        out.append(s['title'])
        if s['kind'] == 'skills':
            out += [f"{l['label']}: {l['text']}" for l in s['lines']]
            continue
        for e in s['entries']:
            out += [f"{e['org']} {e['dates']}", f"{e['role']} {e['location']}".strip(), *e['bullets']]
    return '\n'.join(x for x in out if x)


# ---------------------------------------------------------------- layout

def layout(resume):
    """Every printed run as (font, size, x, baseline-from-top, text), the rules, and the lowest baseline."""
    resume = normalize(resume)
    runs, rules = [], []
    runs.append((BOLD, 30, (PAGE_W - width(resume['name'], BOLD, 30)) / 2, NAME_BASE, resume['name']))
    items = resume['contact']
    if items:
        total = sum(width(i, ROMAN, 9) for i in items) + CONTACT_GAP * (len(items) - 1) + width(' ', ROMAN, 9)
        x = (PAGE_W - total) / 2
        for n, item in enumerate(items):
            runs.append((ROMAN, 9, x, CONTACT_BASE, item))
            x += width(item, ROMAN, 9)
            if n < len(items) - 1:
                runs.append((ROMAN, 9, x + CONTACT_SEP, CONTACT_BASE, ' | '))
                x += CONTACT_GAP
    y = CONTACT_BASE
    for section in resume['sections']:
        y += HEADER_GAP
        runs.append((BOLD, 11, MARGIN, y, section['title']))
        rules.append((y + RULE_TOP, y + RULE_BOTTOM))
        y += FIRST_GAP - LINE  # the first row below advances one line
        if section['kind'] == 'skills':
            for line in section['lines']:
                y += LINE
                label = f"{line['label']}: " if line['label'] else ''
                x = MARGIN
                if label:
                    runs.append((BOLD, 9, x, y, line['label']))
                    x += width(line['label'], BOLD, 9)
                    runs.append((BOLD, 9, x, y, ': '))
                    x += width(': ', BOLD, 9)
                first, *rest = wrap(line['text'], ROMAN, 9, RIGHT - x) or ['']
                runs.append((ROMAN, 9, x, y, first))
                for more in wrap(' '.join(rest), ROMAN, 9, RIGHT - MARGIN) if rest else []:
                    y += LINE
                    runs.append((ROMAN, 9, MARGIN, y, more))
            continue
        bullet_x, text_x = BULLET.get(section['style'], BULLET['experience'])
        for n, entry in enumerate(section['entries']):
            y += LINE if n == 0 else ENTRY_GAP
            runs.append((BOLD, 9, MARGIN, y, entry['org']))
            if entry['dates']:
                runs.append((BOLD, 9, RIGHT - width(entry['dates'], BOLD, 9), y, entry['dates']))
            if entry['role'] or entry['location']:
                y += LINE
                runs.append((ITALIC, 9, MARGIN, y, entry['role']))
                if entry['location']:
                    runs.append((ITALIC, 9, RIGHT - width(entry['location'], ITALIC, 9), y, entry['location']))
            for bullet in entry['bullets']:
                for k, line in enumerate(wrap(bullet, ROMAN, 9, RIGHT - text_x)):
                    y += LINE
                    if k == 0:
                        runs.append((ROMAN, 9, bullet_x, y, '•'))
                    runs.append((ROMAN, 9, text_x, y, line))
    return {'runs': [r for r in runs if r[4]], 'rules': rules, 'bottom': y, 'resume': resume}


def fit(resume):
    """Whether the resume fits on one page, and by how many body lines it overflows or has to spare."""
    bottom = layout(resume)['bottom']
    return {'fits': bottom <= MAX_BASELINE, 'lines_over': max(0, round((bottom - MAX_BASELINE) / LINE + 0.49)),
            'lines_free': max(0, int((MAX_BASELINE - bottom) / LINE))}


def _escape(raw):
    # ASCII only in the content stream: parentheses and backslashes escaped, other bytes as octal.
    return ''.join(f'\\{chr(b)}' if b in b'()\\' else chr(b) if 32 <= b < 127 else f'\\{b:03o}' for b in raw)


def render_pdf(resume, title=None):
    title = title or f'{identity.candidate_name()} Resume'
    from reportlab.pdfgen.canvas import Canvas
    plan = layout(resume)
    out = io.BytesIO()
    canvas = Canvas(out, pagesize=(PAGE_W, PAGE_H), pageCompression=1)
    canvas.setTitle(title)
    canvas.setAuthor(plan['resume']['name'].title())
    canvas.setFillColorRGB(0, 0, 0)
    for top, bottom in plan['rules']:
        canvas.rect(MARGIN, PAGE_H - bottom, RIGHT - MARGIN, bottom - top, stroke=0, fill=1)
    _draw(canvas, plan['runs'])
    for font, size, x, y, text in plan['runs']:
        uri = contact_uri(text) if y == CONTACT_BASE else None
        if uri:  # his builder links each contact item: a 10.8 pt box from 2 pt under the baseline
            canvas.linkURL(uri, (x, PAGE_H - y - 2, x + width(text, font, size), PAGE_H - y + 8.8), relative=0, thickness=0)
    canvas.showPage()
    canvas.save()
    return out.getvalue()


def contact_uri(item):
    """The link behind a contact-line item (phone, email, web address), or None for plain text like a city."""
    item = item.strip()
    if re.fullmatch(r'\+?[\d\s().-]{7,}', item):
        return 'tel:' + re.sub(r'[^\d+]', '', item)
    if re.fullmatch(r'[^@\s]+@[^@\s]+\.\w+', item):
        return 'mailto:' + item
    if re.match(r'https?://', item):
        return item
    if re.fullmatch(r'[\w.-]+\.[a-z]{2,}(/\S*)?', item, re.I):
        return 'https://' + item
    return None


def _draw(canvas, runs):
    for font, size, x, y, text in runs:
        canvas.setFont(font, size)  # registers the font on the page
        name = canvas._doc.getInternalFontName(font)
        parts, current = [], b''
        for char, kern in zip(text, _pairs(text, font) + [0]):
            current += char.encode('cp1252')
            if kern:
                parts.append(f'({_escape(current)}) {-kern}')
                current = b''
        parts.append(f'({_escape(current)})')
        array = ' '.join(parts)
        canvas._code.append(f'BT {name} {size} Tf 1 0 0 1 {x:.3f} {PAGE_H - y:.3f} Tm [{array}] TJ ET')


def render_png(resume, dpi=200):
    """A preview image of the printed page, for browsers that do not show PDFs inline.

    macOS Quick Look draws the PDF itself at the size asked for, so the text is sharp. (sips, used before, only
    stamps a dpi figure on a 72-dpi picture: 612 x 792 pixels whatever is asked, which looked blurred.) Ghostscript
    and then sips are fallbacks."""
    import subprocess
    import tempfile
    with tempfile.TemporaryDirectory(prefix='resume-preview-') as directory:
        source, target = Path(directory) / 'resume.pdf', Path(directory) / 'resume.png'
        source.write_bytes(render_pdf(resume))
        long_side = int(max(792, min(3300, round(11 * dpi))))
        attempts = [(['qlmanage', '-t', '-s', str(long_side), '-o', directory, str(source)], Path(directory) / 'resume.pdf.png'),
                    (['gs', '-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=png16m', f'-r{int(dpi)}', '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4', '-o', str(target), str(source)], target),
                    (['sips', '-s', 'format', 'png', str(source), '--out', str(target)], target)]
        for command, made in attempts:
            try:
                result = subprocess.run(command, capture_output=True, timeout=40)
            except (OSError, subprocess.TimeoutExpired):
                continue
            if result.returncode == 0 and made.is_file() and made.stat().st_size > 1000:
                return made.read_bytes()
        raise ValueError('The preview image could not be made; open the PDF instead')


LETTER_SIZE, LETTER_LINE, LETTER_GAP = 11, 13.2, 8   # cover-letter body: Times 11 pt, 1.2 leading, 8 pt between paragraphs
LETTER_START = CONTACT_BASE + 40                       # first body baseline, below the resume's letterhead


def letter_layout(header, text, date=''):
    """A cover letter under his resume's letterhead (same name and contact line), body as he approved it."""
    header = normalize(header)
    plan = layout({'name': header['name'], 'contact': header['contact'], 'sections': [{'title': 'X', 'entries': []}]})
    runs = [r for r in plan['runs'] if r[3] <= CONTACT_BASE]
    paragraphs = [p for p in re.split(r'\n\s*\n', str(text).strip()) if p.strip()]
    if date:
        paragraphs.insert(0, date)
    y = LETTER_START - LETTER_LINE - LETTER_GAP
    for paragraph in paragraphs:
        y += LETTER_GAP
        for line in paragraph.split('\n'):  # his single line breaks stay (sign-off, address lines)
            for piece in wrap(clean(line), ROMAN, LETTER_SIZE, RIGHT - MARGIN) or ['']:
                y += LETTER_LINE
                runs.append((ROMAN, LETTER_SIZE, MARGIN, y, piece))
    return {'runs': [r for r in runs if r[4]], 'bottom': y}


def render_cover_letter(header, text, date='', title=None):
    title = title or f'{identity.candidate_name()} Cover Letter'
    from reportlab.pdfgen.canvas import Canvas
    plan = letter_layout(header, text, date)
    if plan['bottom'] > MAX_BASELINE:
        raise ValueError(f"The cover letter runs {round((plan['bottom'] - MAX_BASELINE) / LETTER_LINE + 0.49)} line(s) past one page. Shorten it.")
    out = io.BytesIO()
    canvas = Canvas(out, pagesize=(PAGE_W, PAGE_H), pageCompression=1)
    canvas.setTitle(title)
    canvas.setAuthor(normalize(header)['name'].title())
    _draw(canvas, plan['runs'])
    canvas.showPage()
    canvas.save()
    return out.getvalue()


# ---------------------------------------------------------------- reading his PDFs

def _runs(pdf):
    from pypdf import PdfReader
    page = PdfReader(io.BytesIO(pdf) if isinstance(pdf, bytes) else str(pdf)).pages[0]
    runs = []

    def visit(text, cm, tm, font, size):
        if text and text.strip():
            base = str((font or {}).get('/BaseFont', '')).lstrip('/')
            runs.append((round(PAGE_H - (cm[5] + tm[5] * cm[3]), 1), round(cm[4] + tm[4] * cm[0], 2), base, size, text))
    page.extract_text(visitor_text=visit)
    return runs


def parse_pdf(pdf):
    """Read a resume printed in his builder's layout back into a structure (raises if it is not that layout)."""
    rows = {}
    for y, x, font, size, text in _runs(pdf):
        rows.setdefault(y, []).append((x, font, size, text))
    resume = {'name': '', 'contact': [], 'sections': []}
    section = entry = None
    bullet_open = False
    for y in sorted(rows):
        row = sorted(rows[y])
        x0, font, size, text = row[0]
        if size >= 20:
            resume['name'] = ''.join(r[3] for r in row).strip()
        elif not resume['contact'] and not resume['sections'] and size < 10:
            resume['contact'] = [r[3].strip() for r in row if r[3].strip() != '|']
        elif font.endswith('Bold') and size > 10:
            section = {'title': text.strip(), 'kind': 'entries', 'entries': []}
            resume['sections'].append(section)
            entry = None
        elif section is None:
            continue
        elif font.endswith('Bold') and len(row) > 1 and row[1][3].strip() == ':':
            section['kind'] = 'skills'
            section.setdefault('lines', []).append({'label': text.strip(), 'text': ''.join(r[3] for r in row[2:]).strip()})
        elif section.get('kind') == 'skills' and font == ROMAN and section.get('lines'):
            section['lines'][-1]['text'] += ' ' + ''.join(r[3] for r in row).strip()
        elif font.endswith('Bold'):
            entry = blank_entry()
            entry['org'] = text.strip()
            entry['dates'] = ' '.join(r[3].strip() for r in row[1:])
            section['entries'].append(entry)
        elif font.endswith('Italic') and entry is not None:
            entry['role'] = text.strip()
            entry['location'] = ' '.join(r[3].strip() for r in row[1:])
        elif entry is not None and text.strip() == '•':
            entry['bullets'].append(''.join(r[3] for r in row[1:]).strip())
            if section['title'] == 'EDUCATION' or x0 < 47.8:
                section['style'] = 'education' if section['title'] == 'EDUCATION' else section.get('style', 'experience')
        elif entry is not None and entry['bullets']:
            entry['bullets'][-1] = (entry['bullets'][-1] + ' ' + ''.join(r[3] for r in row).strip()).strip()
    for s in resume['sections']:
        s.pop('entries', None) if s['kind'] == 'skills' else None
    return normalize(resume)


# ---------------------------------------------------------------- Word round trip

STYLES = ('Resume Name', 'Resume Contact', 'Resume Section', 'Resume Entry', 'Resume Role', 'Resume Bullet', 'Resume Skill')


def to_docx(resume):
    """A Word copy for editing text. Its look approximates the PDF; the PDF is regenerated exactly on upload."""
    from docx import Document
    from docx.enum.style import WD_STYLE_TYPE
    from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT, WD_LINE_SPACING
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Pt
    resume = normalize(resume)
    doc = Document()
    sec = doc.sections[0]
    sec.page_width, sec.page_height = Pt(PAGE_W), Pt(PAGE_H)
    sec.left_margin = sec.right_margin = sec.top_margin = sec.bottom_margin = Pt(MARGIN)
    content = Pt(RIGHT - MARGIN)

    def style(name, size, bold=False, italic=False, align=None, before=0, after=0):
        st = doc.styles.add_style(name, WD_STYLE_TYPE.PARAGRAPH)
        st.font.name, st.font.size, st.font.bold, st.font.italic = 'Times New Roman', Pt(size), bold, italic
        st.element.rPr.rFonts.set(qn('w:eastAsia'), 'Times New Roman')
        pf = st.paragraph_format
        pf.space_before, pf.space_after = Pt(before), Pt(after)
        pf.line_spacing_rule, pf.line_spacing = WD_LINE_SPACING.EXACTLY, Pt(max(size * 1.2, LINE))
        if align:
            pf.alignment = align
        return st
    style('Resume Name', 30, bold=True, align=WD_ALIGN_PARAGRAPH.CENTER)
    style('Resume Contact', 9, align=WD_ALIGN_PARAGRAPH.CENTER)
    section_style = style('Resume Section', 11, bold=True, before=8, after=6)
    border = OxmlElement('w:pBdr'); bottom = OxmlElement('w:bottom')
    for k, v in {'w:val': 'single', 'w:sz': '8', 'w:space': '1', 'w:color': '000000'}.items():
        bottom.set(qn(k), v)
    border.append(bottom); section_style.element.get_or_add_pPr().append(border)
    for name, bold, italic in (('Resume Entry', True, False), ('Resume Role', False, True)):
        st = style(name, 9, bold=bold, italic=italic, before=6 if bold else 0)
        st.paragraph_format.tab_stops.add_tab_stop(content, WD_TAB_ALIGNMENT.RIGHT)
    bullet = style('Resume Bullet', 9)
    bullet.paragraph_format.left_indent = Pt(BULLET['experience'][1] - MARGIN)
    bullet.paragraph_format.first_line_indent = Pt(-(BULLET['experience'][1] - BULLET['experience'][0]))
    style('Resume Skill', 9)
    body = doc.paragraphs[0] if doc.paragraphs else None
    if body is not None:
        body._element.getparent().remove(body._element)
    doc.add_paragraph(resume['name'], style='Resume Name')
    doc.add_paragraph('  |  '.join(resume['contact']), style='Resume Contact')
    for s in resume['sections']:
        doc.add_paragraph(s['title'], style='Resume Section')
        if s['kind'] == 'skills':
            for l in s['lines']:
                p = doc.add_paragraph(style='Resume Skill')
                p.add_run(f"{l['label']}:").bold = True
                p.add_run(f" {l['text']}")
            continue
        for e in s['entries']:
            doc.add_paragraph(f"{e['org']}\t{e['dates']}", style='Resume Entry')
            if e['role'] or e['location']:
                doc.add_paragraph(f"{e['role']}\t{e['location']}", style='Resume Role')
            for b in e['bullets']:
                doc.add_paragraph(f'• {b}', style='Resume Bullet')
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()


def from_docx(data, template=None):
    """Read an edited Word copy back. Paragraph styles carry the structure; section styles (education vs
    experience bullets) come from the draft it was downloaded from."""
    from docx import Document
    try:
        doc = Document(io.BytesIO(data))
    except Exception as exc:
        raise ValueError('That file is not a Word document (.docx)') from exc
    styles = {s['title']: s.get('style') for s in (template or {}).get('sections', []) if s.get('kind') == 'entries'}
    resume = {'name': '', 'contact': [], 'sections': []}
    section = entry = None
    for p in doc.paragraphs:
        text, kind = p.text.strip(), p.style.name if p.style is not None else ''
        if not text:
            continue
        if kind not in STYLES:
            kind = 'Resume Bullet' if text[:1] in '•-*' else ''
        if kind == 'Resume Name':
            resume['name'] = text
        elif kind == 'Resume Contact':
            resume['contact'] = [c.strip() for c in text.split('|') if c.strip()]
        elif kind == 'Resume Section':
            section = {'title': text, 'kind': 'skills' if text.upper() == 'SKILLS' else 'entries', 'entries': [], 'lines': []}
            if text.upper() in styles:
                section['style'] = styles[text.upper()]
            resume['sections'].append(section)
            entry = None
        elif section is None:
            raise ValueError(f'"{text[:60]}" comes before the first section title')
        elif kind == 'Resume Skill' or (section['kind'] == 'skills' and ':' in text):
            label, _, rest = text.partition(':')
            section['kind'] = 'skills'
            section['lines'].append({'label': label.strip(), 'text': rest.strip()})
        elif kind == 'Resume Entry':
            org, _, dates = text.rpartition('\t') if '\t' in text else (text, '', '')
            entry = {**blank_entry(), 'org': org.strip(), 'dates': dates.strip()}
            section['entries'].append(entry)
        elif kind == 'Resume Role' and entry is not None:
            role, _, location = text.rpartition('\t') if '\t' in text else (text, '', '')
            entry.update(role=role.strip(), location=location.strip())
        elif kind == 'Resume Bullet' and entry is not None:
            entry['bullets'].append(re.sub(r'^[•\-*]\s*', '', text))
        else:
            raise ValueError(f'Could not place "{text[:60]}". Keep the paragraph styles from the download (Resume Entry, Resume Bullet, ...).')
    for s in resume['sections']:
        s.pop('lines' if s['kind'] == 'entries' else 'entries', None)
    return normalize(resume)
