#!/usr/bin/env python3
"""MD→XYB风格HTML转换，一字不改"""
import sys
import re
from pathlib import Path

sys.path.insert(0, "/Users/qinxiaoqiang/.agents/skills/xyb-wechat-transcribe/scripts")

import markdown
from render import choose_template, COLOR_META, DEFAULT_FOOTER, remove_empty_sections
from html import escape
from bs4 import BeautifulSoup

from common import setup_logging, get_logger  # noqa: E402

setup_logging()
logger = get_logger(__name__)

def convert(md_path, out_path, family="template1", style="morandi_purple", usp=None):
    md_content = Path(md_path).read_text(encoding="utf-8")
    
    # Extract title from first H1
    title = "Clinical Report"
    for line in md_content.split("\n"):
        if line.startswith("# "):
            title = re.sub(r"^#+\s*", "", line).strip()
            break

    # MD → HTML with all extensions
    md_html = markdown.markdown(md_content, extensions=["tables","fenced_code","nl2br","sane_lists"])

    # Enhance with xyb styles
    meta = COLOR_META[family][style]
    soup = BeautifulSoup(md_html, "html.parser")

    for h1 in soup.find_all("h1"):
        h1["style"] = f"font-size:22px;color:{meta['main']};border-bottom:3px solid {meta['main']};padding-bottom:10px;margin:30px 20px 20px;"

    for h2 in soup.find_all("h2"):
        text = h2.get_text()
        new = f'<section style="display:flex;align-items:center;margin:28px 20px 15px;"><span style="display:inline-block;width:4px;height:22px;background-color:{meta["main"]};border-radius:2px;margin-right:12px;"></span><strong style="font-size:18px;color:{meta["main"]};">{escape(text)}</strong></section>'
        h2.replace_with(BeautifulSoup(new, "html.parser"))

    for h3 in soup.find_all("h3"):
        h3["style"] = f"font-size:16px;color:{meta['main']};margin:22px 20px 12px;padding-left:12px;border-left:3px solid {meta['accent']};"

    for h4 in soup.find_all("h4"):
        h4["style"] = f"font-size:14px;color:{meta['accent']};margin:18px 20px 10px;"

    for p in soup.find_all("p"):
        p["style"] = "margin:0 20px 12px;font-size:14px;line-height:2;color:#3e3e3e;letter-spacing:0.5px;text-align:justify;"

    for bq in soup.find_all("blockquote"):
        bq["style"] = f"margin:18px 20px;padding:15px 20px;background:{meta['bg']};border-left:4px solid {meta['main']};border-radius:8px;font-size:13px;line-height:1.9;color:#555;"

    for ul in soup.find_all("ul"):
        ul["style"] = "margin:10px 20px 15px;padding-left:20px;font-size:14px;line-height:2;color:#3e3e3e;"
    for ol in soup.find_all("ol"):
        ol["style"] = "margin:10px 20px 15px;padding-left:20px;font-size:14px;line-height:2;color:#3e3e3e;"

    for tag in soup.find_all(["strong","b"]):
        tag["style"] = f"color:{meta['main']};font-weight:600;"
    for a in soup.find_all("a"):
        a["style"] = f"color:{meta['accent']};text-decoration:underline;"
    for hr in soup.find_all("hr"):
        hr["style"] = f"border:none;border-top:2px solid {meta['bg']};margin:30px 20px;"

    # Table styling
    for table in soup.find_all("table"):
        table["style"] = "width:100%;border-collapse:collapse;font-size:13px;line-height:1.7;margin:18px 0;"
        for tr in table.find_all("tr"):
            for cell in tr.find_all(["th","td"]):
                cell["style"] = "padding:10px 12px;border:1px solid #d8cfe7;text-align:left;background:#efe8f8;font-weight:600;" if cell.name=="th" else "padding:10px 12px;border:1px solid #e6deef;text-align:left;background:#fff;"
    for table in soup.find_all("table"):
        wrapper = soup.new_tag("section")
        wrapper["style"] = "margin:18px 20px;overflow-x:auto;"
        table.wrap(wrapper)

    styled_body = str(soup)
    body_soup = BeautifulSoup(styled_body, "html.parser")
    all_blocks = [str(c) for c in body_soup.children if str(c).strip()]
    
    intro_html = "\n".join(all_blocks[:6])
    body_html = "\n".join(all_blocks[6:])

    # Render template
    template_html = choose_template(family, style).read_text(encoding="utf-8")
    if not usp:
        usp = "靶向前沿·临床洞察"
    title_line = f"clinicaltrials-search | {family} | {style}"
    summary = f"{title} — 基于ClinicalTrials.gov的靶点专题研究"

    html = template_html
    html = html.replace("__TITLE__", escape(title))
    html = html.replace("__SUBTITLE__", escape(usp))
    html = html.replace("__META__", title_line)
    html = html.replace("__TITLE_LINE__", escape(title_line))
    html = html.replace("__SUMMARY__", escape(summary))
    html = html.replace("__INTRO__", intro_html)
    html = html.replace("__BODY__", body_html)
    html = html.replace("__MAIN__", meta["main"])
    html = html.replace("__ACCENT__", meta["accent"])
    html = html.replace("__BG__", meta["bg"])
    html = html.replace("__XYB_FOOTER__", DEFAULT_FOOTER.replace("__MAIN__", meta["main"]))
    html = remove_empty_sections(html)

    Path(out_path).write_text(html, encoding="utf-8")
    return title

if __name__ == "__main__":
    import sys
    md_path = sys.argv[1] if len(sys.argv) > 1 else None
    out_path = sys.argv[2] if len(sys.argv) > 2 else md_path.replace(".md", ".html") if md_path else None
    if not md_path or not out_path:
        logger.error("Usage: convert_to_xyb_html.py <input.md> <output.html>")
        sys.exit(1)
    title = convert(md_path, out_path)
    logger.info("✅ HTML: %s (%.0f KB)", out_path, Path(out_path).stat().st_size / 1024)
    logger.info("   Template: template1/morandi_purple")
    logger.info("   Title: %s", title)