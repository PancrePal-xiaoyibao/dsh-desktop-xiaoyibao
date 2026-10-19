#!/usr/bin/env python3
"""
生成小胰宝社区版的应用图标（跨平台，不依赖 macOS 工具链）。

为什么需要自建脚本：
    上游的 generate-app-icons.mjs 依赖 macOS 的 `sips` / `iconutil`，
    在本机（Linux）无法运行。而社区版要换成小胰宝图标，因此需要一份
    跨平台的图标生成实现。

输出：
    build/xyb/app-icon.png    1024×1024 源图
    build/xyb/icon.png        1024×1024
    build/xyb/icon.ico        Windows（多尺寸，PNG 内嵌）
    build/xyb/icon.icns       macOS（多尺寸，PNG 内嵌）

ICNS 与 ICO 都是容器格式，允许直接内嵌 PNG 数据，因此无需额外工具。
"""
import struct
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("需要 Pillow：pip install Pillow", file=sys.stderr)
    sys.exit(1)

ROOT = Path(__file__).resolve().parent.parent
LOGO = ROOT / "packages" / "dsh-xyb-branding" / "assets" / "xyb-logo.png"
OUT_DIR = ROOT / "vendor" / "dsh-desktop-main" / "build" / "xyb"

# 品牌背景色（取自原型 CSS 变量的浅绿底）
BRAND_BG = (242, 248, 246, 255)
ICON_SIZE = 1024
# logo 占画布的比例（留出安全边距，避免图标贴边）
LOGO_RATIO = 0.72

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
# ICNS 类型码 → 像素尺寸（现代 PNG 型条目）
ICNS_TYPES = [
    (b"ic07", 128),
    (b"ic08", 256),
    (b"ic09", 512),
    (b"ic10", 1024),
    (b"ic11", 32),   # 16@2x
    (b"ic12", 64),   # 32@2x
    (b"ic13", 256),  # 128@2x
    (b"ic14", 512),  # 256@2x
]


def build_canvas() -> Image.Image:
    """把 64×64 的 logo 放大并居中放到品牌底色画布上。"""
    if not LOGO.exists():
        print(f"缺少 logo：{LOGO}", file=sys.stderr)
        sys.exit(1)

    logo = Image.open(LOGO).convert("RGBA")
    target = int(ICON_SIZE * LOGO_RATIO)
    # 用 LANCZOS 放大（logo 是扁平矢量风格，放大后边缘仍可接受）
    logo_resized = logo.resize((target, target), Image.LANCZOS)

    canvas = Image.new("RGBA", (ICON_SIZE, ICON_SIZE), BRAND_BG)
    offset = ((ICON_SIZE - target) // 2, (ICON_SIZE - target) // 2)
    canvas.alpha_composite(logo_resized, offset)
    return canvas


def write_ico(canvas: Image.Image, path: Path) -> None:
    """
    手写 ICO：头部 + 目录项 + PNG 数据。
    Vista 以后 Windows 支持在 ICO 中直接内嵌 PNG，因此无需 BMP 转换。
    """
    entries = []
    for size in ICO_SIZES:
        img = canvas.resize((size, size), Image.LANCZOS)
        buf = _png_bytes(img)
        entries.append((size, buf))

    header = struct.pack("<HHH", 0, 1, len(entries))  # reserved, type=icon, count
    offset = len(header) + 16 * len(entries)
    directory = b""
    payload = b""
    for size, buf in entries:
        # 宽高为 0 表示 256
        w = 0 if size >= 256 else size
        h = 0 if size >= 256 else size
        directory += struct.pack(
            "<BBBBHHII", w, h, 0, 0, 1, 32, len(buf), offset
        )
        payload += buf
        offset += len(buf)

    path.write_bytes(header + directory + payload)


def write_icns(canvas: Image.Image, path: Path) -> None:
    """
    手写 ICNS：magic('icns') + 总长度 + 各类型条目（类型码 + 长度 + PNG 数据）。
    """
    body = b""
    for type_code, size in ICNS_TYPES:
        img = canvas.resize((size, size), Image.LANCZOS)
        buf = _png_bytes(img)
        body += type_code + struct.pack(">I", len(buf) + 8) + buf
    total = len(body) + 8
    path.write_bytes(b"icns" + struct.pack(">I", total) + body)


def _png_bytes(img: Image.Image) -> bytes:
    from io import BytesIO

    out = BytesIO()
    img.save(out, format="PNG", optimize=True)
    return out.getvalue()


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    canvas = build_canvas()

    canvas.save(OUT_DIR / "app-icon.png", format="PNG")
    canvas.save(OUT_DIR / "icon.png", format="PNG")
    write_ico(canvas, OUT_DIR / "icon.ico")
    write_icns(canvas, OUT_DIR / "icon.icns")

    for name in ("app-icon.png", "icon.png", "icon.ico", "icon.icns"):
        p = OUT_DIR / name
        print(f"  {name}: {p.stat().st_size} bytes")
    print(f"图标已生成到 {OUT_DIR}")


if __name__ == "__main__":
    main()
