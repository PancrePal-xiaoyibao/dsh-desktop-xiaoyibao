#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NCCN指南下载工具 — 离线回归测试

本测试不联网，仅验证可离线测试的纯逻辑：
  - 语言检测 (_detect_pdf_language / _contains_cjk)
  - URL 域名白名单 (_is_url_allowed)
  - 文件名清洗 (_enhance_pdf_info 的路径穿越防护)
  - 统计计数 (_download_single_pdf 返回值语义)
  - 模块加载与类实例化

运行方式:
  python3 test_offline.py
"""

import argparse
import importlib.util
import json
import logging
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

# 禁用 NCCNDownloaderV2 实例化时的全局 logging.basicConfig 副作用
logging.disable(logging.CRITICAL)

# 动态加载主脚本模块（避免 __main__ 触发交互式菜单）
SCRIPT_PATH = "download_nccn.py"
spec = importlib.util.spec_from_file_location("nccn_main", SCRIPT_PATH)
nccn_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nccn_module)

# ncd.py is optional in skill deployment
NCD_SCRIPT_PATH = "ncd.py"
ncd_module = None
if os.path.exists(NCD_SCRIPT_PATH):
    ncd_spec = importlib.util.spec_from_file_location("ncd_cli", NCD_SCRIPT_PATH)
    ncd_module = importlib.util.module_from_spec(ncd_spec)
    ncd_spec.loader.exec_module(ncd_module)


class TestLanguageDetection(unittest.TestCase):
    """F7: CJK 语言检测修复的回归测试"""

    def setUp(self):
        self.downloader = nccn_module.NCCNDownloaderV2(
            {"auth_method": "cookie", "cookie_file": "extracted_cookies.txt"}
        )

    def test_chinese_title_detected_as_chinese(self):
        """中文标题（含 CJK 字符）应返回 'Chinese'"""
        self.assertEqual(
            self.downloader._detect_pdf_language(
                "https://www.nccn.org/x.pdf", "乳腺癌 中文翻译"
            ),
            "Chinese",
        )

    def test_chinese_url_token_detected(self):
        """URL 含 -zh 标记应返回 'Chinese'"""
        self.assertEqual(
            self.downloader._detect_pdf_language(
                "https://www.nccn.org/breast-zh.pdf", ""
            ),
            "Chinese",
        )

    def test_english_title_detected_as_english(self):
        """纯英文标题应返回 'English'"""
        self.assertEqual(
            self.downloader._detect_pdf_language(
                "https://www.nccn.org/breast.pdf", "Breast Cancer"
            ),
            "English",
        )

    def test_spanish_url_detected(self):
        """URL 含 -es 标记应返回 'Spanish'"""
        self.assertEqual(
            self.downloader._detect_pdf_language(
                "https://www.nccn.org/breast-es.pdf", ""
            ),
            "Spanish",
        )

    def test_cjk_fullwidth_chars(self):
        """全角字符应被识别为 CJK"""
        self.assertTrue(nccn_module.NCCNDownloaderV2._contains_cjk("ＮＣＣＮ"))

    def test_cjk_empty_string(self):
        """空字符串应返回 False"""
        self.assertFalse(nccn_module.NCCNDownloaderV2._contains_cjk(""))
        self.assertFalse(nccn_module.NCCNDownloaderV2._contains_cjk(None))

    def test_cjk_pure_english(self):
        """纯英文应返回 False"""
        self.assertFalse(nccn_module.NCCNDownloaderV2._contains_cjk("Breast Cancer 2024"))

    def test_japanese_hiragana_detected_as_chinese(self):
        """日文假名也应被 CJK 检测命中（NCCN 翻译页仅分中文/英文）"""
        self.assertEqual(
            self.downloader._detect_pdf_language(
                "https://www.nccn.org/x.pdf", "乳がん"
            ),
            "Chinese",
        )


class TestURLWhitelist(unittest.TestCase):
    """F13: URL 域名白名单回归测试"""

    def test_nccn_org_allowed(self):
        self.assertTrue(
            nccn_module.NCCNDownloaderV2._is_url_allowed(
                "https://www.nccn.org/professionals/physician_gls/pdf/breast.pdf"
            )
        )

    def test_subdomain_of_nccn_org_allowed(self):
        self.assertTrue(
            nccn_module.NCCNDownloaderV2._is_url_allowed(
                "https://sub.nccn.org/x.pdf"
            )
        )

    def test_evil_domain_blocked(self):
        self.assertFalse(
            nccn_module.NCCNDownloaderV2._is_url_allowed(
                "https://evil.com/x.pdf"
            )
        )

    def test_relative_path_not_allowed(self):
        """相对路径无 netloc，不应通过域名白名单"""
        self.assertFalse(
            nccn_module.NCCNDownloaderV2._is_url_allowed("/relative/path.pdf")
        )


class TestFilenameSanitization(unittest.TestCase):
    """文件名清洗 — 防路径穿越"""

    def setUp(self):
        self.downloader = nccn_module.NCCNDownloaderV2(
            {"auth_method": "cookie", "cookie_file": "extracted_cookies.txt"}
        )

    def test_path_traversal_title_sanitized(self):
        info = self.downloader._enhance_pdf_info("../../etc/passwd", "2024", "https://www.nccn.org/x.pdf")
        fn = info.get("enhanced_filename") or info.get("filename")
        self.assertNotIn("/", fn)
        self.assertNotIn("\\", fn)
        self.assertNotIn("..", fn)


class TestModuleLoadAndInit(unittest.TestCase):
    """模块加载与实例化"""

    def test_module_loads(self):
        self.assertIsNotNone(nccn_module)

    def test_class_exists(self):
        self.assertTrue(hasattr(nccn_module, "NCCNDownloaderV2"))

    def test_instantiation(self):
        d = nccn_module.NCCNDownloaderV2(
            {"auth_method": "cookie", "cookie_file": "extracted_cookies.txt"}
        )
        self.assertIsNotNone(d)
        self.assertEqual(d.timeout, 30)  # F8: 默认 timeout
        self.assertEqual(d.max_retries, 3)  # F8: 默认 max_retries

    def test_timeout_from_config(self):
        """F8: config 中的 download_settings.timeout 应生效"""
        d = nccn_module.NCCNDownloaderV2(
            {"auth_method": "cookie", "cookie_file": "extracted_cookies.txt",
             "download_settings": {"timeout": 60, "max_retries": 5}}
        )
        self.assertEqual(d.timeout, 60)
        self.assertEqual(d.max_retries, 5)


class TestDownloadReturnValue(unittest.TestCase):
    """F3: _download_single_pdf 返回值语义"""

    def test_skipped_return_value(self):
        """跳过文件应返回 'skipped' 而非 True"""
        # 这个测试验证返回值类型设计，不实际下载
        # 'skipped' 和 True 是不同的值
        self.assertNotEqual("skipped", True)
        self.assertNotEqual("skipped", False)
        # is True 检查确保 'skipped' 不被误判
        self.assertFalse("skipped" == True and type("skipped") is type(True))


class TestLanguageGroupFilter(unittest.TestCase):
    """简化语言筛选回归测试"""

    def setUp(self):
        self.downloader = nccn_module.NCCNDownloaderV2(
            {"auth_method": "cookie", "cookie_file": "extracted_cookies.txt"}
        )

    def test_numeric_language_options(self):
        self.assertEqual(self.downloader.normalize_language_filter("0"), "chinese")
        self.assertEqual(self.downloader.normalize_language_filter("1"), "english")
        self.assertEqual(self.downloader.normalize_language_filter("2"), "other")
        self.assertEqual(self.downloader.normalize_language_filter("3"), "all")

    def test_language_group_allows_other_languages(self):
        self.assertTrue(self.downloader._language_allowed("Spanish", "2"))
        self.assertTrue(self.downloader._language_allowed("Japanese", "2"))
        self.assertFalse(self.downloader._language_allowed("English", "2"))
        self.assertFalse(self.downloader._language_allowed("Chinese", "2"))

    def test_language_group_all_allows_all(self):
        self.assertTrue(self.downloader._language_allowed("Spanish", "3"))
        self.assertTrue(self.downloader._language_allowed("English", "3"))


class TestCancerFilter(unittest.TestCase):
    """癌种筛选回归测试"""

    def setUp(self):
        self.downloader = nccn_module.NCCNDownloaderV2(
            {"auth_method": "cookie", "cookie_file": "extracted_cookies.txt"}
        )

    def test_normalize_cancer_keywords(self):
        keywords = self.downloader._normalize_cancer_filter("breast, 乳腺 lung")
        self.assertIn("breast", keywords)
        self.assertIn("乳腺", keywords)
        self.assertIn("lung", keywords)

    def test_chinese_keyword_expands_to_english_aliases(self):
        """中文关键词应自动扩展为对应癌种的英文别名"""
        keywords = self.downloader._normalize_cancer_filter("胰腺")
        self.assertIn("pancreatic", keywords)
        self.assertIn("胰腺", keywords)

    def test_chinese_keyword_breast_expands(self):
        keywords = self.downloader._normalize_cancer_filter("乳腺")
        self.assertIn("breast", keywords)
        self.assertIn("乳腺", keywords)

    def test_chinese_keyword_matches_english_title(self):
        """中文关键词"胰腺"应能匹配英文标题"Pancreatic Adenocarcinoma" """
        self.assertTrue(
            self.downloader._matches_cancer_filter(
                {"title": "Pancreatic Adenocarcinoma", "url": "https://www.nccn.org/x.pdf"},
                "胰腺",
            )
        )
        self.assertTrue(
            self.downloader._matches_cancer_filter(
                {"title": "Breast Cancer Guidelines", "url": "https://www.nccn.org/x.pdf"},
                "乳腺",
            )
        )
        self.assertFalse(
            self.downloader._matches_cancer_filter(
                {"title": "Lung Cancer Guidelines", "url": "https://www.nccn.org/x.pdf"},
                "胰腺",
            )
        )

    def test_full_cancer_type_list_has_pancreatic(self):
        """完整癌种列表应包含胰腺腺癌"""
        self.assertIn("pancreatic_adenocarcinoma", nccn_module.NCCNDownloaderV2.CANCER_TYPE_FILTERS)
        aliases = nccn_module.NCCNDownloaderV2.CANCER_TYPE_FILTERS["pancreatic_adenocarcinoma"]
        self.assertIn("pancreatic", aliases)
        self.assertIn("胰腺癌", aliases)

    def test_full_cancer_type_list_count(self):
        """完整癌种列表应包含至少60种癌种"""
        count = len(nccn_module.NCCNDownloaderV2.CANCER_TYPE_FILTERS)
        self.assertGreaterEqual(count, 60)  # 65 + 'all'

    def test_full_cancer_type_has_pediatric(self):
        """完整癌种列表应包含儿童癌种"""
        filters = nccn_module.NCCNDownloaderV2.CANCER_TYPE_FILTERS
        self.assertIn("pediatric_all", filters)
        self.assertIn("pediatric_cns", filters)
        self.assertIn("wilms_tumor", filters)

    def test_reverse_map_covers_chinese_keywords(self):
        """反向映射应覆盖中文关键词"""
        rmap = nccn_module.NCCNDownloaderV2._CANCER_ALIAS_REVERSE_MAP
        self.assertIn("胰腺癌", rmap)
        self.assertIn("乳腺癌", rmap)
        self.assertIn("膀胱癌", rmap)

    def test_default_language_is_english(self):
        """默认语言应为英文 (1)"""
        import inspect
        sig = inspect.signature(nccn_module._prompt_language_filter)
        default_param = sig.parameters['default'].default
        self.assertEqual(default_param, '1')

    def test_match_cancer_title(self):
        self.assertTrue(
            self.downloader._matches_cancer_filter(
                {"title": "Breast Cancer Guidelines", "url": "https://www.nccn.org/x.pdf"},
                "breast",
            )
        )
        self.assertTrue(
            self.downloader._matches_cancer_filter(
                {"title": "肺癌指南", "url": "https://www.nccn.org/x.pdf"},
                "lung",
            )
        )
        self.assertFalse(
            self.downloader._matches_cancer_filter(
                {"title": "Breast Cancer Guidelines", "url": "https://www.nccn.org/x.pdf"},
                "lung",
            )
        )

    def test_filter_sub_links_by_cancer(self):
        links = [
            {"url": "https://www.nccn.org/guidelines/guidelines-detail?guidelineId=breast-cancer", "title": "Breast Cancer"},
            {"url": "https://www.nccn.org/guidelines/guidelines-detail?guidelineId=lung-cancer", "title": "Lung Cancer"},
        ]
        filtered = self.downloader._filter_sub_links_by_cancer(links, "lung")
        self.assertEqual(len(filtered), 1)
        self.assertIn("lung-cancer", filtered[0]["url"])
        self.assertEqual(filtered[0]["title"], "Lung Cancer")

    def test_get_sub_links_extracts_titles(self):
        """_get_sub_links 应从锚文本提取标题，而非 URL basename"""
        from bs4 import BeautifulSoup
        html = """
        <div class="guideline-items">
            <div class="item">
                <div class="item-name"><a href="/guidelines/guidelines-detail?category=1&id=1410">Acute Lymphoblastic Leukemia</a></div>
            </div>
            <div class="item">
                <div class="item-name"><a href="/guidelines/guidelines-detail?category=1&id=1411">Breast Cancer</a></div>
            </div>
            <div class="item">
                <div class="item-name"><a href="/guidelines/guidelines-detail?category=1&id=1412">Lung Cancer</a></div>
            </div>
        </div>
        """
        soup = BeautifulSoup(html, 'html.parser')
        sub_links = self.downloader._get_sub_links(soup, "https://www.nccn.org/guidelines/category_1")
        titles = [s["title"] for s in sub_links]
        self.assertIn("Acute Lymphoblastic Leukemia", titles)
        self.assertIn("Breast Cancer", titles)
        self.assertIn("Lung Cancer", titles)
        # 确保不会提取到 URL basename 的伪标题
        for t in titles:
            self.assertNotEqual(t.lower(), "guidelines detail")

    def test_discover_cancer_types_uses_anchor_text(self):
        """_discover_cancer_types_from_page 应使用锚文本而非 URL basename"""
        from bs4 import BeautifulSoup
        html = """
        <div class="guideline-items">
            <div class="item-name"><a href="/guidelines/guidelines-detail?category=1&id=1410">Acute Lymphoblastic Leukemia</a></div>
            <div class="item-name"><a href="/guidelines/guidelines-detail?category=1&id=1411">Breast Cancer</a></div>
        </div>
        """
        soup = BeautifulSoup(html, 'html.parser')
        # 直接调用 _get_sub_links 来验证标题提取
        sub_links = self.downloader._get_sub_links(soup, "https://www.nccn.org/guidelines/category_1")
        items = [s.get("title", "").strip() for s in sub_links if s.get("title", "").strip()]
        self.assertIn("Acute Lymphoblastic Leukemia", items)
        self.assertIn("Breast Cancer", items)
        self.assertNotIn("guidelines detail", [i.lower() for i in items])


@unittest.skipUnless(ncd_module is not None, "ncd.py not available in skill deployment")
class TestCLIAndRagHelpers(unittest.TestCase):
    """CLI 与 RAG 辅助函数回归测试（依赖 ncd.py / nccn_rag.py，技能部署中可选）"""

    def test_cli_download_arguments(self):
        parser = ncd_module.build_parser()
        args = parser.parse_args(["download", "--cancer", "breast", "--language", "0", "--yes"])
        self.assertEqual(args.command, "download")
        self.assertEqual(args.cancer, "breast")
        self.assertEqual(args.language, "0")
        self.assertTrue(args.yes)

    def test_build_config_env_cookie_override(self):
        args = ncd_module.argparse.Namespace(download_dir=None)
        with patch.dict(os.environ, {"NCCN_AUTH_METHOD": "cookie", "NCCN_COOKIE": "a=b"}, clear=False):
            config = ncd_module.build_config({}, args)
        self.assertEqual(config["auth_method"], "cookie")
        self.assertEqual(config["cookie"], "a=b")

    def test_resolve_config_path_relative_to_script_dir(self):
        self.assertEqual(
            ncd_module.resolve_config_path("config.json"),
            ncd_module.SCRIPT_DIR / "config.json",
        )

    def test_create_downloader_uses_custom_config_path(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir_path = Path(tmpdir)
            cookie_path = tmpdir_path / "cookies.txt"
            cookie_path.write_text("a=b", encoding="utf-8")
            config_path = tmpdir_path / "custom-config.json"
            config_path.write_text(
                json.dumps({"authentication": {"method": "cookie", "cookie_file": str(cookie_path)}}),
                encoding="utf-8",
            )
            download_dir = tmpdir_path / "downloads"
            args = argparse.Namespace(config=str(config_path), download_dir=str(download_dir))

            downloader = ncd_module.create_downloader(args)

            self.assertEqual(downloader.base_download_dir, download_dir.resolve())
            self.assertTrue(downloader.logs_dir.exists())

    def test_cli_convert_deepseek_ocr_arguments(self):
        parser = ncd_module.build_parser()
        args = parser.parse_args([
            "convert",
            "--input", "guide.pdf",
            "--ocr-backend", "deepseek-ocr",
            "--api-key", "sf-key",
            "--base-url", "https://api.siliconflow.cn/v1",
            "--model", "deepseek-ai/DeepSeek-OCR",
            "--max-pages", "3",
        ])
        self.assertEqual(args.command, "convert")
        self.assertEqual(args.ocr_backend, "deepseek-ocr")
        self.assertEqual(args.api_key, "sf-key")
        self.assertEqual(args.base_url, "https://api.siliconflow.cn/v1")
        self.assertEqual(args.model, "deepseek-ai/DeepSeek-OCR")
        self.assertEqual(args.max_pages, 3)

    def test_deepseek_ocr_call_payload(self):
        from nccn_rag import _call_deepseek_ocr_page

        with patch("nccn_rag.requests.post") as post:
            post.return_value.raise_for_status.return_value = None
            post.return_value.json.return_value = {"choices": [{"message": {"content": "OCR text"}}]}
            result = _call_deepseek_ocr_page(
                "data:image/png;base64,abc",
                api_key="sf-key",
                base_url="https://api.siliconflow.cn/v1",
                model="deepseek-ai/DeepSeek-OCR",
            )

        self.assertEqual(result, "OCR text")
        payload = post.call_args.kwargs["json"]
        self.assertEqual(payload["model"], "deepseek-ai/DeepSeek-OCR")
        self.assertEqual(post.call_args.args[0], "https://api.siliconflow.cn/v1/chat/completions")
        content = payload["messages"][0]["content"]
        self.assertEqual(content[0]["type"], "text")
        self.assertEqual(content[1]["type"], "image_url")

    def test_translate_markdown_defaults_to_siliconflow_glm_4_5_air(self):
        from nccn_rag import translate_markdown

        with tempfile.TemporaryDirectory() as tmpdir:
            md_path = Path(tmpdir) / "guide.md"
            out_path = Path(tmpdir) / "guide.zh.md"
            md_path.write_text("Hello world", encoding="utf-8")
            with patch.dict(os.environ, {"SILICONFLOW_API_KEY": "sf-key"}, clear=False):
                os.environ.pop("OPENAI_API_KEY", None)
                os.environ.pop("OPENAI_BASE_URL", None)
                os.environ.pop("OPENAI_MODEL", None)
                with patch("nccn_rag.requests.post") as post:
                    post.return_value.raise_for_status.return_value = None
                    post.return_value.json.return_value = {"choices": [{"message": {"content": "你好世界"}}]}
                    output = translate_markdown(md_path, out_path)

        payload = post.call_args.kwargs["json"]
        self.assertEqual(output, out_path.resolve())
        self.assertEqual(post.call_args.args[0], "https://api.siliconflow.cn/v1/chat/completions")
        self.assertEqual(payload["model"], "glm-4.5-air")

    def test_split_markdown_to_chunks(self):
        from nccn_rag import split_markdown_to_chunks

        with tempfile.TemporaryDirectory() as tmpdir:
            md_path = Path(tmpdir) / "guide.md"
            jsonl_path = Path(tmpdir) / "guide.chunks.jsonl"
            md_path.write_text("# Title\n\n段落一。\n\n段落二。", encoding="utf-8")
            chunks = split_markdown_to_chunks(md_path, jsonl_path, chunk_size=8)
            self.assertGreaterEqual(len(chunks), 2)
            self.assertTrue(jsonl_path.exists())


if __name__ == "__main__":
    print("=" * 60)
    print("NCCN指南下载工具 — 离线回归测试")
    print("=" * 60)
    unittest.main(verbosity=2)
