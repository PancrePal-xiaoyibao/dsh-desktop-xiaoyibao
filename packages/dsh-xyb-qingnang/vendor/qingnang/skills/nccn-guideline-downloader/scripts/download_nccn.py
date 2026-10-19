#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NCCN指南下载工具 v2.0
优化的菜单式下载工具，支持多主题分类下载、安全请求控制、完善日志和重新下载功能

作者: Claude Code
版本: 2.0.0
日期: 2024-12-01
"""

import requests
from bs4 import BeautifulSoup
import os
import sys
import time
import json
import random
import logging
import re
from urllib.parse import urlparse, urljoin
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any
from dataclasses import dataclass, asdict
import hashlib

# 第三方库
try:
    from tqdm import tqdm
except ImportError:
    print("警告: tqdm未安装，将使用简单的进度显示")
    tqdm = lambda x, **kwargs: x


@dataclass
class DownloadStats:
    """下载统计信息"""
    total_files: int = 0
    successful_files: int = 0
    failed_files: int = 0
    skipped_files: int = 0
    total_size_mb: float = 0.0
    downloaded_size_mb: float = 0.0
    start_time: float = 0.0
    end_time: float = 0.0
    failed_files_list: List[str] = None

    def __post_init__(self):
        if self.failed_files_list is None:
            self.failed_files_list = []

    @property
    def duration_seconds(self) -> float:
        """获取总耗时"""
        if self.end_time and self.start_time:
            return self.end_time - self.start_time
        return 0.0

    @property
    def success_rate(self) -> float:
        """获取成功率"""
        if self.total_files == 0:
            return 0.0
        return (self.successful_files / self.total_files) * 100

    @property
    def avg_speed_mbps(self) -> float:
        """获取平均下载速度 (MB/s)"""
        duration = self.duration_seconds
        if duration > 0 and self.downloaded_size_mb > 0:
            return self.downloaded_size_mb / duration
        return 0.0

    def to_dict(self) -> Dict:
        """转换为字典格式"""
        data = asdict(self)
        data['duration_seconds'] = self.duration_seconds
        data['success_rate'] = self.success_rate
        data['avg_speed_mbps'] = self.avg_speed_mbps
        return data


@dataclass
class ThemeConfig:
    """主题配置"""
    name: str
    display_name: str
    url: str
    category: str
    directory: str
    description: str
    has_language_filter: bool = False
    guidelines_only: bool = False


class NCCNDownloaderV2:
    """NCCN下载器 v2.0"""

    # 允许的下载域名白名单（防止从 NCCN 页面抓取到的恶意链接被下载）
    ALLOWED_DOWNLOAD_DOMAINS = ('nccn.org',)

    # 主题配置
    THEMES = {
        '1': ThemeConfig(
            name='cancer_treatment',
            display_name='癌症治疗指南英文版 (Treatment by Cancer Type - English Only)',
            url='https://www.nccn.org/guidelines/category_1',
            category='category_1',
            directory='01_Cancer_Treatment',
            description='按癌症类型分类的治疗指南（英文版）',
            has_language_filter=True,
            guidelines_only=True
        ),
        '2': ThemeConfig(
            name='supportive_care',
            display_name='支持性护理指南 (Supportive Care)',
            url='https://www.nccn.org/guidelines/category_3',
            category='category_3',
            directory='02_Supportive_Care',
            description='支持性护理相关指南',
            has_language_filter=True
        ),
        '3': ThemeConfig(
            name='patient_guidelines',
            display_name='患者指南英文版 (Patient Guidelines - English Only)',
            url='https://www.nccn.org/patientresources/patient-resources/guidelines-for-patients',
            category='patient_guidelines_english',
            directory='03_Patient_Guidelines_English',
            description='患者专用英文指南'
        ),
        '4': ThemeConfig(
            name='clinical_translations',
            display_name='临床指南中文翻译 (Clinical Translations)',
            url='https://www.nccn.org/global/what-we-do/clinical-guidelines-translations',
            category='clinical_translations',
            directory='04_Clinical_Translations',
            description='临床指南中文翻译版本'
        ),
        '5': ThemeConfig(
            name='patient_translations',
            display_name='患者指南中文翻译 (Patient Guidelines Translations)',
            url='https://www.nccn.org/global/what-we-do/guidelines-for-patients-translations',
            category='patient_translations',
            directory='05_Patient_Translations',
            description='患者指南中文翻译版本'
        ),
        '6': ThemeConfig(
            name='patient_guidelines_chinese',
            display_name='患者指南中文版本 (Chinese Patient Guidelines)',
            url='https://www.nccn.org/global/what-we-do/guidelines-for-patients-translations',
            category='patient_guidelines_chinese',
            directory='06_Chinese_Patient_Guidelines',
            description='患者指南中文翻译版本下载',
            has_language_filter=False
        )
    }

    # 认证方式
    AUTH_METHODS = {
        '1': 'username_password',
        '2': 'cookie'
    }

    # 简化后的语言筛选：兼容旧代码中的 english/chinese/all
    LANGUAGE_GROUPS = {
        '0': 'chinese',
        '1': 'english',
        '2': 'other',
        '3': 'all',
        'zh': 'chinese',
        'cn': 'chinese',
        'chinese': 'chinese',
        'en': 'english',
        'english': 'english',
        'ja': 'other',
        'jp': 'other',
        'japanese': 'other',
        'other': 'other',
        'all': 'all',
    }

    LANGUAGE_GROUP_LABELS = {
        'chinese': '中文',
        'english': '英文',
        'other': '日语/其他语言',
        'all': '全部',
    }

    # 内置癌种关键词：完整 NCCN 癌种列表（从官网提取，含中英文别名）
    # key=英文主键, value=[英文关键词..., 中文关键词...]
    CANCER_TYPE_FILTERS = {
        'all': ['all', '全部', '所有'],
        'acute_lymphoblastic_leukemia': ['acute lymphoblastic leukemia', 'all', '急性淋巴细胞白血病', '急淋'],
        'acute_myeloid_leukemia': ['acute myeloid leukemia', 'aml', '急性髓系白血病', '急髓'],
        'ampullary_adenocarcinoma': ['ampullary adenocarcinoma', 'ampullary', '壶腹腺癌', '壶腹'],
        'anal_carcinoma': ['anal carcinoma', 'anal', '肛门癌', '肛门'],
        'appendiceal_neoplasms': ['appendiceal neoplasms', 'appendiceal', 'appendix', '阑尾肿瘤', '阑尾'],
        'basal_cell_skin_cancer': ['basal cell skin cancer', 'basal cell', '基底细胞皮肤癌', '基底细胞癌'],
        'b_cell_lymphomas': ['b-cell lymphomas', 'b-cell lymphoma', 'b细胞淋巴瘤'],
        'biliary_tract_cancers': ['biliary tract cancers', 'biliary', '胆道癌', '胆道'],
        'bladder_cancer': ['bladder cancer', 'bladder', '膀胱癌', '膀胱'],
        'bone_cancer': ['bone cancer', 'bone', '骨癌', '骨肿瘤'],
        'breast_cancer': ['breast cancer', 'breast', '乳腺癌', '乳腺'],
        'castleman_disease': ['castleman disease', 'castleman', '卡斯尔曼病'],
        'central_nervous_system_cancers': ['central nervous system cancers', 'cns', '中枢神经系统肿瘤', '中枢神经', '脑'],
        'cervical_cancer': ['cervical cancer', 'cervical', '宫颈癌', '宫颈'],
        'chronic_lymphocytic_leukemia': ['chronic lymphocytic leukemia', 'small lymphocytic lymphoma', 'cll', 'sll', '慢性淋巴细胞白血病', '慢淋'],
        'chronic_myeloid_leukemia': ['chronic myeloid leukemia', 'cml', '慢性髓系白血病', '慢髓'],
        'colon_cancer': ['colon cancer', 'colon', '结肠癌', '结肠'],
        'cutaneous_lymphomas': ['cutaneous lymphomas', 'cutaneous lymphoma', '皮肤淋巴瘤'],
        'dermatofibrosarcoma_protuberans': ['dermatofibrosarcoma protuberans', 'dfsp', '隆突性皮肤纤维肉瘤'],
        'esophageal_cancers': ['esophageal and esophagogastric junction cancers', 'esophageal', 'esophagogastric', '食管癌', '食管', '食管胃结合部'],
        'gastric_cancer': ['gastric cancer', 'gastric', 'stomach', '胃癌', '胃'],
        'gastrointestinal_stromal_tumors': ['gastrointestinal stromal tumors', 'gist', '胃肠道间质瘤', '间质瘤'],
        'gestational_trophoblastic_neoplasia': ['gestational trophoblastic neoplasia', 'gtn', '妊娠滋养细胞肿瘤', '滋养细胞'],
        'hairy_cell_leukemia': ['hairy cell leukemia', 'hairy cell', '毛细胞白血病'],
        'head_and_neck_cancers': ['head and neck cancers', 'head', 'neck', '头颈癌', '头颈'],
        'hepatobiliary_cancers': ['hepatobiliary cancers', 'hepatobiliary', '肝胆癌', '肝胆'],
        'hepatocellular_carcinoma': ['hepatocellular carcinoma', 'hcc', '肝细胞癌', '肝癌', '肝'],
        'histiocytic_neoplasms': ['histiocytic neoplasms', 'histiocytic', '组织细胞肿瘤'],
        'hodgkin_lymphoma': ['hodgkin lymphoma', 'hodgkin', '霍奇金淋巴瘤', '霍奇金'],
        'kaposi_sarcoma': ['kaposi sarcoma', 'kaposi', '卡波西肉瘤'],
        'kidney_cancer': ['kidney cancer', 'kidney', 'renal', '肾癌', '肾'],
        'melanoma_cutaneous': ['melanoma: cutaneous', 'cutaneous melanoma', 'melanoma', '皮肤黑色素瘤', '黑色素瘤'],
        'melanoma_uveal': ['melanoma: uveal', 'uveal melanoma', '葡萄膜黑色素瘤'],
        'merkel_cell_carcinoma': ['merkel cell carcinoma', 'merkel', '默克尔细胞癌'],
        'mesothelioma_peritoneal': ['mesothelioma: peritoneal', 'peritoneal mesothelioma', '腹膜间皮瘤'],
        'mesothelioma_pleural': ['mesothelioma: pleural', 'pleural mesothelioma', '胸膜间皮瘤', '间皮瘤'],
        'multiple_myeloma': ['multiple myeloma', 'myeloma', '多发性骨髓瘤', '骨髓瘤'],
        'myelodysplastic_syndromes': ['myelodysplastic syndromes', 'mds', '骨髓增生异常综合征'],
        'myeloid_lymphoid_neoplasms': ['myeloid/lymphoid neoplasms with eosinophilia', 'myeloid lymphoid', '髓系/淋系肿瘤', '嗜酸性粒细胞'],
        'myeloproliferative_neoplasms': ['myeloproliferative neoplasms', 'mpn', '骨髓增殖性肿瘤'],
        'neuroblastoma': ['neuroblastoma', '神经母细胞瘤'],
        'neuroendocrine_adrenal_tumors': ['neuroendocrine and adrenal tumors', 'neuroendocrine', 'adrenal', '神经内分泌肿瘤', '肾上腺肿瘤'],
        'non_small_cell_lung_cancer': ['non-small cell lung cancer', 'nsclc', 'lung', '非小细胞肺癌', '肺癌', '肺'],
        'occult_primary': ['occult primary', '隐匿性原发癌', '原发不明'],
        'ovarian_cancer': ['ovarian cancer', 'fallopian tube cancer', 'primary peritoneal cancer', 'ovarian', '卵巢癌', '输卵管癌', '腹膜癌', '卵巢'],
        'pancreatic_adenocarcinoma': ['pancreatic adenocarcinoma', 'pancreatic', 'pancreas', '胰腺腺癌', '胰腺癌', '胰腺'],
        'pediatric_all': ['pediatric acute lymphoblastic leukemia', '儿童急性淋巴细胞白血病', '儿童急淋'],
        'pediatric_b_cell_lymphoma': ['pediatric aggressive mature b-cell lymphomas', '儿童侵袭性成熟b细胞淋巴瘤'],
        'pediatric_cns': ['pediatric central nervous system cancers', '儿童中枢神经系统肿瘤'],
        'pediatric_hodgkin': ['pediatric hodgkin lymphoma', '儿童霍奇金淋巴瘤'],
        'pediatric_soft_tissue_sarcoma': ['pediatric soft tissue sarcoma', '儿童软组织肉瘤'],
        'penile_cancer': ['penile cancer', 'penile', '阴茎癌', '阴茎'],
        'prostate_cancer': ['prostate cancer', 'prostate', '前列腺癌', '前列腺'],
        'rectal_cancer': ['rectal cancer', 'rectal', 'rectum', '直肠癌', '直肠'],
        'small_bowel_adenocarcinoma': ['small bowel adenocarcinoma', 'small bowel', '小肠腺癌', '小肠'],
        'small_cell_lung_cancer': ['small cell lung cancer', 'sclc', 'lung', '小细胞肺癌', '肺癌', '肺'],
        'soft_tissue_sarcoma': ['soft tissue sarcoma', 'sarcoma', '软组织肉瘤', '肉瘤'],
        'squamous_cell_skin_cancer': ['squamous cell skin cancer', 'squamous cell', '鳞状细胞皮肤癌', '鳞癌'],
        'systemic_light_chain_amyloidosis': ['systemic light chain amyloidosis', 'amyloidosis', '系统性轻链淀粉样变性', '淀粉样变'],
        'systemic_mastocytosis': ['systemic mastocytosis', 'mastocytosis', '系统性肥大细胞增多症'],
        't_cell_lymphomas': ['t-cell lymphomas', 't-cell lymphoma', 't细胞淋巴瘤'],
        'testicular_cancer': ['testicular cancer', 'testicular', '睾丸癌', '睾丸'],
        'thymomas_thymic': ['thymomas and thymic carcinomas', 'thymoma', 'thymic', '胸腺瘤', '胸腺癌', '胸腺'],
        'thyroid_carcinoma': ['thyroid carcinoma', 'thyroid', '甲状腺癌', '甲状腺'],
        'uterine_neoplasms': ['uterine neoplasms', 'uterine', 'endometrial', '子宫肿瘤', '子宫内膜癌', '子宫'],
        'vaginal_cancer': ['vaginal cancer', 'vaginal', '阴道癌', '阴道'],
        'vulvar_cancer': ['vulvar cancer', 'vulvar', '外阴癌', '外阴'],
        'waldenstrom_macroglobulinemia': ['waldenström macroglobulinemia', 'lymphoplasmacytic lymphoma', 'wm', '华氏巨球蛋白血症', '淋巴浆细胞淋巴瘤'],
        'wilms_tumor': ['wilms tumor', 'nephroblastoma', 'wilms', '肾母细胞瘤'],
    }

    # 反向映射：别名 → 癌种主键，用于将中文/别名关键词扩展为全部别名
    # 例如: "胰腺" → "pancreatic" → ["pancreatic", "胰腺"]
    _CANCER_ALIAS_REVERSE_MAP = {}
    for _key, _aliases in CANCER_TYPE_FILTERS.items():
        for _alias in _aliases:
            if _alias not in _CANCER_ALIAS_REVERSE_MAP:
                _CANCER_ALIAS_REVERSE_MAP[_alias.lower()] = _key
    del _key, _aliases, _alias

    def __init__(self, config: Dict[str, Any]):
        """初始化下载器

        Args:
            config: 配置字典，包含认证信息等
        """
        self.config = config
        self.session = requests.Session()
        self.base_download_dir = Path('nccn_downloads')
        self.logs_dir = self.base_download_dir / 'logs'
        self.setup_directories()
        self.setup_logging()
        self.stats = DownloadStats()

        # 下载设置：优先读取 config['download_settings']，未配置时回退到默认值
        download_settings = self.config.get('download_settings', {}) or {}
        self.max_retries = download_settings.get('max_retries', 3)
        self.retry_delay = download_settings.get('retry_delay', 5)
        self.request_delay = download_settings.get('request_delay', (2, 5))
        self.min_file_size = download_settings.get('min_file_size', 100 * 1024)

        # 所有 requests 调用的超时设置
        self.timeout = download_settings.get('timeout', 30)

        self.setup_session()

    def setup_session(self):
        """设置会话"""
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache'
        })

        # 设置Cookie（如果使用Cookie认证）
        if self.config.get('auth_method') == 'cookie' and self.config.get('cookie'):
            cookie_dict = self.parse_cookie_string(self.config['cookie'])
            self.session.cookies.update(cookie_dict)

    def parse_cookie_string(self, cookie_string: str) -> Dict[str, str]:
        """解析Cookie字符串为字典格式"""
        cookies = {}
        for item in cookie_string.split(';'):
            if '=' in item:
                key, value = item.strip().split('=', 1)
                cookies[key] = value
        return cookies

    @staticmethod
    def normalize_language_filter(language_filter: Any) -> str:
        """将交互/CLI 的数字语言选项转换为旧逻辑可识别的 all/english/chinese/other。"""
        if language_filter is None:
            return 'all'
        key = str(language_filter).strip().lower()
        if not key:
            return 'all'
        group = NCCNDownloaderV2.LANGUAGE_GROUPS.get(key, key)
        if group == 'chinese':
            return 'chinese'
        if group == 'english':
            return 'english'
        if group == 'other':
            return 'other'
        return 'all'

    @staticmethod
    def language_group_label(language_filter: Any) -> str:
        """获取语言筛选的中文展示名称。"""
        group = NCCNDownloaderV2.normalize_language_filter(language_filter)
        return NCCNDownloaderV2.LANGUAGE_GROUP_LABELS.get(group, language_filter)

    @staticmethod
    def _language_allowed(detected_language: str, language_filter: Any) -> bool:
        """判断检测到的语言是否属于当前语言分组。"""
        group = NCCNDownloaderV2.normalize_language_filter(language_filter)
        if group == 'all':
            return True
        if group == 'chinese':
            return detected_language == 'Chinese'
        if group == 'english':
            return detected_language == 'English'
        if group == 'other':
            return detected_language not in ['English', 'Chinese']
        return True

    @staticmethod
    def _normalize_cancer_filter(cancer_filter: Any) -> List[str]:
        """将癌种筛选输入转换为小写关键词列表。

        如果输入的是别名（如中文"胰腺"），会自动扩展为对应癌种的全部别名
        （如 ["pancreatic", "胰腺"]），确保能匹配英文标题。
        """
        if cancer_filter is None:
            return []
        if isinstance(cancer_filter, (list, tuple, set)):
            values = cancer_filter
        else:
            values = re.split(r'[,，|;；\s]+', str(cancer_filter))
        keywords = []
        for value in values:
            value = str(value).strip().lower()
            if value and value not in ['0', 'all', '全部', '所有']:
                # 反向查找：如果是别名，扩展为对应癌种的全部别名
                cancer_key = NCCNDownloaderV2._CANCER_ALIAS_REVERSE_MAP.get(value)
                if cancer_key and cancer_key in NCCNDownloaderV2.CANCER_TYPE_FILTERS:
                    for alias in NCCNDownloaderV2.CANCER_TYPE_FILTERS[cancer_key]:
                        if alias not in keywords:
                            keywords.append(alias)
                elif value not in keywords:
                    keywords.append(value)
        return keywords

    def _matches_cancer_filter(self, pdf_info: Dict[str, Any], cancer_filter: Any) -> bool:
        """判断 PDF 信息是否匹配癌种筛选。"""
        keywords = self._normalize_cancer_filter(cancer_filter)
        if not keywords:
            return True

        haystack_parts = [
            pdf_info.get('title', ''),
            pdf_info.get('url', ''),
            pdf_info.get('source_page', ''),
        ]
        haystack = ' '.join(str(part).lower() for part in haystack_parts)

        for keyword in keywords:
            alias_values = self.CANCER_TYPE_FILTERS.get(keyword, [keyword])
            if any(alias in haystack for alias in alias_values):
                return True
        return False

    def _filter_pdf_links_by_language(self, pdf_links: List[Dict[str, Any]], language_filter: Any) -> List[Dict[str, Any]]:
        """按语言分组过滤 PDF 链接。"""
        return [
            pdf_info for pdf_info in pdf_links
            if self._language_allowed(pdf_info.get('version', 'English'), language_filter)
        ]

    def _filter_pdf_links_by_cancer(self, pdf_links: List[Dict[str, Any]], cancer_filter: Any) -> List[Dict[str, Any]]:
        """按癌种关键词过滤 PDF 链接。"""
        return [
            pdf_info for pdf_info in pdf_links
            if self._matches_cancer_filter(pdf_info, cancer_filter)
        ]

    def setup_directories(self):
        """设置目录结构"""
        # 创建基础目录
        self.base_download_dir.mkdir(exist_ok=True)
        self.logs_dir.mkdir(exist_ok=True)

        # 创建各主题目录
        for theme in self.THEMES.values():
            theme_dir = self.base_download_dir / theme.directory
            theme_dir.mkdir(exist_ok=True)

    def setup_logging(self):
        """设置日志系统"""
        # 日志文件名包含日期
        log_date = datetime.now().strftime('%Y%m%d')
        log_file = self.logs_dir / f'download_{log_date}.log'

        # 配置日志
        self.logger = logging.getLogger(__name__)
        self.logger.setLevel(logging.INFO)
        for handler in list(self.logger.handlers):
            self.logger.removeHandler(handler)
            handler.close()
        self.logger.propagate = False
        formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')

        file_handler = logging.FileHandler(log_file, encoding='utf-8')
        file_handler.setFormatter(formatter)
        stream_handler = logging.StreamHandler(sys.stdout)
        stream_handler.setFormatter(formatter)

        self.logger.addHandler(file_handler)
        self.logger.addHandler(stream_handler)
        self.logger.info("=== NCCN下载工具 v2.0 启动 ===")

    def authenticate(self) -> bool:
        """认证到NCCN网站

        Returns:
            bool: 认证是否成功
        """
        self.logger.info("开始NCCN网站认证...")

        try:
            if self.config.get('auth_method') == 'username_password':
                return self._authenticate_username_password()
            elif self.config.get('auth_method') == 'cookie':
                return self._authenticate_cookie()
            else:
                self.logger.error("未知的认证方式")
                return False

        except Exception as e:
            self.logger.error(f"认证过程发生错误: {str(e)}")
            return False

    def _authenticate_username_password(self) -> bool:
        """用户名密码认证"""
        email = self.config.get('username')
        password = self.config.get('password')

        if not email or not password:
            self.logger.error("用户名或密码未设置")
            return False

        try:
            # 1. 访问登录页面获取token
            login_page_url = "https://www.nccn.org/login"
            self.logger.debug(f"访问登录页面: {login_page_url}")

            response = self.session.get(login_page_url, timeout=self.timeout)
            response.raise_for_status()

            # 解析页面获取token
            soup = BeautifulSoup(response.content, 'html.parser')
            token_element = soup.find('input', {'name': '__RequestVerificationToken'})
            token = token_element.get('value', '') if token_element else ''

            # 2. 构建登录数据
            login_data = {
                '__RequestVerificationToken': token,
                'Username': email,
                'Password': password,
                'RememberMe': 'true'
            }

            # 3. 发送登录请求
            self.logger.debug("发送登录请求...")
            login_response = self.session.post(
                login_page_url,
                data=login_data,
                allow_redirects=True,
                timeout=self.timeout
            )
            login_response.raise_for_status()

            # 4. 验证登录状态
            if 'login' in login_response.url.lower():
                self.logger.error("登录失败，请检查用户名和密码")
                return False

            # 5. 测试访问受限页面
            test_url = "https://www.nccn.org/guidelines/category_1"
            test_response = self.session.get(test_url, timeout=self.timeout)

            if test_response.status_code == 200 and 'login' not in test_response.url.lower():
                self.logger.info("用户名密码认证成功")
                return True
            else:
                self.logger.error("登录状态验证失败")
                return False

        except Exception as e:
            self.logger.error(f"用户名密码认证失败: {str(e)}")
            return False

    def _authenticate_cookie(self) -> bool:
        """Cookie认证"""
        try:
            # 获取Cookie文件路径
            cookie_file = self.config.get('cookie_file', 'extracted_cookies.txt')

            if not os.path.exists(cookie_file):
                self.logger.error(f"Cookie文件不存在: {cookie_file}")
                return False

            # 读取Cookie文件
            try:
                with open(cookie_file, 'r', encoding='utf-8') as f:
                    cookie_string = f.read().strip()
            except Exception as e:
                self.logger.error(f"读取Cookie文件失败: {str(e)}")
                return False

            if not cookie_string:
                self.logger.error("Cookie文件为空")
                return False

            # 解析Cookie字符串
            try:
                cookies = {}
                for item in cookie_string.split(';'):
                    if '=' in item:
                        key, value = item.strip().split('=', 1)
                        cookies[key] = value

                # 添加Cookie到session
                self.session.cookies.update(cookies)
                self.logger.info(f"成功加载 {len(cookies)} 个Cookie")

            except Exception as e:
                self.logger.error(f"解析Cookie失败: {str(e)}")
                return False

            # 测试访问受限页面
            test_url = "https://www.nccn.org/guidelines/category_1"
            self.logger.debug(f"使用Cookie测试访问: {test_url}")

            response = self.session.get(test_url, timeout=self.timeout)

            if response.status_code == 200 and 'login' not in response.url.lower():
                self.logger.info("Cookie认证成功")
                return True
            else:
                self.logger.error("Cookie认证失败，可能需要重新获取")
                return False

        except Exception as e:
            self.logger.error(f"Cookie认证失败: {str(e)}")
            return False

    def ensure_authenticated(self) -> bool:
        """确保已认证"""
        try:
            test_url = "https://www.nccn.org/guidelines/category_1"
            response = self.session.get(test_url, timeout=self.timeout)

            # 既检查重定向到登录页，也检查非 200 状态码
            if 'login' in response.url.lower() or response.status_code != 200:
                self.logger.warning(
                    f"检测到登录状态失效（状态码 {response.status_code}），尝试重新认证"
                )
                return self.authenticate()
            return True

        except Exception as e:
            self.logger.error(f"检查认证状态失败: {str(e)}")
            return self.authenticate()

    def download_theme(self, theme_key: str, language_filter: str = 'all', cancer_filter: Any = None, pdf_selection: List[Dict[str, Any]] = None) -> bool:
        """下载指定主题的指南

        Args:
            theme_key: 主题键 ('1'-'6')
            language_filter: 语言过滤选项 ('all', 'english', 'chinese', 'other')
            cancer_filter: 癌种筛选关键词，支持英文/中文/逗号分隔
            pdf_selection: 用户选择的 PDF 子列表（可选，为 None 时下载全部）

        Returns:
            bool: 下载是否成功
        """
        if theme_key not in self.THEMES:
            self.logger.error(f"无效的主题键: {theme_key}")
            return False

        theme = self.THEMES[theme_key]
        self.logger.info(f"开始下载主题: {theme.display_name}")

        # 确保认证
        if not self.ensure_authenticated():
            self.logger.error("认证失败，无法继续下载")
            return False

        # 初始化统计
        self.stats = DownloadStats()
        self.stats.start_time = time.time()

        try:
            # 获取PDF链接
            pdf_links = self._get_pdf_links(theme, language_filter, cancer_filter)
            if not pdf_links:
                self.logger.warning(f"未找到PDF链接: {theme.display_name}")
                return False

            # 如果传入了用户选择，只下载选中的文件
            if pdf_selection is not None:
                selected_urls = {p['url'] for p in pdf_selection}
                pdf_links = [p for p in pdf_links if p['url'] in selected_urls]

            self.stats.total_files = len(pdf_links)
            self.logger.info(f"找到 {self.stats.total_files} 个PDF文件")

            # 创建主题目录
            theme_dir = self.base_download_dir / theme.directory
            theme_dir.mkdir(exist_ok=True)

            # 下载每个PDF
            successful_count = 0
            failed_files = []

            for i, pdf_info in enumerate(pdf_links, 1):
                self.logger.info(f"[{i}/{self.stats.total_files}] 处理: {pdf_info['title']}")

                # 随机延迟，避免请求过快
                time.sleep(random.uniform(*self.request_delay))

                # 下载文件
                result = self._download_single_pdf(pdf_info, theme_dir)

                if result is True:
                    # 真正新下载成功，计入 successful_files
                    successful_count += 1
                    self.stats.successful_files += 1
                elif result == 'skipped':
                    # 已存在跳过，计入 skipped_files（已在 _download_single_pdf 内累加），
                    # 不再重复计入 successful_files，避免成功率虚高
                    successful_count += 1
                else:
                    failed_files.append(pdf_info['url'])
                    self.stats.failed_files += 1

            self.stats.end_time = time.time()
            self.stats.failed_files_list = failed_files

            # 生成统计报告
            self._generate_download_report(theme)

            # 询问是否重新下载失败的文件
            if failed_files:
                self._handle_failed_downloads(failed_files, theme_dir, language_filter)

            return successful_count > 0

        except Exception as e:
            self.logger.error(f"下载主题失败: {str(e)}")
            return False

    def _get_pdf_links(self, theme: ThemeConfig, language_filter: str = 'all', cancer_filter: Any = None) -> List[Dict[str, Any]]:
        """获取PDF链接列表

        Args:
            theme: 主题配置
            language_filter: 语言过滤选项 ('all', 'english', 'chinese', 'other')
            cancer_filter: 癌种筛选关键词，支持英文/中文/逗号分隔

        Returns:
            List[Dict]: PDF信息列表，每个包含title, url, version等
        """
        try:
            self.logger.info(f"🔍 开始获取PDF链接: {theme.url}")
            self.logger.info(f"🌐 语言过滤: {self.language_group_label(language_filter)}")
            self.logger.debug(f"请求主题: {theme.display_name}")
            self.logger.debug(f"癌种筛选: {cancer_filter}")

            # 第一步：获取主页面
            self.logger.info(f"📡 发送HTTP请求...")
            response = self.session.get(theme.url, timeout=self.timeout)
            response.raise_for_status()

            self.logger.info(f"✅ HTTP请求成功，状态码: {response.status_code}")
            self.logger.info(f"📄 页面内容长度: {len(response.content)} 字节")

            soup = BeautifulSoup(response.content, 'html.parser')

            # 根据主题类型使用不同的解析策略
            if theme.category in ['clinical_translations', 'patient_translations']:
                # 中文翻译页面：直接解析PDF链接，无需两步流程
                self.logger.info(f"🎯 使用解析策略: translations (翻译版本，直接解析)")
                pdf_links = self._parse_translations(soup, theme, language_filter)
            elif theme.category == 'patient_guidelines_chinese':
                # 患者指南中文版本：直接解析翻译页面
                self.logger.info(f"🎯 使用解析策略: chinese_only (患者指南中文版本，直接访问翻译页面)")
                pdf_links = self._parse_patient_guidelines_chinese(soup, theme)
            elif theme.category == 'patient_guidelines_english':
                # 患者指南双语版本：双步骤解析，支持英文/中文/多语言
                self.logger.info(f"🎯 使用解析策略: bilingual (患者指南双语/多语言版本，双步解析)")
                pdf_links = self._parse_patient_guidelines_bilingual(soup, theme, language_filter)
            else:
                # 标准页面：两步流程
                self.logger.info(f"🔍 解析主页面，获取guidelines-detail链接...")
                sub_links = self._get_sub_links(soup, theme.url)

                if not sub_links:
                    self.logger.warning(f"⚠️ 未找到任何子链接")
                    return []

                sub_links = self._filter_sub_links_by_cancer(sub_links, cancer_filter)
                self.logger.info(f"📊 癌种筛选后剩余 {len(sub_links)} 个指南子页面")

                # 遍历每个子链接，获取PDF链接
                pdf_links = []
                for i, sub_info in enumerate(sub_links, 1):
                    sub_url = sub_info['url']
                    sub_title = sub_info.get('title', f"指南_{i}")
                    self.logger.info(f"📄 [{i}/{len(sub_links)}] 正在处理: {sub_title}")

                    # 获取子页面的PDF链接
                    sub_pdf_links = self._get_pdfs_from_detail_page(sub_url, sub_title, language_filter, theme)
                    pdf_links.extend(sub_pdf_links)

                    self.logger.info(f"📈 当前累计PDF数量: {len(pdf_links)}")

                    # 请求间隔
                    if i < len(sub_links):
                        time.sleep(random.uniform(*self.request_delay))

            pdf_links = self._filter_pdf_links_by_language(pdf_links, language_filter)
            pdf_links = self._filter_pdf_links_by_cancer(pdf_links, cancer_filter)

            self.logger.info(f"🎯 解析完成，总共找到 {len(pdf_links)} 个PDF文件")
            return pdf_links

        except requests.exceptions.Timeout:
            self.logger.error(f"⏰ 请求超时: {theme.url}")
            return []
        except requests.exceptions.ConnectionError:
            self.logger.error(f"🔌 连接错误: {theme.url}")
            return []
        except Exception as e:
            self.logger.error(f"❌ 获取PDF链接失败: {str(e)}")
            import traceback
            self.logger.error(f"详细错误: {traceback.format_exc()}")
            return []

    def _get_sub_links_patient_guidelines(self, soup: BeautifulSoup, base_url: str) -> List[str]:
        """获取患者指南页面的guidelines-detail链接

        Args:
            soup: BeautifulSoup对象
            base_url: 基础URL

        Returns:
            List[str]: 患者指南详情页链接URL列表
        """
        sub_links = []

        try:
            # 查找所有包含guidelines-for-patients-details的链接
            all_links = soup.find_all('a', href=True)
            guidelines_links = [link for link in all_links if '/guidelines-for-patients-details?' in link.get('href', '')]

            for link in guidelines_links:
                href = link['href']
                full_url = urljoin(base_url, href)
                if full_url not in sub_links:
                    sub_links.append(full_url)
                    self.logger.debug(f"找到患者指南链接: {full_url}")

            return sub_links

        except Exception as e:
            self.logger.error(f"获取患者指南子链接失败: {str(e)}")
            return []

    def _get_sub_links(self, soup: BeautifulSoup, base_url: str) -> List[Dict[str, str]]:
        """获取所有guidelines-detail子链接及其标题

        Args:
            soup: BeautifulSoup对象
            base_url: 基础URL

        Returns:
            List[Dict[str, str]]: 子链接信息列表，每项包含 'url' 和 'title'
        """
        sub_links = []
        seen_urls = set()

        try:
            # 查找guideline-items区域
            guideline_items = soup.find('div', class_='guideline-items')
            if guideline_items:
                # 查找所有item-name下的链接
                for item in guideline_items.find_all('div', class_='item-name'):
                    link = item.find('a')
                    if link and link.get('href'):
                        href = link['href']
                        if '/guidelines/guidelines-detail' in href:
                            full_url = urljoin(base_url, href)
                            title = link.get_text(' ', strip=True)
                            if full_url not in seen_urls:
                                seen_urls.add(full_url)
                                sub_links.append({'url': full_url, 'title': title})
                                self.logger.debug(f"找到指南链接: {title} - {full_url}")

            if not sub_links:
                # 备用策略：直接查找所有包含guidelines-detail的链接
                all_links = soup.find_all('a', href=True)
                guidelines_links = [link for link in all_links if '/guidelines/guidelines-detail' in link.get('href', '')]

                for link in guidelines_links:
                    href = link['href']
                    full_url = urljoin(base_url, href)
                    if full_url not in seen_urls:
                        seen_urls.add(full_url)
                        title = link.get_text(' ', strip=True)
                        sub_links.append({'url': full_url, 'title': title})

            return sub_links

        except Exception as e:
            self.logger.error(f"获取子链接失败: {str(e)}")
            return []

    def _filter_sub_links_by_cancer(self, sub_links: List[Dict[str, str]], cancer_filter: Any) -> List[Dict[str, str]]:
        """在访问详情页前按癌种关键词过滤子链接，减少请求量。"""
        keywords = self._normalize_cancer_filter(cancer_filter)
        if not keywords:
            return sub_links

        filtered_links = []
        for sub_info in sub_links:
            title = sub_info.get('title', '')
            url = sub_info.get('url', '')
            pdf_info = {'title': title, 'url': url, 'source_page': url}
            if self._matches_cancer_filter(pdf_info, cancer_filter):
                filtered_links.append(sub_info)
        return filtered_links

    def _get_cancer_type_cache_path(self) -> Path:
        """获取癌种列表缓存路径。"""
        cache_dir = self.base_download_dir / '.cache'
        cache_dir.mkdir(exist_ok=True)
        return cache_dir / 'cancer_types.json'

    def _load_cached_cancer_types(self, max_age_days: int = 7) -> List[str]:
        """读取未过期的癌种缓存。"""
        cache_path = self._get_cancer_type_cache_path()
        if not cache_path.exists():
            return []
        try:
            with open(cache_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            updated_at = float(data.get('updated_at', 0))
            age_days = (time.time() - updated_at) / 86400
            if age_days <= max_age_days:
                return data.get('items', [])
        except Exception as e:
            self.logger.debug(f"读取癌种缓存失败: {e}")
        return []

    def _save_cached_cancer_types(self, items: List[str]):
        """保存癌种缓存。"""
        cache_path = self._get_cancer_type_cache_path()
        try:
            with open(cache_path, 'w', encoding='utf-8') as f:
                json.dump({
                    'updated_at': time.time(),
                    'items': items
                }, f, ensure_ascii=False, indent=2)
        except Exception as e:
            self.logger.debug(f"保存癌种缓存失败: {e}")

    def _discover_cancer_types_from_page(self, theme: ThemeConfig = None, refresh: bool = False) -> List[str]:
        """从 NCCN 分类页发现癌种列表。"""
        theme = theme or self.THEMES['1']
        cached_items = [] if refresh else self._load_cached_cancer_types()
        if cached_items:
            return cached_items

        try:
            self.logger.info(f"🔍 从NCCN分类页发现癌种列表: {theme.url}")
            response = self.session.get(theme.url, timeout=self.timeout)
            response.raise_for_status()
            soup = BeautifulSoup(response.content, 'html.parser')
            sub_links = self._get_sub_links(soup, theme.url)
            items = []
            for sub_info in sub_links:
                title = sub_info.get('title', '').strip()
                if title and title not in items:
                    items.append(title)
            if items:
                self._save_cached_cancer_types(items)
                return items
        except Exception as e:
            self.logger.warning(f"动态获取癌种列表失败，使用内置列表: {e}")

        return list(self.CANCER_TYPE_FILTERS.keys())

    def _parse_category_1(self, soup: BeautifulSoup) -> List[Dict[str, Any]]:
        """解析癌症治疗指南页面"""
        pdf_links = []

        # 查找guideline-items区域
        guideline_items = soup.find('div', class_='guideline-items')
        if guideline_items:
            # 查找所有item-name下的链接
            for item in guideline_items.find_all('div', class_='item-name'):
                link = item.find('a')
                if link and link.get('href'):
                    href = link['href']
                    if '/guidelines/guidelines-detail' in href:
                        # 获取子页面的PDF
                        full_url = urljoin('https://www.nccn.org', href)
                        title = link.text.strip()

                        self.logger.debug(f"找到指南页面: {title} - {full_url}")

                        # 获取子页面的PDF链接
                        sub_pdf_links = self._get_pdfs_from_detail_page(full_url, title, 'all', None)
                        pdf_links.extend(sub_pdf_links)

        return pdf_links

    def _parse_category_3(self, soup: BeautifulSoup) -> List[Dict[str, Any]]:
        """解析支持性护理指南页面"""
        return self._parse_category_1(soup)  # 使用相同的解析逻辑

    def _parse_patient_resources(self, soup: BeautifulSoup) -> List[Dict[str, Any]]:
        """解析患者资源页面"""
        pdf_links = []

        # 查找所有PDF链接
        for link in soup.find_all('a', href=True):
            href = link['href']
            if href.endswith('.pdf'):
                pdf_url = urljoin('https://www.nccn.org', href)
                title = link.text.strip()
                if not title:
                    title = href.split('/')[-1].split('.')[0]

                pdf_links.append({
                    'title': title,
                    'url': pdf_url,
                    'version': 'Latest'
                })

        return pdf_links

    def _parse_translations(self, soup: BeautifulSoup, theme: ThemeConfig, language_filter: str = 'all') -> List[Dict[str, Any]]:
        """解析翻译指南页面 - 专门提取Chinese Translations部分的PDF链接"""
        pdf_links = []

        self.logger.info(f"🔍 开始解析翻译页面PDF链接...")
        self.logger.info(f"🌐 语言过滤: {language_filter}")
        self.logger.info(f"🎯 目标: 专门提取Chinese Translations部分的PDF链接")

        # 查找Chinese Translations部分
        chinese_section = None
        chinese_headings = soup.find_all(['h1', 'h2', 'h3', 'h4'], string=lambda text: text and 'Chinese' in text and 'Translation' in text)

        if not chinese_headings:
            chinese_headings = soup.find_all(['h1', 'h2', 'h3', 'h4'], string=lambda text: text and 'Chinese' in text)

        for heading in chinese_headings:
            self.logger.info(f"🔍 找到标题: {heading.get_text().strip()}")

            # 查找标题后的pdfList
            current = heading.next_sibling
            while current:
                if hasattr(current, 'name') and current.name == 'ul' and 'pdfList' in current.get('class', []):
                    chinese_section = current
                    self.logger.info(f"✅ 找到Chinese PDF列表")
                    break
                elif hasattr(current, 'name') and current.name in ['h1', 'h2', 'h3', 'h4']:
                    # 遇到下一个标题，停止搜索
                    break
                current = current.next_sibling

            if chinese_section:
                break

        if not chinese_section:
            self.logger.warning(f"⚠️ 未找到Chinese Translations部分，尝试备用方法")
            # 备用方法：直接查找包含'chinese'的PDF链接
            all_links = soup.find_all('a', href=True)
            for link in all_links:
                href = link.get('href', '').lower()
                if 'chinese' in href and href.endswith('.pdf'):
                    self.logger.info(f"🔄 使用备用方法找到中文PDF: {href}")
                    chinese_section = link.find_parent('ul', class_='pdfList')
                    if chinese_section:
                        break

        if not chinese_section:
            self.logger.error(f"❌ 无法找到Chinese Translations部分的PDF列表")
            return []

        # 从Chinese Translations部分提取PDF链接
        pdf_count = 0
        links = chinese_section.find_all('a', href=True)

        for link in links:
            href = link.get('href', '')
            if href.endswith('.pdf'):
                # 对于Chinese Translations部分，非中文筛选直接跳过
                if language_filter in ['english', 'other']:
                    continue

                pdf_count += 1

                # 正确拼接URL - 使用NCCN根域名
                if href.startswith('http'):
                    pdf_url = href
                else:
                    base_url = 'https://www.nccn.org'
                    if href.startswith('/'):
                        pdf_url = base_url + href
                    else:
                        pdf_url = urljoin(base_url, href)

                title = link.text.strip()
                if not title:
                    title = href.split('/')[-1].split('.')[0]

                # 提取版本信息（如果存在）
                version_span = link.find_next('span', string=lambda text: text and 'Version' in text)
                version = version_span.get_text().strip() if version_span else 'Latest'

                pdf_links.append({
                    'title': title,
                    'url': pdf_url,
                    'version': 'Chinese',
                    'directory': theme.directory
                })

                if pdf_count <= 5:  # 只显示前5个
                    self.logger.info(f"📄 找到中文PDF: {title} (v: {version}) -> {pdf_url[:60]}...")

        self.logger.info(f"✅ Chinese Translations解析完成，共找到 {pdf_count} 个中文PDF链接")
        return pdf_links

    def _parse_patient_guidelines_bilingual(self, soup: BeautifulSoup, theme: ThemeConfig, language_filter: str = 'all') -> List[Dict[str, Any]]:
        """解析双语患者指南页面 - 优化解析流程"""
        pdf_links = []
        self.logger.info(f"🔍 开始双语患者指南解析...")
        self.logger.info(f"🌐 语言过滤: {language_filter}")

        try:
            # 优化分支：根据语言过滤选择解析策略
            if language_filter == 'chinese':
                self.logger.info(f"🎯 选择'仅中文版本'，直接访问翻译页面优化解析...")
                return self._parse_translation_page_directly()
            elif language_filter == 'english':
                self.logger.info(f"🎯 选择'仅英文版本'，跳过翻译页面解析...")
            else:
                self.logger.info(f"🎯 选择'全部版本'，执行完整三步骤解析...")

            # 步骤1: 从主页面提取详情页链接
            self.logger.info(f"📋 步骤1: 从主页面提取患者指南详情页链接...")
            all_links = soup.find_all('a', href=True)
            detail_links = []

            for link in all_links:
                href = link.get('href', '')
                text = link.get_text(strip=True)

                # 查找详情页链接格式: /guidelines-for-patients-details?patientGuidelineId=X
                if '/guidelines-for-patients-details?patientGuidelineId=' in href:
                    # 正确拼接URL
                    if href.startswith('http'):
                        detail_url = href
                    else:
                        detail_url = 'https://www.nccn.org' + href

                    detail_links.append({
                        'url': detail_url,
                        'text': text
                    })

            self.logger.info(f"✅ 步骤1完成，找到 {len(detail_links)} 个患者指南详情页")

            # 步骤1.5: 查找翻译页面链接（用于获取中文PDF）
            self.logger.info(f"📋 步骤1.5: 查找翻译页面链接获取中文版本...")
            translation_links = []
            for link in all_links:
                href = link.get('href', '')
                text = link.get_text(strip=True)

                # 查找指向翻译页面的链接
                if 'translations' in href.lower() or ('translations' in text.lower()):
                    # 正确拼接URL
                    if href.startswith('http'):
                        translation_url = href
                    else:
                        translation_url = 'https://www.nccn.org' + href

                    translation_links.append({
                        'url': translation_url,
                        'text': text
                    })

            self.logger.info(f"✅ 找到 {len(translation_links)} 个翻译页面链接")

            if not detail_links:
                self.logger.warning("未找到患者指南详情页链接")
                return []

            # 步骤2: 遍历详情页提取PDF链接
            self.logger.info(f"📋 步骤2: 遍历详情页提取PDF链接...")
            max_pages = min(len(detail_links), 10)  # 限制最大处理页面数避免超时

            for i, detail in enumerate(detail_links[:max_pages]):
                try:
                    self.logger.info(f"📄 [{i+1}/{max_pages}] 处理详情页: {detail['text']}")

                    response = self.session.get(detail['url'], timeout=self.timeout)
                    if response.status_code != 200:
                        self.logger.warning(f"无法访问详情页: {detail['url']}")
                        continue

                    detail_soup = BeautifulSoup(response.content, 'html.parser')
                    detail_links_page = detail_soup.find_all('a', href=True)

                    for link in detail_links_page:
                        href = link.get('href', '')
                        link_text = link.get_text(strip=True)

                        # 查找PDF链接
                        if '/patients/guidelines/content/PDF/' in href and href.endswith('.pdf'):
                            # 应用语言过滤
                            if not self._should_include_pdf(href, language_filter, link_text):
                                continue

                            # 正确拼接URL
                            if href.startswith('http'):
                                pdf_url = href
                            else:
                                pdf_url = 'https://www.nccn.org' + href

                            # 确定标题
                            title = link_text if link_text else detail['text']

                            # 确定版本语言
                            version = self._detect_pdf_language(href, link_text)

                            pdf_info = {
                                'title': title,
                                'url': pdf_url,
                                'version': version
                            }

                            pdf_links.append(pdf_info)

                            self.logger.info(f"📄 详情页PDF: {title} ({version}) -> {pdf_url[:80]}...")

                except Exception as e:
                    self.logger.warning(f"处理详情页失败 {detail['text']}: {str(e)}")
                    continue

            # 步骤3: 解析翻译页面获取中文PDF
            if translation_links and language_filter in ['all', 'chinese']:
                self.logger.info(f"📋 步骤3: 解析翻译页面获取中文PDF...")
                self.logger.info(f"🌐 将访问 {len(translation_links)} 个翻译页面")

                for i, translation in enumerate(translation_links):
                    try:
                        self.logger.info(f"🌐 [{i+1}/{len(translation_links)}] 访问翻译页面: {translation['text']}")
                        self.logger.info(f"🔗 URL: {translation['url']}")

                        response = self.session.get(translation['url'], timeout=self.timeout)
                        if response.status_code != 200:
                            self.logger.warning(f"无法访问翻译页面: {translation['url']}")
                            continue

                        translation_soup = BeautifulSoup(response.content, 'html.parser')

                        # 使用调试脚本中验证过的正确方法：专门查找Chinese Translations部分
                        self.logger.info(f"🔍 查找Chinese Translations部分...")
                        chinese_headers = translation_soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

                        chinese_section = None
                        for header in chinese_headers:
                            if 'Chinese' in header.get_text():
                                chinese_section = header
                                self.logger.info(f"✅ 找到Chinese Translations部分: {header.get_text(strip=True)}")
                                break

                        translation_pdfs = 0

                        if chinese_section:
                            # 从Chinese Translations部分开始查找PDF链接
                            current = chinese_section
                            processed_sections = 0

                            # 遍历Chinese Translations后面的所有元素，直到下一个语言标题
                            while current and processed_sections < 50:
                                current = current.find_next_sibling()

                                if current is None:
                                    break

                                if current.name in ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']:  # 遇到下一个语言部分，停止
                                    break

                                # 查找当前元素中的所有链接
                                links = current.find_all('a', href=True)

                                for link in links:
                                    href = link.get('href', '')
                                    link_text = link.get_text(strip=True)

                                    # 查找PDF链接
                                    if '/patients/guidelines/content/PDF/' in href and href.endswith('.pdf'):
                                        # 应用语言过滤
                                        if not self._should_include_pdf(href, language_filter, link_text):
                                            continue

                                        # 正确拼接URL
                                        if href.startswith('http'):
                                            pdf_url = href
                                        else:
                                            pdf_url = 'https://www.nccn.org' + href

                                        # 确定标题
                                        title = link_text if link_text else 'Chinese Patient Guideline'
                                        if not title:
                                            filename = href.split('/')[-1].replace('.pdf', '')
                                            title = filename.replace('-zh', '').replace('-', ' ') + ' (Chinese)'

                                        # 使用修复后的语言检测
                                        detected_version = self._detect_pdf_language(href, link_text)
                                        if detected_version != 'Chinese':
                                            continue  # 跳过非中文PDF

                                        pdf_info = {
                                            'title': title,
                                            'url': pdf_url,
                                            'version': 'Chinese'
                                        }

                                        # 避免重复添加
                                        existing_urls = [p['url'] for p in pdf_links]
                                        if pdf_url not in existing_urls:
                                            pdf_links.append(pdf_info)
                                            translation_pdfs += 1

                                            self.logger.info(f"🇨🇳 翻译页PDF: {title} -> {pdf_url[:80]}...")

                                processed_sections += 1

                            self.logger.info(f"✅ 从Chinese Translations部分解析完成，找到 {translation_pdfs} 个中文PDF")
                        else:
                            # 备用方法：如果找不到Chinese Translations部分，使用全页面搜索
                            self.logger.info(f"⚠️  未找到Chinese Translations部分，使用备用搜索方法...")
                            translation_links_page = translation_soup.find_all('a', href=True)

                            for link in translation_links_page:
                                href = link.get('href', '')
                                link_text = link.get_text(strip=True)

                                # 查找PDF链接
                                if '/patients/guidelines/content/PDF/' in href and href.endswith('.pdf'):
                                    # 应用语言过滤
                                    if not self._should_include_pdf(href, language_filter, link_text):
                                        continue

                                    # 正确拼接URL
                                    if href.startswith('http'):
                                        pdf_url = href
                                    else:
                                        pdf_url = 'https://www.nccn.org' + href

                                    # 确定标题
                                    title = link_text if link_text else 'Chinese Patient Guideline'
                                    if not title:
                                        filename = href.split('/')[-1].replace('.pdf', '')
                                        title = filename.replace('-zh', '').replace('-', ' ') + ' (Chinese)'

                                    # 使用修复后的语言检测
                                    detected_version = self._detect_pdf_language(href, link_text)
                                    if detected_version != 'Chinese':
                                        continue  # 跳过非中文PDF

                                    pdf_info = {
                                        'title': title,
                                        'url': pdf_url,
                                        'version': 'Chinese'
                                    }

                                    # 避免重复添加
                                    existing_urls = [p['url'] for p in pdf_links]
                                    if pdf_url not in existing_urls:
                                        pdf_links.append(pdf_info)
                                        translation_pdfs += 1

                                        self.logger.info(f"🇨🇳 翻译页PDF: {title} -> {pdf_url[:80]}...")

                        self.logger.info(f"✅ 翻译页面 {translation['text']} 找到 {translation_pdfs} 个中文PDF")

                    except Exception as e:
                        self.logger.warning(f"处理翻译页面失败 {translation['text']}: {str(e)}")
                        continue

            # 最终统计
            chinese_count = sum(1 for p in pdf_links if p['version'] == 'Chinese')
            english_count = len(pdf_links) - chinese_count
            spanish_count = sum(1 for p in pdf_links if p['version'] == 'Spanish')

            self.logger.info(f"📊 最终统计:")
            self.logger.info(f"   总PDF数: {len(pdf_links)}")
            self.logger.info(f"   中文版本: {chinese_count}")
            self.logger.info(f"   英文版本: {english_count}")
            self.logger.info(f"   西班牙语版本: {spanish_count}")

            self.logger.info(f"✅ 三步骤解析完成，总共找到 {len(pdf_links)} 个PDF文件")
            return pdf_links

        except Exception as e:
            self.logger.error(f"❌ 双语患者指南解析失败: {str(e)}")
            import traceback
            self.logger.error(f"详细错误: {traceback.format_exc()}")
            return []

    def _extract_pdfs_from_main_page(self, soup: BeautifulSoup, language_filter: str = 'all') -> List[Dict[str, Any]]:
        """从主页面直接提取PDF链接的备用方法"""
        pdf_links = []

        self.logger.info(f"🔍 从主页面直接提取PDF链接...")
        all_links = soup.find_all('a', href=True)

        for link in all_links:
            href = link.get('href', '')

            # 查找患者指南PDF链接
            if href.endswith('.pdf') and '/patients/guidelines/content/PDF/' in href:
                # 应用语言过滤
                if not self._should_include_pdf(href, language_filter):
                    continue

                # 正确拼接URL
                if href.startswith('http'):
                    pdf_url = href
                else:
                    base_url = 'https://www.nccn.org'
                    if href.startswith('/'):
                        pdf_url = base_url + href
                    else:
                        pdf_url = urljoin(base_url, href)

                title = link.text.strip()
                if not title:
                    filename = href.split('/')[-1].replace('.pdf', '')
                    if filename.endswith('-zh'):
                        title = filename[:-3].replace('-', ' ') + ' (Chinese)'
                    else:
                        title = filename.replace('-', ' ')

                # 确定版本语言
                version = 'Chinese' if '-zh' in href.lower() or 'chinese' in href.lower() else 'English'

                pdf_info = {
                    'title': title,
                    'url': pdf_url,
                    'version': version
                }

                pdf_links.append(pdf_info)

                if len(pdf_links) <= 5:
                    self.logger.info(f"📄 直接找到PDF: {title} ({version}) -> {pdf_url[:60]}...")

        self.logger.info(f"✅ 主页面直接解析完成，找到 {len(pdf_links)} 个PDF文件")
        return pdf_links

    def _extract_pdfs_from_patient_detail_page_simple(self, soup: BeautifulSoup, guideline_title: str, language_filter: str = 'all') -> List[Dict[str, Any]]:
        """从患者指南详情页提取PDF链接 - 简化版本"""
        pdf_links = []

        try:
            # 查找患者指南PDF链接
            all_links = soup.find_all('a', href=True)

            for link in all_links:
                href = link.get('href', '')

                # 查找患者指南PDF链接
                if href.endswith('.pdf') and '/patients/guidelines/content/PDF/' in href:
                    # 应用语言过滤
                    if not self._should_include_pdf(href, language_filter):
                        continue

                    # 正确拼接URL
                    if href.startswith('http'):
                        pdf_url = href
                    else:
                        base_url = 'https://www.nccn.org'
                        if href.startswith('/'):
                            pdf_url = base_url + href
                        else:
                            pdf_url = urljoin(base_url, href)

                    title = link.text.strip()
                    if not title:
                        filename = href.split('/')[-1].replace('.pdf', '')
                        if filename.endswith('-zh'):
                            title = filename[:-3].replace('-', ' ') + ' (Chinese)'
                        else:
                            title = filename.replace('-', ' ')

                    # 确定版本语言
                    version = 'Chinese' if '-zh' in href.lower() or 'chinese' in href.lower() else 'English'

                    pdf_info = {
                        'title': title,
                        'url': pdf_url,
                        'version': version
                    }

                    pdf_links.append(pdf_info)

                    if len(pdf_links) <= 3:  # 只显示前3个
                        self.logger.info(f"📄 详情页PDF: {title} ({version}) -> {pdf_url[:60]}...")

            self.logger.info(f"📊 详情页解析: 找到 {len(pdf_links)} 个PDF文件")
            return pdf_links

        except Exception as e:
            self.logger.error(f"❌ 从患者指南详情页提取PDF失败: {str(e)}")
            return []

    def _parse_translation_page_directly(self) -> List[Dict[str, Any]]:
        """直接解析翻译页面获取中文PDF - 优化版本"""
        pdf_links = []

        try:
            # 直接访问翻译页面
            translation_url = "https://www.nccn.org/global/what-we-do/guidelines-for-patients-translations"
            self.logger.info(f"🌐 直接访问翻译页面: {translation_url}")

            response = self.session.get(translation_url, timeout=self.timeout)
            if response.status_code != 200:
                self.logger.warning(f"无法访问翻译页面: {translation_url}")
                return []

            translation_soup = BeautifulSoup(response.content, 'html.parser')

            # 查找Chinese Translations部分
            self.logger.info(f"🔍 查找Chinese Translations部分...")
            chinese_headers = translation_soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

            chinese_section = None
            for header in chinese_headers:
                if 'Chinese' in header.get_text():
                    chinese_section = header
                    self.logger.info(f"✅ 找到Chinese Translations部分: {header.get_text(strip=True)}")
                    break

            if not chinese_section:
                self.logger.warning("未找到Chinese Translations部分")
                return []

            # 从Chinese Translations部分开始查找PDF链接
            current = chinese_section
            processed_sections = 0

            # 遍历Chinese Translations后面的所有元素，直到下一个语言标题
            while current and processed_sections < 50:
                current = current.find_next_sibling()

                if current is None:
                    break

                if current.name in ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']:  # 遇到下一个语言部分，停止
                    self.logger.info(f"🛑 遇到下一个语言部分: {current.get_text(strip=True)[:50]}...")
                    break

                # 查找当前元素中的所有链接
                links = current.find_all('a', href=True)

                for link in links:
                    href = link.get('href', '')
                    link_text = link.get_text(strip=True)

                    # 查找PDF链接
                    if '/patients/guidelines/content/PDF/' in href and href.endswith('.pdf'):
                        # 正确拼接URL
                        if href.startswith('http'):
                            pdf_url = href
                        else:
                            pdf_url = 'https://www.nccn.org' + href

                        # 确定标题
                        title = link_text if link_text else 'Chinese Patient Guideline'
                        if not title:
                            filename = href.split('/')[-1].replace('.pdf', '')
                            title = filename.replace('-zh', '').replace('-', ' ') + ' (Chinese)'

                        pdf_info = {
                            'title': title,
                            'url': pdf_url,
                            'version': 'Chinese'
                        }

                        # 避免重复添加
                        existing_urls = [p['url'] for p in pdf_links]
                        if pdf_url not in existing_urls:
                            pdf_links.append(pdf_info)
                            self.logger.info(f"🇨🇳 翻译页PDF: {title} -> {pdf_url[:80]}...")

                processed_sections += 1

            self.logger.info(f"✅ 直接解析翻译页面完成，找到 {len(pdf_links)} 个中文PDF")
            return pdf_links

        except Exception as e:
            self.logger.error(f"❌ 直接解析翻译页面失败: {str(e)}")
            import traceback
            self.logger.error(f"详细错误: {traceback.format_exc()}")
            return []

    def _parse_patient_guidelines_chinese(self, soup: BeautifulSoup, theme: ThemeConfig) -> List[Dict[str, Any]]:
        """解析患者指南中文版本 - 直接访问翻译页面"""
        try:
            # 直接调用现有的翻译页面解析方法
            self.logger.info(f"🎯 患者指南中文版本：直接访问翻译页面获取中文PDF")
            pdf_links = self._parse_translation_page_directly()

            self.logger.info(f"✅ 患者指南中文版本解析完成，总共找到 {len(pdf_links)} 个中文PDF")
            return pdf_links

        except Exception as e:
            self.logger.error(f"❌ 解析患者指南中文版本失败: {str(e)}")
            import traceback
            self.logger.error(f"详细错误: {traceback.format_exc()}")
            return []

    def _parse_patient_guidelines_english(self, soup: BeautifulSoup, theme: ThemeConfig, language_filter: str = 'all') -> List[Dict[str, Any]]:
        """解析患者指南英文版本 - 双步骤解析，只提取英文PDF"""
        try:
            self.logger.info(f"🎯 患者指南英文版本：开始双步骤解析流程")

            # 步骤1: 获取所有guidelines-detail链接
            self.logger.info(f"🔍 步骤1: 获取guidelines-detail链接...")
            sub_links = self._get_sub_links_patient_guidelines(soup, theme.url)

            if not sub_links:
                self.logger.warning(f"⚠️ 未找到任何患者指南详情页链接")
                return []

            self.logger.info(f"📊 找到 {len(sub_links)} 个患者指南详情页")

            # 步骤2: 遍历每个详情页，只提取英文PDF
            pdf_links = []
            for i, sub_url in enumerate(sub_links, 1):
                self.logger.info(f"📄 [{i}/{len(sub_links)}] 处理详情页: {sub_url.split('?')[0].split('/')[-1]}")

                try:
                    response = self.session.get(sub_url, timeout=self.timeout)
                    if response.status_code != 200:
                        self.logger.warning(f"无法访问详情页: {sub_url}")
                        continue

                    sub_soup = BeautifulSoup(response.content, 'html.parser')

                    # 查找PDF链接
                    for link in sub_soup.find_all('a', href=True):
                        href = link.get('href', '')
                        link_text = link.get_text(strip=True)

                        # 只处理PDF链接
                        if '/patients/guidelines/content/PDF/' in href and href.endswith('.pdf'):
                            # 正确拼接URL
                            if href.startswith('http'):
                                pdf_url = href
                            else:
                                pdf_url = 'https://www.nccn.org' + href

                            # 检测语言，只保留英文版本
                            detected_language = self._detect_pdf_language(pdf_url, link_text)

                            if detected_language in ['English', 'Unknown']:
                                # 确定标题
                                title = link_text if link_text else 'Patient Guideline'
                                if not title or title == 'Patient Guideline':
                                    filename = href.split('/')[-1].replace('.pdf', '')
                                    title = filename.replace('-patient', '').replace('-', ' ').title() + ' (English)'

                                # 避免重复添加
                                existing_urls = [p['url'] for p in pdf_links]
                                if pdf_url not in existing_urls:
                                    pdf_info = {
                                        'title': title,
                                        'url': pdf_url,
                                        'version': detected_language,
                                        'source_page': sub_url
                                    }
                                    pdf_links.append(pdf_info)
                                    self.logger.info(f"📄 英文PDF: {title} -> {pdf_url[:80]}...")

                    # 添加延迟避免过于频繁的请求
                    time.sleep(random.uniform(1, 3))

                except Exception as e:
                    self.logger.error(f"处理详情页失败 {sub_url}: {str(e)}")
                    continue

            self.logger.info(f"✅ 患者指南英文版本解析完成，总共找到 {len(pdf_links)} 个英文PDF")
            return pdf_links

        except Exception as e:
            self.logger.error(f"❌ 解析患者指南英文版本失败: {str(e)}")
            import traceback
            self.logger.error(f"详细错误: {traceback.format_exc()}")
            return []

    @staticmethod
    def _is_url_allowed(url: str) -> bool:
        """校验 URL 域名是否在白名单内。"""
        try:
            netloc = urlparse(url).netloc.lower()
            hostname = netloc.split(':')[0]
            return any(hostname == d or hostname.endswith('.' + d)
                       for d in NCCNDownloaderV2.ALLOWED_DOWNLOAD_DOMAINS)
        except Exception:
            return False

    @staticmethod
    def _contains_cjk(text: str) -> bool:
        """判断字符串中是否含有 CJK（中日韩）统一表意文字。

        覆盖常用中日韩汉字区间，用于识别以中文标题命名的翻译版 PDF。
        """
        if not text:
            return False
        for ch in text:
            code = ord(ch)
            # CJK 统一表意文字（基本区 + 扩展A）+ 日文假名 + 韩文谚文
            if (0x4E00 <= code <= 0x9FFF      # CJK 基本区
                    or 0x3400 <= code <= 0x4DBF  # CJK 扩展 A
                    or 0x3040 <= code <= 0x30FF  # 平假名 + 片假名
                    or 0xAC00 <= code <= 0xD7AF  # 韩文谚文音节
                    or 0xFF00 <= code <= 0xFFEF):  # 全角字符
                return True
        return False

    def _detect_pdf_language(self, pdf_url: str, link_text: str = "") -> str:
        """检测PDF的语言版本"""
        url_lower = pdf_url.lower()
        text_lower = link_text.lower()

        # 优先检查 CJK 字符：链接文本或 URL 中含中文/日文/韩文字符
        if self._contains_cjk(link_text) or self._contains_cjk(pdf_url):
            return 'Chinese'

        # 检查URL中是否包含中文标识（使用更精确的匹配，避免误判）
        if any(indicator in url_lower for indicator in ['-zh', '-chinese']):
            return 'Chinese'
        elif any(indicator in url_lower for indicator in ['-chi']) and 'children' not in url_lower:
            return 'Chinese'
        elif any(indicator in url_lower for indicator in ['-ch(', '-ch)']):
            return 'Chinese'
        elif 'chinese' in text_lower:
            return 'Chinese'
        # 检查西班牙语标识（优先检查，避免中文误判）
        elif any(indicator in url_lower for indicator in ['-es', '-esl', '-es_', '-spanish']):
            return 'Spanish'
        elif 'spanish' in text_lower:
            return 'Spanish'
        # 检查其他语言标识
        elif any(indicator in url_lower for indicator in ['-ar', '-arabic', 'arabic']):
            return 'Arabic'
        elif any(indicator in url_lower for indicator in ['-fr', '-french', 'french']):
            return 'French'
        elif any(indicator in url_lower for indicator in ['-hi', '-hindi', 'hindi']):
            return 'Hindi'
        elif any(indicator in url_lower for indicator in ['-jp', '-japanese', 'japanese']):
            return 'Japanese'
        elif any(indicator in url_lower for indicator in ['-kr', '-korean', 'korean']):
            return 'Korean'
        elif any(indicator in url_lower for indicator in ['-po', '-polish', 'polish']):
            return 'Polish'
        elif any(indicator in url_lower for indicator in ['-pt', '-portuguese', 'portuguese']):
            return 'Portuguese'
        elif any(indicator in url_lower for indicator in ['-ru', '-russian', 'russian']):
            return 'Russian'
        elif any(indicator in url_lower for indicator in ['-vi', '-vietnamese', 'vietnamese']):
            return 'Vietnamese'
        else:
            return 'English'  # 默认认为是英文

    def _should_include_pdf(self, pdf_url: str, language_filter: str, link_text: str = "") -> bool:
        """根据语言过滤规则和内容类型判断是否包含该PDF

        Args:
            pdf_url: PDF URL
            language_filter: 语言过滤选项 ('all', 'english', 'chinese')
            link_text: 链接文本（用于语言检测）

        Returns:
            bool: 是否应该包含该PDF
        """
        # 首先检查链接文本，识别文件类型
        lower_text = link_text.lower()

        # 过滤掉不需要的文件类型
        exclude_patterns = [
            'framework',  # Basic Framework, Core Framework等
            'exhibitor',  # 会议参展商手册
            'conference', # 会议相关
            'prospectus', # 招股说明书
            'user guide', # 用户指南
            'order template', # 订单模板
            'middle east', # 中东地区
            'north africa', # 北非
            'sub-saharan africa', # 撒哈拉以南非洲
            'mena', # 中东北非地区
            'arabic', # 阿拉伯语
            'hindi', # 印地语
            'portuguese', # 葡萄牙语
            'spanish', # 西班牙语 - 在任何模式下都要过滤
        ]

        for pattern in exclude_patterns:
            if pattern in lower_text:
                self.logger.debug(f"过滤掉不需要的文件类型: {link_text[:50]} (包含: {pattern})")
                return False

        # 语言过滤逻辑
        detected_language = self._detect_pdf_language(pdf_url, link_text)

        if language_filter == 'all':
            return True

        if language_filter == 'chinese':
            return detected_language == 'Chinese'
        elif language_filter == 'english':
            # 只保留英文版本，并且必须是核心指南文件
            if detected_language == 'English':
                # 进一步过滤：确保是NCCN Guidelines或者是癌症相关的英文指南
                # 检查是否是核心指南（NCCN Guidelines或者是癌症症状相关的指南）
                is_guideline = (
                    'guidelines' in lower_text or
                    'nausea and vomiting' in lower_text or
                    'blood clots' in lower_text or
                    'fatigue' in lower_text or
                    'distress' in lower_text or
                    'pain' in lower_text or
                    'anemia' in lower_text or
                    'neutropenia' in lower_text or
                    'immunotherapy' in lower_text or
                    'palliative care' in lower_text
                )

                if is_guideline:
                    return True
                else:
                    self.logger.debug(f"过滤掉非核心英文文件: {link_text[:50]}")
                    return False
            else:
                return False
        elif language_filter == 'other':
            return detected_language not in ['English', 'Chinese']
        else:
            return True

    def _get_pdfs_from_detail_page(self, detail_url: str, guideline_title: str, language_filter: str = 'all', theme=None) -> List[Dict[str, Any]]:
        """从指南详情页面获取PDF链接

        Args:
            detail_url: 详情页面URL
            guideline_title: 指南标题
            language_filter: 语言过滤选项 ('all', 'english', 'chinese')
            theme: 主题配置（可选，用于控制提取方式）

        Returns:
            List[Dict]: PDF信息列表
        """
        try:
            self.logger.info(f"🔍 请求详情页面: {detail_url}")
            response = self.session.get(detail_url, timeout=self.timeout)
            response.raise_for_status()

            self.logger.info(f"✅ 详情页面请求成功，状态码: {response.status_code}")
            soup = BeautifulSoup(response.content, 'html.parser')

            pdf_links = []
            self.logger.info(f"🔍 开始解析详情页面PDF链接...")

            # 根据主题类型选择提取方法
            if theme and getattr(theme, 'guidelines_only', False):
                self.logger.info(f"🎯 使用Guidelines-only提取模式")
                pdf_links = self._extract_guidelines_only(soup, language_filter)
                return pdf_links

            # 方法1: 查找所有直接PDF链接
            all_links = soup.find_all('a', href=True)
            pdf_direct_links = []

            for link in all_links:
                href = link.get('href', '')
                if href.endswith('.pdf'):
                    # 应用语言过滤
                    link_text = link.text.strip()
                    if not self._should_include_pdf(href, language_filter, link_text):
                        continue

                    # 正确拼接URL - 使用NCCN根域名
                    if href.startswith('http'):
                        pdf_url = href
                    else:
                        # 修复URL拼接问题：使用NCCN根域名作为基础
                        base_url = 'https://www.nccn.org'
                        if href.startswith('/'):
                            pdf_url = base_url + href
                        else:
                            pdf_url = urljoin(base_url, href)

                    title = link_text if link_text else guideline_title

                    # 确定版本语言
                    version = self._detect_pdf_language(href, link_text)

                    pdf_direct_links.append({
                        'title': title,
                        'url': pdf_url,
                        'version': version
                    })

                    self.logger.info(f"📄 找到直接PDF链接: {title[:50]} ({version})...")
                    self.logger.debug(f"🔗 PDF URL: {pdf_url}")

            self.logger.info(f"📊 方法1找到 {len(pdf_direct_links)} 个直接PDF链接")

            # 方法2: 查找pdfList类的链接
            pdf_lists = soup.find_all('ul', class_='pdfList')
            pdf_list_links = []

            for pdf_list in pdf_lists:
                self.logger.info(f"📋 找到pdfList区域，包含 {len(pdf_list.find_all('a', href=True))} 个链接")

                for link in pdf_list.find_all('a', href=True):
                    href = link.get('href', '')
                    if href.endswith('.pdf'):
                        # 应用语言过滤
                        link_text = link.text.strip()
                        if not self._should_include_pdf(href, language_filter, link_text):
                            continue

                        # 正确拼接URL - 使用NCCN根域名
                        if href.startswith('http'):
                            pdf_url = href
                        else:
                            # 修复URL拼接问题：使用NCCN根域名作为基础
                            base_url = 'https://www.nccn.org'
                            if href.startswith('/'):
                                pdf_url = base_url + href
                            else:
                                pdf_url = urljoin(base_url, href)

                        title = link_text if link_text else guideline_title

                        # 确定版本语言
                        version = self._detect_pdf_language(href, link_text)

                        pdf_list_links.append({
                            'title': title,
                            'url': pdf_url,
                            'version': version
                        })

                        self.logger.info(f"📄 找到pdfList PDF链接: {title[:50]} ({version})...")
                        self.logger.debug(f"🔗 PDF URL: {pdf_url}")

            self.logger.info(f"📊 方法2找到 {len(pdf_list_links)} 个pdfList PDF链接")

            # 合并结果，去重
            pdf_links = pdf_direct_links.copy()

            for link_info in pdf_list_links:
                # 检查是否已经存在相同URL
                if not any(p['url'] == link_info['url'] for p in pdf_links):
                    pdf_links.append(link_info)

            self.logger.info(f"🎯 去重后总计: {len(pdf_links)} 个PDF链接")

            # 如果仍然没有找到PDF，输出调试信息
            if not pdf_links:
                self.logger.warning(f"⚠️ 详情页面未找到PDF链接，开始调试...")
                self.logger.debug(f"页面标题: {soup.title.text if soup.title else 'N/A'}")
                self.logger.debug(f"总链接数: {len(all_links)}")

                # 查找所有包含pdf的链接（包括不完整的）
                pdf_mentioned_links = [link for link in all_links if 'pdf' in link.get('href', '').lower()]
                self.logger.debug(f"包含'pdf'的链接数: {len(pdf_mentioned_links)}")

                for i, link in enumerate(pdf_mentioned_links[:5]):  # 只显示前5个
                    self.logger.debug(f"  链接{i+1}: {link.get('href', 'N/A')}")

            return pdf_links

        except Exception as e:
            self.logger.error(f"❌ 从详情页面获取PDF失败 {detail_url}: {str(e)}")
            import traceback
            self.logger.error(f"详细错误: {traceback.format_exc()}")
            return []

    def _extract_guidelines_only(self, soup: BeautifulSoup, language_filter: str = 'all') -> List[Dict[str, Any]]:
        """专门提取"Guidelines"部分的核心指南PDF，忽略其他附加文件

        Args:
            soup: BeautifulSoup对象
            language_filter: 语言过滤选项 ('all', 'english', 'chinese')

        Returns:
            List[Dict]: 只包含核心指南的PDF信息列表
        """
        try:
            self.logger.info(f"🔍 专门提取Guidelines部分的核心指南...")

            # 查找Guidelines标题
            guidelines_headers = soup.find_all('h4', class_='GL', string='Guidelines')

            if not guidelines_headers:
                self.logger.warning("⚠️ 未找到Guidelines部分，使用传统方法")
                return self._get_pdfs_from_detail_page_fallback(soup, language_filter)

            pdf_links = []

            for header in guidelines_headers:
                self.logger.info(f"✅ 找到Guidelines部分")

                # 查找该header下的所有相邻的pdfList元素
                current_element = header.next_sibling

                while current_element:
                    if hasattr(current_element, 'name') and current_element.name == 'ul':
                        if 'pdfList' in current_element.get('class', []):
                            # 提取这个pdfList中的所有PDF
                            pdf_list_links = self._extract_pdfs_from_list(current_element, language_filter)
                            if pdf_list_links:
                                pdf_links.extend(pdf_list_links)
                                self.logger.info(f"📋 Guidelines部分找到 {len(pdf_list_links)} 个核心PDF")

                    # 如果遇到下一个标题，停止查找
                    if hasattr(current_element, 'name') and current_element.name == 'h4':
                        break

                    current_element = current_element.next_sibling

                    # 安全检查：防止无限循环
                    if current_element is None:
                        break

            # 去重
            unique_pdfs = []
            seen_urls = set()
            for pdf in pdf_links:
                if pdf['url'] not in seen_urls:
                    seen_urls.add(pdf['url'])
                    unique_pdfs.append(pdf)

            self.logger.info(f"🎯 Guidelines部分提取结果: {len(unique_pdfs)} 个核心PDF")
            return unique_pdfs

        except Exception as e:
            self.logger.error(f"❌ 提取Guidelines部分PDF失败: {str(e)}")
            return self._get_pdfs_from_detail_page_fallback(soup, language_filter)

    def _extract_pdfs_from_list(self, pdf_list_element, language_filter: str = 'all') -> List[Dict[str, Any]]:
        """从pdfList元素中提取PDF链接

        Args:
            pdf_list_element: pdfList的BeautifulSoup元素
            language_filter: 语言过滤选项

        Returns:
            List[Dict]: PDF信息列表
        """
        pdf_links = []

        try:
            for link in pdf_list_element.find_all('a', href=True):
                href = link.get('href', '')
                if href.endswith('.pdf'):
                    # 应用语言过滤
                    link_text = link.text.strip()
                    if not self._should_include_pdf(href, language_filter, link_text):
                        continue

                    # 构建完整的PDF URL
                    if href.startswith('http'):
                        pdf_url = href
                    else:
                        base_url = 'https://www.nccn.org'
                        if href.startswith('/'):
                            pdf_url = base_url + href
                        else:
                            pdf_url = urljoin(base_url, href)

                    # 提取版本信息
                    version_info = self._extract_version_info(link)

                    # 提取标题和文件名
                    title = link_text if link_text else "NCCN_Guideline"

                    # 增强标题信息（传递PDF URL用于提取原始文件名）
                    enhanced_info = self._enhance_pdf_info(title, version_info, pdf_url)

                    # 确定语言版本 - 优先使用传入的语言参数
                    if language_filter == 'chinese':
                        language = 'Chinese'
                    elif language_filter == 'english':
                        language = 'English'
                    else:
                        # 默认使用自动检测
                        language = self._detect_pdf_language(href, link_text)

                    pdf_links.append({
                        'title': enhanced_info['title'],
                        'url': pdf_url,
                        'version': language,
                        'original_filename': enhanced_info['filename'],
                        'enhanced_filename': enhanced_info['enhanced_filename']
                    })

                    self.logger.debug(f"✅ 提取核心PDF: {enhanced_info['title'][:50]}...")

        except Exception as e:
            self.logger.error(f"❌ 从pdfList提取PDF失败: {str(e)}")

        return pdf_links

    def _extract_version_info(self, link_element) -> str:
        """从链接元素中提取版本信息

        Args:
            link_element: 链接的BeautifulSoup元素

        Returns:
            str: 版本信息，如 "1.2026"
        """
        try:
            # 方法1：从链接文本中提取版本信息
            link_text = link_element.get_text(strip=True)

            # 查找版本模式：1.2026, Version 1.2026, 2026等
            # 匹配版本模式：数字.年份 或 年份
            version_patterns = [
                r'(?:version\s+)?(\d{1,2})\.(\d{4})',  # Version 1.2026 或 1.2026
                r'(?:v\s*)(\d{1,2})\.(\d{4})',          # v1.2026
                r'(?:(\d{4}))',                        # 2026
                r'(?:(\d{1,2})\.(\d{2}))'              # 1.26
            ]

            for pattern in version_patterns:
                match = re.search(pattern, link_text, re.IGNORECASE)
                if match:
                    groups = match.groups()
                    if len(groups) == 2:
                        return f"{groups[0]}_{groups[1]}"
                    else:
                        return groups[0]

            # 方法2：检查URL中的版本信息
            href = link_element.get('href', '')
            url_version_patterns = [
                r'(\d{4})',  # 年份
                r'(\d{1,2})\.(\d{4})'  # 数字.年份
            ]

            for pattern in url_version_patterns:
                match = re.search(pattern, href)
                if match:
                    groups = match.groups()
                    if len(groups) == 2:
                        return f"{groups[0]}_{groups[1]}"
                    else:
                        return groups[0]

            # 方法3：尝试从周围文本中查找
            parent = link_element.parent
            if parent:
                parent_text = parent.get_text(strip=True)
                for pattern in version_patterns:
                    match = re.search(pattern, parent_text, re.IGNORECASE)
                    if match:
                        groups = match.groups()
                        if len(groups) == 2:
                            return f"{groups[0]}_{groups[1]}"
                        else:
                            return groups[0]

            self.logger.debug(f"⚠️ 未找到版本信息: {link_text[:50]}")
            return "unknown"

        except Exception as e:
            self.logger.debug(f"❌ 提取版本信息失败: {str(e)}")
            return "unknown"

    def _enhance_pdf_info(self, title: str, version_info: str, pdf_url: str = None) -> Dict[str, str]:
        """增强PDF信息，添加版本信息到标题和文件名

        Args:
            title: 原始标题
            version_info: 版本信息
            pdf_url: PDF的URL（可选，用于提取原始文件名）

        Returns:
            Dict[str, str]: 增强后的信息
        """
        try:
            # 清理标题
            clean_title = title.strip()

            # 优先从PDF URL中提取文件名
            filename_prefix = None
            if pdf_url:
                try:
                    from urllib.parse import urlparse
                    parsed_url = urlparse(pdf_url)
                    path = parsed_url.path

                    # 提取文件名（不包含扩展名）
                    import os
                    filename = os.path.basename(path)
                    if filename and '.' in filename:
                        filename_prefix = os.path.splitext(filename)[0]
                        # 确保文件名安全
                        filename_prefix = re.sub(r'[^\w\-_]', '_', filename_prefix)

                        self.logger.debug(f"从URL提取文件名: {filename} -> {filename_prefix}")
                except Exception as e:
                    self.logger.debug(f"从URL提取文件名失败: {str(e)}")

            # 如果无法从URL提取，使用原来的逻辑
            if not filename_prefix:
                # 移除常见前缀
                prefixes_to_remove = [
                    'NCCN Guidelines',
                    'NCCN Guidelines for',
                    'NCCN',
                    'Guidelines',
                    'Guideline',
                    'Treatment Guidelines',
                    'Clinical Practice Guidelines'
                ]

                temp_prefix = clean_title
                for prefix in prefixes_to_remove:
                    if clean_title.lower().startswith(prefix.lower()):
                        temp_prefix = clean_title[len(prefix):].strip()
                        break

                # 进一步清理文件名
                filename_prefix = re.sub(r'\b(version|ver|v)\s*[\d\.]+\b', '', temp_prefix, flags=re.IGNORECASE)
                filename_prefix = re.sub(r'\b\d{4}\b', '', filename_prefix)  # 移除年份
                filename_prefix = re.sub(r'\s+', '_', filename_prefix.strip())  # 替换空格为下划线
                filename_prefix = re.sub(r'[^\w\-_]', '_', filename_prefix)  # 移除特殊字符

            # 确保不为空且有意义
            if not filename_prefix or len(filename_prefix) < 2:
                filename_prefix = "NCCN_Guideline"
            elif filename_prefix.lower() in ['guideline', 'guidelines', 'nccn', 'nccn_guideline']:
                filename_prefix = "NCCN_Guideline"

            # 生成增强文件名
            if version_info != "unknown":
                enhanced_filename = f"{filename_prefix}_version_{version_info}.pdf"
                enhanced_title = f"{clean_title} (Version {version_info.replace('_', '.')})"
            else:
                enhanced_filename = f"{filename_prefix}.pdf"
                enhanced_title = clean_title

            return {
                'title': enhanced_title,
                'filename': filename_prefix,
                'enhanced_filename': enhanced_filename
            }

        except Exception as e:
            self.logger.error(f"❌ 增强PDF信息失败: {str(e)}")
            return {
                'title': title,
                'filename': 'NCCN_Guideline',
                'enhanced_filename': f"NCCN_Guideline_{version_info}.pdf" if version_info != "unknown" else "NCCN_Guideline.pdf"
            }

    def _get_pdfs_from_detail_page_fallback(self, soup: BeautifulSoup, language_filter: str = 'all') -> List[Dict[str, Any]]:
        """传统方法：从详情页面获取PDF（当找不到Guidelines部分时的备用方案）"""
        try:
            self.logger.info(f"🔄 使用传统方法提取PDF（作为备用）")

            pdf_links = []

            # 查找所有PDF链接
            all_links = soup.find_all('a', href=True)

            for link in all_links:
                href = link.get('href', '')
                if href.endswith('.pdf'):
                    # 应用语言过滤
                    link_text = link.text.strip()
                    if not self._should_include_pdf(href, language_filter, link_text):
                        continue

                    # 构建完整的PDF URL
                    if href.startswith('http'):
                        pdf_url = href
                    else:
                        base_url = 'https://www.nccn.org'
                        if href.startswith('/'):
                            pdf_url = base_url + href
                        else:
                            pdf_url = urljoin(base_url, href)

                    title = link_text if link_text else "NCCN_Guideline"
                    # 确定语言版本 - 优先使用传入的语言参数
                    if language_filter == 'chinese':
                        version = 'Chinese'
                    elif language_filter == 'english':
                        version = 'English'
                    else:
                        # 默认使用自动检测
                        version = self._detect_pdf_language(href, link_text)

                    # 提取版本信息
                    version_info = self._extract_version_info(link)
                    enhanced_info = self._enhance_pdf_info(title, version_info, pdf_url)

                    pdf_links.append({
                        'title': enhanced_info['title'],
                        'url': pdf_url,
                        'version': version,
                        'original_filename': enhanced_info['filename'],
                        'enhanced_filename': enhanced_info['enhanced_filename']
                    })

            self.logger.info(f"📊 传统方法提取到 {len(pdf_links)} 个PDF")
            return pdf_links

        except Exception as e:
            self.logger.error(f"❌ 传统方法提取PDF失败: {str(e)}")
            return []

    def _download_single_pdf(self, pdf_info: Dict[str, Any], theme_dir: Path) -> bool:
        """下载单个PDF文件

        Args:
            pdf_info: PDF信息字典
            theme_dir: 目标目录

        Returns:
            bool: 下载是否成功
        """
        pdf_url = pdf_info['url']
        title = pdf_info['title']
        version = pdf_info.get('version', 'Unknown')

        # 构建文件名 - 优先使用增强的文件名
        if 'enhanced_filename' in pdf_info and pdf_info['enhanced_filename']:
            filename = pdf_info['enhanced_filename']
        else:
            # 回退到原始文件名生成逻辑
            safe_title = re.sub(r'[<>:"/\\|?*]', '_', title)
            filename = f"{safe_title}_{version}.pdf"

        # 确保文件名以.pdf结尾
        if not filename.lower().endswith('.pdf'):
            filename = f"{filename}.pdf"

        # 清理文件名中的特殊字符
        filename = re.sub(r'[<>:"/\\|?*]', '_', filename)

        filepath = theme_dir / filename

        # 校验下载 URL 域名白名单，防止从 NCCN 页面抓取到的恶意链接
        if not self._is_url_allowed(pdf_url):
            self.logger.error(f"下载 URL 域名不在白名单中，跳过: {pdf_url}")
            return False

        # 检查文件是否已存在且有效
        if self._is_file_valid(filepath):
            self.logger.info(f"文件已存在且有效，跳过: {filename}")
            self.stats.skipped_files += 1
            # 返回哨兵值 'skipped'，区别于真正新下载成功的 True
            return 'skipped'

        # 重试机制
        for attempt in range(self.max_retries):
            try:
                self.logger.debug(f"下载尝试 {attempt + 1}/{self.max_retries}: {title}")

                # 预先检查文件大小
                if not self._check_pdf_validity(pdf_url):
                    self.logger.warning(f"文件可能无效，跳过: {pdf_url}")
                    return False

                # 设置下载headers
                download_headers = {
                    'Accept': 'application/pdf,application/x-pdf,*/*',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Referer': 'https://www.nccn.org/',
                }

                # 下载文件
                response = self.session.get(
                    pdf_url,
                    headers=download_headers,
                    stream=True,
                    timeout=self.timeout
                )
                response.raise_for_status()

                # 临时文件路径
                temp_filepath = filepath.with_suffix('.tmp')

                # 下载内容
                file_size = int(response.headers.get('content-length', 0))
                if file_size == 0:
                    file_size = None

                with open(temp_filepath, 'wb') as f, tqdm(
                    desc=filename[:50] + '...' if len(filename) > 50 else filename,
                    total=file_size,
                    unit='iB',
                    unit_scale=True,
                    unit_divisor=1024,
                    colour='green'
                ) as pbar:
                    downloaded_size = 0
                    for chunk in response.iter_content(chunk_size=8192):
                        if chunk:
                            size = f.write(chunk)
                            downloaded_size += size
                            pbar.update(size)

                # 验证PDF内容
                if self._validate_pdf_content(temp_filepath):
                    # 移动到最终位置
                    temp_filepath.rename(filepath)
                    self.stats.downloaded_size_mb += downloaded_size / (1024 * 1024)
                    self.logger.info(f"下载完成: {filename} ({downloaded_size/1024/1024:.1f}MB)")
                    return True
                else:
                    temp_filepath.unlink(missing_ok=True)
                    self.logger.error(f"PDF验证失败: {filename}")

            except Exception as e:
                self.logger.warning(f"下载尝试 {attempt + 1} 失败: {str(e)}")
                if attempt < self.max_retries - 1:
                    wait_time = self.retry_delay * (attempt + 1)
                    self.logger.info(f"等待 {wait_time} 秒后重试...")
                    time.sleep(wait_time)
                else:
                    self.logger.error(f"下载失败，已达最大重试次数: {title}")
                    # 清理临时文件
                    temp_filepath = filepath.with_suffix('.tmp')
                    temp_filepath.unlink(missing_ok=True)

        return False

    def _is_file_valid(self, filepath: Path) -> bool:
        """检查文件是否有效

        Args:
            filepath: 文件路径

        Returns:
            bool: 文件是否有效
        """
        if not filepath.exists():
            return False

        # 检查文件大小
        file_size = filepath.stat().st_size
        if file_size < self.min_file_size:
            return False

        # 检查PDF文件头
        try:
            with open(filepath, 'rb') as f:
                header = f.read(4)
                return header == b'%PDF'
        except OSError:
            # 文件读取失败视为无效；不吞 KeyboardInterrupt/SystemExit
            return False

    def _check_pdf_validity(self, pdf_url: str) -> bool:
        """检查PDF文件有效性

        Args:
            pdf_url: PDF文件URL

        Returns:
            bool: PDF是否有效
        """
        try:
            response = self.session.head(pdf_url, timeout=self.timeout)
            response.raise_for_status()

            content_length = response.headers.get('content-length', 0)
            if content_length:
                size = int(content_length)
                return size >= self.min_file_size

            return True

        except requests.exceptions.RequestException as e:
            # HEAD 请求失败（网络/SSL/超时等）时，假设文件有效，继续尝试真正下载
            # 只捕获 requests 异常，不吞 KeyboardInterrupt/SystemExit 和程序 bug
            self.logger.debug(f"HEAD 校验失败，将尝试直接下载: {e}")
            return True

    def _validate_pdf_content(self, filepath: Path) -> bool:
        """验证PDF文件内容

        Args:
            filepath: 文件路径

        Returns:
            bool: PDF内容是否有效
        """
        try:
            with open(filepath, 'rb') as f:
                # 检查PDF文件头
                header = f.read(4)
                if header != b'%PDF':
                    return False

                # 检查文件大小
                f.seek(0, 2)  # 移到文件末尾
                if f.tell() < self.min_file_size:
                    return False

                return True
        except OSError:
            # 文件读取失败视为校验未通过；不吞 KeyboardInterrupt/SystemExit
            return False

    def _generate_download_report(self, theme: ThemeConfig):
        """生成下载报告

        Args:
            theme: 主题配置
        """
        report = {
            'theme': theme.display_name,
            'timestamp': datetime.now().isoformat(),
            'stats': self.stats.to_dict()
        }

        # 保存JSON报告
        report_date = datetime.now().strftime('%Y%m%d_%H%M%S')
        report_file = self.logs_dir / f'stats_{theme.name}_{report_date}.json'

        with open(report_file, 'w', encoding='utf-8') as f:
            json.dump(report, f, ensure_ascii=False, indent=2)

        # 输出统计信息
        self.logger.info("=== 下载统计报告 ===")
        self.logger.info(f"主题: {theme.display_name}")
        self.logger.info(f"总文件数: {self.stats.total_files}")
        self.logger.info(f"成功下载: {self.stats.successful_files}")
        self.logger.info(f"跳过(已存在): {self.stats.skipped_files}")
        self.logger.info(f"下载失败: {self.stats.failed_files}")
        self.logger.info(f"成功率: {self.stats.success_rate:.1f}%")
        self.logger.info(f"总耗时: {self.stats.duration_seconds:.1f}秒")
        self.logger.info(f"平均速度: {self.stats.avg_speed_mbps:.2f}MB/s")
        self.logger.info(f"下载数据量: {self.stats.downloaded_size_mb:.1f}MB")
        self.logger.info(f"报告已保存: {report_file}")

    def _handle_failed_downloads(self, failed_files: List[str], theme_dir: Path, language_filter: str = 'all'):
        """处理失败下载的文件

        Args:
            failed_files: 失败文件 URL 列表
            theme_dir: 主题目录
            language_filter: 语言过滤选项
        """
        if not failed_files:
            return

        print(f"\n有 {len(failed_files)} 个文件下载失败:")
        for i, url in enumerate(failed_files, 1):
            short = url.split('/')[-1] if '/' in url else url
            print(f"  {i}. {short}")

        # 询问是否重新下载
        print(f"\n是否重新尝试下载失败的文件? (y/n): ", end='')
        try:
            choice = input().lower().strip()
            if choice in ['y', 'yes', '是']:
                self._retry_failed_downloads(failed_files, theme_dir, language_filter)
        except KeyboardInterrupt:
            print("\n用户取消操作")

    def _retry_failed_downloads(self, failed_files: List[str], theme_dir: Path, language_filter: str = 'all'):
        """重新下载失败的文件

        Args:
            failed_files: 失败文件列表
            theme_dir: 主题目录
            language_filter: 语言过滤选项
        """
        self.logger.info(f"开始重新下载 {len(failed_files)} 个失败文件...")

        # 重新获取PDF链接并匹配失败的文件
        for theme in self.THEMES.values():
            if theme.directory == theme_dir.name:
                pdf_links = self._get_pdf_links(theme, language_filter)

                for failed_file in failed_files:
                    # 查找匹配的PDF链接
                    for pdf_info in pdf_links:
                        if failed_file in pdf_info['title'] or failed_file in pdf_info['url']:
                            self.logger.info(f"重新下载: {failed_file}")
                            result = self._download_single_pdf(pdf_info, theme_dir)

                            if result is True or result == 'skipped':
                                self.logger.info(f"重新下载成功: {failed_file}")
                            else:
                                self.logger.error(f"重新下载失败: {failed_file}")

                            break
                break



def _print_config_guide(script_dir: Path, method: str = 'cookie') -> None:
    """打印配置操作指引。"""
    print()
    print("━" * 60)
    print("📖  配置操作指引")
    print("━" * 60)

    if method in ('cookie', ''):
        print("""
【Cookie 认证配置步骤】（推荐，当前配置方式）

  第一步：登录 NCCN 网站
  ┌─────────────────────────────────────────────────────┐
  │  1. 用浏览器打开  https://www.nccn.org/             │
  │  2. 点击右上角 "Log In"，输入账号密码登录           │
  └─────────────────────────────────────────────────────┘

  第二步：复制 Cookie
  ┌─────────────────────────────────────────────────────┐
  │  Chrome / Edge:                                     │
  │    ① 按 F12 打开开发者工具                          │
  │    ② 切换到 "Network（网络）" 标签                  │
  │    ③ 刷新页面，点击任意请求                         │
  │    ④ 在 "Headers → Request Headers" 中              │
  │       找到 "Cookie:" 一行                           │
  │    ⑤ 复制该行冒号后面的全部内容                     │
  └─────────────────────────────────────────────────────┘

  第三步：保存到 Cookie 文件
  ┌─────────────────────────────────────────────────────┐
  │  将复制的 Cookie 字符串粘贴到：                     │
  │    {cookie_file}
  │  （整个文件只需一行，即 Cookie 字符串本身）         │
  └─────────────────────────────────────────────────────┘

  配置文件路径说明：
    配置文件:  {config_file}
    Cookie 文件: {cookie_file}
""".format(
            cookie_file=str(script_dir / 'extracted_cookies.txt'),
            config_file=str(script_dir / 'config.json'),
        ))

    if method == 'username_password':
        print("""
【用户名/密码 认证配置步骤】

  编辑配置文件 {config_file}，
  将 authentication 部分改为：
  ┌─────────────────────────────────────────────────────┐
  │  {{                                                 │
  │    "authentication": {{                             │
  │      "method": "username_password",                 │
  │      "username": "your_email@example.com",          │
  │      "password": "your_nccn_password"               │
  │    }}                                               │
  │  }}                                                 │
  └─────────────────────────────────────────────────────┘
""".format(config_file=str(script_dir / 'config.json')))

    print("""  如需切换认证方式，可编辑 config.json 中 "method" 字段：
    "method": "cookie"            ← 使用 Cookie 认证（推荐）
    "method": "username_password" ← 使用账号密码认证

  配置文件模板位于：
    {template_file}
""".format(template_file=str(script_dir / '../assets/config.json.template')))
    print("━" * 60)


def _check_config_file(config_file: Path) -> Optional[Dict[str, Any]]:
    """检查 config.json 是否存在且格式正确，返回配置数据或 None。"""
    script_dir = config_file.resolve().parent

    if not config_file.exists():
        print(f"\n❌ 未找到配置文件: {config_file}")
        print(f"   请将 assets/config.json.template 复制为 scripts/config.json 并填写认证信息：")
        print(f"   cp {script_dir / '../assets/config.json.template'} {config_file}")
        _print_config_guide(script_dir)
        return None

    try:
        with open(config_file, 'r', encoding='utf-8') as f:
            config_data = json.load(f)
    except json.JSONDecodeError as e:
        print(f"\n❌ config.json 格式错误（JSON 解析失败）: {e}")
        print(f"   请检查 {config_file} 的 JSON 语法，可参考模板：")
        print(f"   {script_dir / '../assets/config.json.template'}")
        return None
    except Exception as e:
        print(f"\n❌ 读取配置文件失败: {e}")
        return None

    return config_data


def _check_cookie_file(cookie_file_path: Path, script_dir: Path) -> bool:
    """检查 Cookie 文件是否存在且非空，返回 True/False。"""
    if not cookie_file_path.exists():
        print(f"\n❌ Cookie 文件不存在: {cookie_file_path}")
        _print_config_guide(script_dir, method='cookie')
        return False

    try:
        content = cookie_file_path.read_text(encoding='utf-8').strip()
    except Exception as e:
        print(f"\n❌ 读取 Cookie 文件失败: {e}")
        return False

    if not content:
        print(f"\n❌ Cookie 文件内容为空: {cookie_file_path}")
        print("   Cookie 文件不能为空，请按以下步骤重新获取 Cookie：")
        _print_config_guide(script_dir, method='cookie')
        return False

    # 简单有效性检测：Cookie 字符串通常包含 '='
    if '=' not in content:
        print(f"\n⚠️  Cookie 文件内容格式可能有误: {cookie_file_path}")
        print("   标准 Cookie 字符串应形如: name1=value1; name2=value2; ...")
        print("   如果下载时遇到认证失败，请重新获取 Cookie。")

    return True


def _load_main_config(config_path: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """读取 config.json，并允许环境变量覆盖认证配置。
    启动时进行全面的配置检查，发现问题时给出详细操作指引。
    配置文件路径：scripts/config.json（与本脚本同目录）
    Cookie 文件路径：scripts/extracted_cookies.txt（与本脚本同目录）
    """
    config_file = Path(config_path or 'config.json')
    if not config_file.is_absolute():
        config_file = Path(__file__).resolve().parent / config_file
    script_dir = config_file.resolve().parent

    # ── 第一步：检查 config.json ──────────────────────────────
    config_data = _check_config_file(config_file)
    if config_data is None:
        return None

    print(f"✅ 成功读取配置文件: {config_file}")

    auth_config = config_data.get('authentication', {}) or {}
    method = os.getenv('NCCN_AUTH_METHOD') or auth_config.get('method', 'username_password')
    username = os.getenv('NCCN_USERNAME') or auth_config.get('username', '')
    password = os.getenv('NCCN_PASSWORD') or auth_config.get('password', '')
    cookie_file = os.getenv('NCCN_COOKIE_FILE') or auth_config.get('cookie_file', 'extracted_cookies.txt')
    cookie_file_path = Path(cookie_file).expanduser()
    if not cookie_file_path.is_absolute():
        # cookie_file 相对路径以脚本所在目录（scripts/）为基准
        cookie_file_path = script_dir / cookie_file_path

    config: Dict[str, Any] = {}

    # ── 第二步：按认证方式检查必要字段 ───────────────────────
    if method == 'username_password':
        issues = []
        if not username or username == '<your NCCN email>':
            issues.append("username（NCCN 登录邮箱）未填写")
        if not password or password in ('your_password_here', '<your_password_here>', ''):
            issues.append("password（NCCN 登录密码）未填写或仍为模板占位符")

        if issues:
            print(f"\n❌ 用户名/密码认证配置不完整，发现以下问题：")
            for i, issue in enumerate(issues, 1):
                print(f"   {i}. {issue}")
            _print_config_guide(script_dir, method='username_password')
            return None

        config['auth_method'] = 'username_password'
        config['username'] = username
        config['password'] = password
        print(f"✅ 认证方式: 用户名/密码  ({username})")

    elif method == 'cookie':
        env_cookie = os.getenv('NCCN_COOKIE')
        if env_cookie:
            config['auth_method'] = 'cookie'
            config['cookie'] = env_cookie
            print("✅ 认证方式: Cookie（来自环境变量 NCCN_COOKIE）")
        else:
            # ── 第三步：检查 extracted_cookies.txt ──────────────
            if not _check_cookie_file(cookie_file_path, script_dir):
                return None
            config['auth_method'] = 'cookie'
            config['cookie_file'] = str(cookie_file_path)
            print(f"✅ 认证方式: Cookie 文件  ({cookie_file_path})")

    else:
        print(f"\n❌ 不支持的认证方式: {method!r}")
        print("   config.json 中 \"method\" 应为 \"cookie\" 或 \"username_password\"")
        _print_config_guide(script_dir)
        return None

    # 透传下载设置
    if 'download_settings' in config_data:
        config['download_settings'] = config_data['download_settings']

    return config


def _prompt_language_filter(default: str = '1') -> str:
    """询问简化语言菜单。"""
    print("\n📋 语言筛选:")
    print("0. 中文")
    print("1. 英文（默认）")
    print("2. 日语/其他语言")
    print("3. 全部")
    while True:
        choice = input(f"请选择语言 (0-3, 默认{default}): ").strip() or default
        if choice in NCCNDownloaderV2.LANGUAGE_GROUPS:
            return NCCNDownloaderV2.normalize_language_filter(choice)
        print("无效选择，请输入 0-3")


def _prompt_cancer_filter(downloader: NCCNDownloaderV2) -> Optional[str]:
    """询问癌种筛选。"""
    print("\n📋 癌种类型筛选:")
    print("0. 全部癌种（默认）")
    print("L. 查看/刷新NCCN癌种列表")
    print("K. 手工输入关键词，例如 breast / 乳腺 / lung,colorectal")

    while True:
        choice = input("请选择癌种 (0/L/K, 默认0): ").strip()
        if not choice:
            return None
        key = choice.lower()
        if key == '0':
            return None
        if key == 'l':
            refresh = input("是否强制刷新NCCN癌种列表? (y/N): ").strip().lower() in ['y', 'yes', '是']
            items = downloader._discover_cancer_types_from_page(refresh=refresh)
            print(f"\n找到 {len(items)} 个癌种:")
            for i, item in enumerate(items, 1):
                print(f"  {i}. {item}")
            print("  0. 全部癌种")
            print("  K. 手工输入关键词")
            continue
        if key == 'k':
            return input("请输入癌种关键词（逗号分隔）: ").strip()
        return choice


def _select_pdf_list(pdf_links: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """展示解析到的 PDF 清单，让用户选择下载哪些文件。

    Returns:
        用户选择的 PDF 子列表，或全部（选择"全部"或取消时）。
    """
    if not pdf_links:
        return []

    print("\n📋 解析到的 PDF 清单:")
    print("=" * 60)
    for i, pdf in enumerate(pdf_links, 1):
        title = pdf.get('title', 'Unknown')
        version = pdf.get('version', 'Unknown')
        url_short = pdf.get('url', '')
        if len(url_short) > 60:
            url_short = url_short[:60] + '...'
        print(f"  {i}. [{version}] {title}")
        print(f"     {url_short}")
    print("=" * 60)
    print(f"  A. 全部下载 ({len(pdf_links)} 个文件)")
    print(f"  输入编号选择，逗号分隔多个，如: 1,3,5-8")
    print(f"  直接回车 = 全部下载")

    choice = input("\n请选择 (A/编号/回车=全部): ").strip()
    if not choice or choice.lower() == 'a':
        return pdf_links

    # Parse number selections: supports "1,3,5-8" format
    selected = set()
    parts = re.split(r'[,，\s]+', choice)
    for part in parts:
        part = part.strip()
        if '-' in part:
            try:
                start, end = part.split('-', 1)
                for n in range(int(start.strip()), int(end.strip()) + 1):
                    if 1 <= n <= len(pdf_links):
                        selected.add(n - 1)
            except ValueError:
                pass
        else:
            try:
                n = int(part)
                if 1 <= n <= len(pdf_links):
                    selected.add(n - 1)
            except ValueError:
                pass

    if not selected:
        print("未选择任何文件，默认下载全部。")
        return pdf_links

    result = [pdf_links[i] for i in sorted(selected)]
    print(f"\n已选择 {len(result)} 个文件进行下载。")
    return result


def _confirm_download(theme_name: str, language_filter: str, cancer_filter: Optional[str]) -> bool:
    """下载前确认。"""
    print("\n=== 下载确认 ===")
    print(f"主题: {theme_name}")
    print(f"语言: {NCCNDownloaderV2.language_group_label(language_filter)}")
    print(f"癌种: {cancer_filter or '全部'}")
    choice = input("确认后输入 Y 开始下载，其他键取消: ").strip().lower()
    return choice in ['y', 'yes', '是']


def _show_download_stats(downloader: NCCNDownloaderV2):
    """显示最近统计报告。"""
    report_files = sorted(downloader.logs_dir.glob('stats_*.json'), key=lambda p: p.stat().st_mtime, reverse=True)
    if not report_files:
        print("\n暂无下载统计，请先运行下载。")
        return

    print("\n最近5次下载统计:")
    for i, report_file in enumerate(report_files[:5], 1):
        try:
            with open(report_file, 'r', encoding='utf-8') as f:
                report = json.load(f)
            stats = report.get('stats', {})
            print(f"{i}. {report_file.name}")
            print(f"   主题: {report.get('theme', 'N/A')}")
            print(f"   总数: {stats.get('total_files', 0)} | 成功: {stats.get('successful_files', 0)} | 跳过: {stats.get('skipped_files', 0)} | 失败: {stats.get('failed_files', 0)}")
        except Exception:
            print(f"{i}. {report_file.name}（读取失败）")


def _prompt_cancer_from_list(downloader: NCCNDownloaderV2, theme: ThemeConfig) -> Optional[str]:
    """从内置癌种列表中选择（二级菜单）。"""
    print("\n📋 癌种类型筛选:")
    print("  0. 全部癌种（默认）")
    print("  L. 查看/刷新NCCN癌种列表")
    print("  K. 手工输入关键词，例如 breast / 乳腺 / lung,colorectal")
    print("  或直接输入癌种编号/名称（支持中英文）")

    while True:
        choice = input("请选择癌种 (0/L/K/名称, 默认0): ").strip()
        if not choice:
            return None
        key = choice.lower()
        if key == '0':
            return None
        if key == 'l':
            refresh = input("是否强制刷新NCCN癌种列表? (y/N): ").strip().lower() in ['y', 'yes', '是']
            items = downloader._discover_cancer_types_from_page(refresh=refresh)
            print(f"\n找到 {len(items)} 个癌种:")
            for i, item in enumerate(items, 1):
                print(f"  {i}. {item}")
            print("  0. 全部癌种")
            print("  K. 手工输入关键词")
            continue
        if key == 'k':
            return input("请输入癌种关键词（逗号分隔）: ").strip()
        return choice


def main(config_path: Optional[str] = None, download_dir: Optional[str] = None):
    """主函数：经典菜单 + 二级菜单（语言/癌种）+ PDF清单选择。"""
    print("=" * 60)
    print("    NCCN指南下载工具 v2.3")
    print("    支持癌种筛选、语言筛选、PDF清单选择与 ncd CLI")
    print("=" * 60)

    config = _load_main_config(config_path=config_path)
    if not config:
        return

    downloader = NCCNDownloaderV2(config)
    if download_dir:
        downloader.base_download_dir = Path(download_dir).expanduser().resolve()
        downloader.logs_dir = downloader.base_download_dir / 'logs'
        downloader.setup_directories()

    print("\n正在测试认证...")
    if not downloader.authenticate():
        print("认证失败，请检查认证信息")
        return

    print("认证成功!\n")

    while True:
        print("\n请选择要下载的主题:")
        print("=" * 60)
        for key, theme in NCCNDownloaderV2.THEMES.items():
            print(f"{key}. {theme.display_name}")
            print(f"   {theme.description}")
            print(f"   目录: {theme.directory}")
            print()
        print(f"{len(NCCNDownloaderV2.THEMES) + 1}. 查看下载统计")
        print(f"{len(NCCNDownloaderV2.THEMES) + 2}. 退出")

        try:
            max_choice = len(NCCNDownloaderV2.THEMES) + 2
            choice = input(f"\n请输入选择 (1-{max_choice}): ").strip()

            if not choice:
                continue

            if choice == str(max_choice):
                print("感谢使用NCCN下载工具!")
                break
            elif choice == str(max_choice - 1):
                _show_download_stats(downloader)
                input("\n按回车键返回主菜单...")
            elif choice in NCCNDownloaderV2.THEMES:
                theme = NCCNDownloaderV2.THEMES[choice]
                print(f"\n{'=' * 60}")
                print(f"主题: {theme.display_name}")
                print(f"目录: {theme.directory}")
                print(f"{'=' * 60}")

                # --- 二级菜单：语言筛选 ---
                language_filter = 'all'
                needs_language = theme.has_language_filter or theme.category in [
                    'category_1', 'category_3', 'patient_guidelines_english',
                    'patient_guidelines_chinese', 'patient_translations', 'clinical_translations'
                ]
                if needs_language:
                    language_filter = _prompt_language_filter('1')
                    print(f"✅ 语言筛选: {NCCNDownloaderV2.language_group_label(language_filter)}")

                # --- 二级菜单：癌种筛选 ---
                cancer_filter = None
                if theme.category in ['category_1', 'category_3']:
                    cancer_filter = _prompt_cancer_from_list(downloader, theme)
                    if cancer_filter:
                        print(f"✅ 癌种筛选: {cancer_filter}")
                    else:
                        print("✅ 癌种筛选: 全部")

                # --- 获取 PDF 链接 ---
                print(f"\n🔍 正在获取PDF链接...")
                print(f"   主题: {theme.display_name}")
                print(f"   语言: {NCCNDownloaderV2.language_group_label(language_filter)}")
                print(f"   癌种: {cancer_filter or '全部'}")

                pdf_links = downloader._get_pdf_links(theme, language_filter, cancer_filter)
                if not pdf_links:
                    print("❌ 未找到PDF链接")
                    input("\n按回车键返回主菜单...")
                    continue

                # --- PDF 清单选择 ---
                selected_pdfs = _select_pdf_list(pdf_links)
                if not selected_pdfs:
                    print("未选择任何文件，返回主菜单。")
                    input("\n按回车键返回主菜单...")
                    continue

                # --- 下载确认 ---
                if not _confirm_download(theme.display_name, language_filter, cancer_filter):
                    print("已取消下载")
                    input("\n按回车键返回主菜单...")
                    continue

                # --- 执行下载 ---
                success = downloader.download_theme(choice, language_filter, cancer_filter, pdf_selection=selected_pdfs)
                print(f"\n{'✅' if success else '❌'} 下载完成" if success else f"\n❌ {theme.display_name} 下载失败!")
                input("\n按回车键返回主菜单...")
            else:
                print(f"无效选择，请输入 1-{max_choice}")

        except KeyboardInterrupt:
            print("\n\n用户中断操作")
            break
        except Exception as e:
            print(f"\n发生错误: {str(e)}")
            import traceback
            traceback.print_exc()
            input("按回车键继续...")

if __name__ == "__main__":
    main()