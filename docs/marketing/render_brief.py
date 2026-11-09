"""Render the editable Markdown brief as a Cyrillic PDF. Requires reportlab.
Run: python docs/marketing/render_brief.py
Fonts: DejaVu Sans (system directory or ORBITA_PDF_FONT_DIR).
"""
from pathlib import Path
import os, re
from html import escape
from reportlab.pdfgen import canvas
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, KeepTogether
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.colors import HexColor, white
from reportlab.lib.enums import TA_LEFT
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.pagesizes import A4

ROOT=Path(__file__).resolve().parent
FONT=Path(os.environ.get('ORBITA_PDF_FONT_DIR','/usr/share/fonts/truetype/dejavu'))
for name,file in [('Orbita','DejaVuSans.ttf'),('OrbitaBold','DejaVuSans-Bold.ttf'),('OrbitaItalic','DejaVuSans-Oblique.ttf')]:
    pdfmetrics.registerFont(TTFont(name,str(FONT/file)))
pdfmetrics.registerFontFamily('Orbita',normal='Orbita',bold='OrbitaBold',italic='OrbitaItalic',boldItalic='OrbitaBold')
NAVY=HexColor('#101b2d'); BLUE=HexColor('#24578f'); GOLD=HexColor('#bb9352'); GRAY=HexColor('#506176')
styles={
 'body':ParagraphStyle('body',fontName='Orbita',fontSize=10.2,leading=15,textColor=NAVY,spaceAfter=8),
 'bullet':ParagraphStyle('bullet',fontName='Orbita',fontSize=10.2,leading=14.8,textColor=NAVY,leftIndent=12,firstLineIndent=-10,spaceAfter=5),
 'h1':ParagraphStyle('h1',fontName='OrbitaBold',fontSize=23,leading=29,textColor=NAVY,spaceAfter=18,keepWithNext=True),
 'h2':ParagraphStyle('h2',fontName='OrbitaBold',fontSize=12,leading=17,textColor=BLUE,spaceBefore=8,spaceAfter=8,keepWithNext=True),
 'cover':ParagraphStyle('cover',fontName='OrbitaBold',fontSize=40,leading=47,textColor=NAVY,spaceBefore=24,spaceAfter=15,keepWithNext=True),
 'url':ParagraphStyle('url',fontName='Orbita',fontSize=8.3,leading=11,textColor=BLUE,spaceAfter=8,wordWrap='CJK'),
}
SOURCES={
 'S1':'https://ads.tiktok.com/business/en/creative-codes',
 'S2':'https://blog.youtube/creator-and-artist-stories/youtube-shorts-deep-dive/',
 'S3':'https://www.fca.org.uk/investsmart/hype-spot-signs-manage-your-fomo',
 'S4':'https://www.fca.org.uk/investsmart/5-questions-ask-you-invest',
 'S5':'https://ads.tiktok.com/help/article/tiktok-ads-policy-financial-services?lang=en',
 'S6':'https://support.google.com/youtube/answer/154235?hl=ru',
 'S7':'https://www.consultant.ru/document/cons_doc_LAW_58968/f67f81c57fdcdacc2643d19d59369f7e185e1156/',
 'S8':'https://www.consultant.ru/document/cons_doc_LAW_58968/2c4537e4796f6ff8b2736ed1b0d4fef08e14458e/',
 'S9':'https://www.consultant.ru/document/cons_doc_LAW_58968/0021818db8b93ae5fbd38076074a7182e157186c/',
}
def inline(text):
    text=escape(text)
    text=re.sub(r'\*\*(.+?)\*\*',r'<b>\1</b>',text)
    for key,url in SOURCES.items():text=text.replace('['+key+']',f'<link href="{escape(url,quote=True)}" color="#24578f">[{key}]</link>')
    return text
class NumberedCanvas(canvas.Canvas):
    def __init__(self,*args,**kwargs):
        canvas.Canvas.__init__(self,*args,**kwargs);self.saved=[]
    def showPage(self):
        self.saved.append(dict(self.__dict__));self._startPage()
    def save(self):
        count=len(self.saved)
        for state in self.saved:
            self.__dict__.update(state);self.footer(count);canvas.Canvas.showPage(self)
        canvas.Canvas.save(self)
    def footer(self,count):
        self.setStrokeColor(HexColor('#dfe5ed'));self.line(48,43,A4[0]-48,43)
        self.setFillColor(GRAY);self.setFont('Orbita',8)
        self.drawString(48,28,'ORBITA  /  Маркетинг и партнёры  /  09.11.2026')
        self.drawRightString(A4[0]-48,28,f'{self._pageNumber:02d} / {count:02d}')
def header(c,doc):
    c.saveState();c.setFillColor(NAVY);c.rect(0,A4[1]-42,A4[0],42,fill=1,stroke=0)
    c.setFillColor(white);c.setFont('OrbitaBold',10);c.drawString(48,A4[1]-27,'ORBITA')
    c.setFont('Orbita',8);c.drawRightString(A4[0]-48,A4[1]-27,'SMM  /  SHORT VIDEO  /  PARTNERS')
    c.setFillColor(GOLD);c.rect(48,A4[1]-57,35,3,fill=1,stroke=0);c.restoreState()

source=(ROOT/'Orbita-marketing-brief.md').read_text()
pages=source.split('\n---\n');story=[]
for idx,page in enumerate(pages):
    if idx:story.append(PageBreak())
    for line in page.strip().splitlines():
        line=line.strip()
        if not line:continue
        if line.startswith('# '):story.append(Paragraph(inline(line[2:]),styles['cover' if idx==0 else 'h1']))
        elif line.startswith('## '):story.append(Paragraph(inline(line[3:]),styles['h2']))
        elif line.startswith('- '):story.append(Paragraph('• '+inline(line[2:]),styles['bullet']))
        elif line.startswith('https://'):story.append(Paragraph(f'<link href="{escape(line,quote=True)}">{escape(line)}</link>',styles['url']))
        else:story.append(Paragraph(inline(line),styles['body']))
    if idx==len(pages)-1:
        story.append(Paragraph('Прямые ссылки: '+ ' · '.join(f'<link href="{SOURCES[k]}" color="#24578f">{k} — статья {v}</link>' for k,v in [('S7','5'),('S8','18.1'),('S9','28')]),styles['url']))
output=ROOT/'Orbita-marketing-brief.pdf'
doc=SimpleDocTemplate(str(output),pagesize=A4,leftMargin=48,rightMargin=48,topMargin=76,bottomMargin=58,title='ORBITA — бриф для маркетинга, SMM и реферальных партнёров',author='ORBITA',subject='Вертикальные видео, сценарии, партнёрская программа и правила публикации')
doc.build(story,onFirstPage=header,onLaterPages=header,canvasmaker=NumberedCanvas)
print(f'{output}: {output.stat().st_size} bytes; planned sections: {len(pages)}')
