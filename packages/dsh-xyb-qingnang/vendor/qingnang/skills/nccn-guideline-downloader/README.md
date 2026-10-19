# NCCN Guideline Downloader Skill

独立部署的 NCCN 临床指南下载技能，支持 65 种癌种、中英文筛选、PDF 清单选择。

## 功能特性

- **6 大主题**：癌症治疗指南、支持性护理、患者指南（英文/中文翻译/中文版本）
- **65 种癌种**：内置完整癌种列表，支持中英文关键词自动匹配
- **智能筛选**：语言筛选（中/英/其他/全部）+ 癌种筛选
- **PDF 清单选择**：解析后展示编号列表，支持 `1,3,5-8` 范围选择
- **跨语言匹配**：输入中文关键词自动扩展为英文别名（如"胰腺"→"pancreatic"）
- **安全下载**：域名白名单、PDF 验证、重试机制、断点续传
- **启动配置检查**：自动检测 `scripts/config.json` 和 `scripts/extracted_cookies.txt`，配置不完整时给出详细操作指引

## 目录结构

```
nccn-guideline-downloader/
├── SKILL.md                    # 技能说明（AI 读取）
├── README.md                   # 本文件
├── .gitignore                  # Git 忽略规则
├── agents/
│   └── openai.yaml             # UI 元数据
├── scripts/
│   ├── download_nccn.py        # 下载主脚本
│   ├── test_offline.py         # 离线测试（42项）
│   ├── requirements.txt        # Python 依赖
│   ├── config.json             # ⚠️ 你的配置（需手动创建，不提交到 Git）
│   └── extracted_cookies.txt   # ⚠️ Cookie文件（需手动创建，不提交到 Git）
├── references/
│   └── cancer_types.md         # 65种癌种列表
├── assets/
│   └── config.json.template    # 配置模板（可直接复制）
└── nccn_downloads/             # 下载目录（自动创建，不提交到 Git）
```

## 安装

### 1. 安装 Python 依赖

```bash
cd ~/.agents/skills/nccn-guideline-downloader
pip install -r scripts/requirements.txt
```

### 2. 配置认证（必须完成，否则无法下载）

配置文件和 Cookie 文件均放在 **`scripts/`** 目录下（与下载脚本同级）：

```
scripts/config.json             ← 认证配置文件
scripts/extracted_cookies.txt   ← Cookie 文件（Cookie 认证时必须）
```

#### 方式一：Cookie 认证（推荐）

**步骤 1**：从模板创建配置文件

```bash
cp assets/config.json.template scripts/config.json
```

`scripts/config.json` 默认内容（method 已设为 cookie，无需修改）：

```json
{
  "authentication": {
    "method": "cookie",
    "cookie_file": "extracted_cookies.txt"
  }
}
```

**步骤 2**：获取 NCCN Cookie

1. 用浏览器打开 https://www.nccn.org/ 并登录
2. 按 **F12** 打开开发者工具，切换到 **Network（网络）** 标签
3. 刷新页面，点击任意请求
4. 在 **Headers → Request Headers** 中找到 **`Cookie:`** 一行
5. 复制该行冒号后面的全部内容

**步骤 3**：保存 Cookie 到文件

将复制的 Cookie 字符串粘贴到 `scripts/extracted_cookies.txt`（整个文件只需一行）：

```bash
# 直接粘贴到文件（替换 <your-cookie-string> 为实际内容）
echo '<your-cookie-string>' > scripts/extracted_cookies.txt
```

#### 方式二：用户名/密码认证

编辑 `scripts/config.json`，修改 authentication 部分：

```json
{
  "authentication": {
    "method": "username_password",
    "username": "your_email@example.com",
    "password": "your_nccn_password"
  }
}
```

#### 环境变量（优先级高于配置文件）

```bash
export NCCN_AUTH_METHOD="cookie"
export NCCN_COOKIE="name1=value1; name2=value2; ..."   # 直接传入 Cookie 字符串
# 或
export NCCN_AUTH_METHOD="username_password"
export NCCN_USERNAME="your@email.com"
export NCCN_PASSWORD="your_password"
```

### 3. 验证配置

运行脚本，会自动检查配置文件。配置正确时输出：

```
✅ 成功读取配置文件: .../scripts/config.json
✅ 认证方式: Cookie 文件  (.../scripts/extracted_cookies.txt)
```

配置有问题时会给出具体错误提示和操作指引，例如：

```
❌ Cookie 文件不存在: .../scripts/extracted_cookies.txt
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📖  配置操作指引
...
```

## 使用

### 方式一：交互式菜单

```bash
cd ~/.agents/skills/nccn-guideline-downloader
python3 scripts/download_nccn.py
```

### 方式二：通过 AI 助手

在支持技能的 AI 助手中输入：
- "下载胰腺癌的中文患者指南"
- "帮我下载乳腺癌英文治疗指南"
- "有哪些癌种的指南可以下载？"

## 测试

运行 42 项离线回归测试（不需要网络或认证）：

```bash
python3 scripts/test_offline.py
```

## 安全说明

- `scripts/config.json` 和 `scripts/extracted_cookies.txt` 已加入 `.gitignore`，不会被提交
- 下载域名白名单限制为 `nccn.org` 及其子域名
- PDF 文件下载后验证 `%PDF` 文件头和最小大小（100KB）
- Cookie 文件内容不会传递给 AI 助手，仅在本地脚本中读取

## 常见问题

**Q：运行提示"配置文件不存在"**  
A：执行 `cp assets/config.json.template scripts/config.json` 创建配置文件。

**Q：运行提示"Cookie 文件不存在"**  
A：按上述步骤从浏览器获取 Cookie，保存到 `scripts/extracted_cookies.txt`。

**Q：认证失败（Auth failure）**  
A：Cookie 已过期，重新从浏览器获取最新 Cookie 并覆盖 `scripts/extracted_cookies.txt`。

**Q：找不到 PDF**  
A：NCCN 网站结构可能有变化，尝试在癌种选择时按 `L` 刷新癌种列表。

## 版本

- **v2.4** — 配置文件路径统一为 `scripts/`，启动时自动检查配置并给出操作指引
- **v2.3** — 65种癌种、二级菜单、PDF清单选择、默认英文
- **v2.0** — 菜单式操作界面、6种主题、双重认证
- 基于 NCCN 网站 2026 年结构
