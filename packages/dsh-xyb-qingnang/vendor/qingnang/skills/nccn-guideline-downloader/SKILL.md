---
name: nccn-guideline-downloader
description: "Download NCCN clinical practice guidelines and patient manuals in English or Chinese. Guides users through theme selection, language filter, cancer type filter, and PDF list selection. Triggers when user mentions NCCN, clinical guidelines, cancer guidelines, patient manuals, 指南下载, 癌症指南, 患者手册, or downloading medical guidelines from nccn.org."
---

# NCCN Guideline Downloader

Download NCCN (National Comprehensive Cancer Network) clinical guidelines and patient manuals through a guided conversational workflow.

## Configuration Check (Run First)

Before downloading, the script automatically checks configuration at startup. Two files must exist in the **`scripts/`** directory (same folder as the script):

| File | Path | Purpose |
|------|------|---------|
| Config | `scripts/config.json` | Authentication method and settings |
| Cookie | `scripts/extracted_cookies.txt` | Cookie string for authentication |

**If config is missing**, the script prints a detailed guide and exits. Do NOT proceed with download until config is complete.

### Setup Steps

1. **Install dependencies:**
   ```bash
   pip install -r scripts/requirements.txt
   ```

2. **Create config file** (copy from template):
   ```bash
   cp assets/config.json.template scripts/config.json
   ```
   Default `scripts/config.json` uses cookie auth — no edits needed for cookie method.

3. **Get NCCN Cookie and save to `scripts/extracted_cookies.txt`:**
   - Login at https://www.nccn.org/
   - Press F12 → Network tab → refresh page → click any request
   - Copy the `Cookie:` header value from Request Headers
   - Paste the entire string into `scripts/extracted_cookies.txt` (one line only)

4. **Verify config** by running the script — it will confirm:
   ```
   ✅ 成功读取配置文件: .../scripts/config.json
   ✅ 认证方式: Cookie 文件  (.../scripts/extracted_cookies.txt)
   ```

### Config File Reference

**Cookie auth (recommended)** — `scripts/config.json`:
```json
{
  "authentication": {
    "method": "cookie",
    "cookie_file": "extracted_cookies.txt"
  }
}
```

**Username/password auth** — `scripts/config.json`:
```json
{
  "authentication": {
    "method": "username_password",
    "username": "your@email.com",
    "password": "your_password"
  }
}
```

**Environment variables** (override config file):
```bash
export NCCN_COOKIE="name1=val1; name2=val2; ..."   # highest priority
export NCCN_AUTH_METHOD="username_password"
export NCCN_USERNAME="your@email.com"
export NCCN_PASSWORD="your_password"
```

## Workflow

### 1. Identify Theme

Map user intent to one of 6 themes:

| # | Theme | URL Pattern |
|---|-------|-------------|
| 1 | Cancer Treatment (English) | `guidelines/category_1` |
| 2 | Supportive Care | `guidelines/category_3` |
| 3 | Patient Guidelines (English) | `patientresources/patient-resources/guidelines-for-patients` (English) |
| 4 | Clinical Guidelines (Chinese Translation) | `patientresources/patient-resources/guidelines-for-patients` (Chinese) |
| 5 | Patient Guidelines (Chinese Translation) | Translation page |
| 6 | Patient Guidelines (Chinese Version) | Translation page (direct) |

### 2. Language Filter

```
0. Chinese    1. English (default)    2. Japanese/Other    3. All
```

Default to English (1) unless user specifies Chinese.

### 3. Cancer Type Filter

65 cancer types with Chinese/English alias matching. See [references/cancer_types.md](references/cancer_types.md) for the full list.

Common shortcuts: `breast`/`乳腺`, `lung`/`肺`, `pancreatic`/`胰腺`, `colon`/`结肠`, `gastric`/`胃`, `prostate`/`前列腺`, `ovarian`/`卵巢`, `thyroid`/`甲状腺`.

Chinese keywords auto-expand to all English aliases (e.g., `胰腺` → `pancreatic adenocarcinoma`, `pancreatic`, `pancreas`).

Options: `0` = all, `L` = browse list from NCCN, `K` = manual keyword.

### 4. PDF List Selection

After parsing, show numbered list. User selects by number: `1,3,5-8` or `A`/Enter for all.

### 5. Confirm & Download

Show summary, confirm, then run:

```bash
python3 scripts/download_nccn.py
```

## Execution

**Interactive (recommended):**

```bash
cd ~/.agents/skills/nccn-guideline-downloader
python3 scripts/download_nccn.py
```

**Guided:** Orchestrate the conversation, collect choices, then run the script with the collected parameters.

## Key Behaviors

- Config files are always resolved relative to **`scripts/`** directory (where the script lives)
- Downloads go to `scripts/nccn_downloads/` subdirectory (auto-created)
- Existing valid PDFs are skipped (checks `%PDF` header + 100KB minimum)
- Failed downloads retry up to 3 times with exponential backoff
- Domain whitelist enforced: only `nccn.org` and subdomains
- Download stats saved to `scripts/nccn_downloads/logs/stats_*.json`
- 42 offline tests available: `python3 scripts/test_offline.py`

## Troubleshooting

- **Config missing:** Run `cp assets/config.json.template scripts/config.json`
- **Cookie file missing:** Save browser Cookie string to `scripts/extracted_cookies.txt`
- **Auth failure:** Cookie expired — refresh browser Cookie and overwrite `scripts/extracted_cookies.txt`
- **No PDFs found:** NCCN site structure may have changed; try `L` to refresh cancer list
- **Corrupted files:** Script validates `%PDF` header; check logs for file sizes
