import os
import json
import hashlib
import requests
import time
import argparse
import re
from datetime import datetime
from pathlib import Path
from dotenv import load_dotenv
from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger

# 加载环境变量
load_dotenv()

# ==================== 配置读取 ====================
FASTGPT_BASE_URL = os.getenv("FASTGPT_BASE_URL", "").strip().rstrip("/")
FASTGPT_API_KEY = os.getenv("FASTGPT_API_KEY", "").strip()
FASTGPT_DATASET_ID = os.getenv("FASTGPT_DATASET_ID", "").strip()

FASTGPT_LOCAL_DIR = os.getenv("FASTGPT_LOCAL_DIR", "./output").strip()
FASTGPT_CN_SUBDIR = os.getenv("FASTGPT_CN_SUBDIR", "cn").strip()
FASTGPT_FILE_EXTENSIONS = os.getenv("FASTGPT_FILE_EXTENSIONS", ".md,.pdf,.txt").strip().split(",")
FASTGPT_IGNORE_PATTERNS = os.getenv("FASTGPT_IGNORE_PATTERNS", "").strip()

SYNC_STATE_DB = os.getenv("FASTGPT_SYNC_STATE_DB", "./data/fastgpt_sync_state.json").strip()
DAILY_SYNC_TIME = os.getenv("FASTGPT_DAILY_SYNC_TIME", "02:00").strip()
TIMEZONE = os.getenv("FASTGPT_TIMEZONE", "Asia/Shanghai").strip()

RETRY_TIMES = int(os.getenv("FASTGPT_PUSH_RETRY_TIMES", 3))
RETRY_DELAY = int(os.getenv("FASTGPT_PUSH_RETRY_DELAY_SECONDS", 5))

# 全局上传过滤模式
UPLOAD_FILTER_MODE = "today"  # "today" 或 "all"

class FastGPTSyncer:
    def __init__(self):
        # 同时支持多种 Header 格式，增强兼容性
        # 在 Header 中注入 datasetId，解决部分私有化环境的路由校验问题
        self.headers = {
            "Authorization": f"Bearer {FASTGPT_API_KEY}",
            "apikey": FASTGPT_API_KEY,
            "datasetId": FASTGPT_DATASET_ID,
            "Content-Type": "application/json"
        }
        self.state = self._load_state()

    def _load_state(self):
        path = Path(SYNC_STATE_DB)
        if path.exists():
            try:
                with open(path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except:
                return {"files": {}}
        return {"files": {}}

    def _save_state(self):
        path = Path(SYNC_STATE_DB)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.state, f, ensure_ascii=False, indent=2)

    def _get_file_hash(self, filepath):
        hasher = hashlib.md5()
        with open(filepath, "rb") as f:
            for chunk in iter(lambda: f.read(4096), b""):
                hasher.update(chunk)
        return hasher.hexdigest()

    def _get_api_base(self):
        """
        强制从域名根路径构建 FastGPT 标准 API 路径，规避 /v1/ 等干扰
        """
        # 提取协议和域名部分，忽略所有后缀
        match = re.match(r'(https?://[^/]+)', FASTGPT_BASE_URL)
        if match:
            root = match.group(1)
            return f"{root}/api"
        return FASTGPT_BASE_URL.rstrip('/')

    def _safe_json(self, resp):
        """
        安全解析 JSON，确保返回字典
        """
        try:
            data = resp.json()
            # 如果返回的是 JSON 字符串（多重编码），则解析它
            if isinstance(data, str):
                try:
                    import json
                    data = json.loads(data)
                except:
                    pass
            # 确保最终返回的是字典
            if isinstance(data, dict):
                return data
            return {"data": data} # 包装一下，防止 .get() 失败
        except:
            return {}

    def get_or_create_collection(self, name, parent_id=None):
        """
        在 FastGPT 中查找或创建集合（目录）
        """
        api_base = self._get_api_base()
        
        # 1. 查找是否存在
        url = f"{api_base}/core/dataset/collection/list"
        params = {
            "datasetId": FASTGPT_DATASET_ID,
            "searchText": name
        }
        if parent_id:
            params["parentId"] = parent_id

        try:
            resp = requests.get(url, headers=self.headers, params=params, timeout=30)
            if resp.status_code == 200:
                res_json = self._safe_json(resp)
                if res_json.get("code") == 200:
                    collections = res_json.get("data", [])
                    if isinstance(collections, list):
                        for col in collections:
                            if isinstance(col, dict) and col.get("name") == name:
                                return col.get("_id")
            
            # 2. 不存在则创建
            create_url = f"{api_base}/core/dataset/collection/create"
            payload = {
                "datasetId": FASTGPT_DATASET_ID,
                "parentId": parent_id if parent_id else None,
                "name": name,
                "type": "folder"
            }
            resp = requests.post(create_url, headers=self.headers, json=payload, timeout=30)
            if resp.status_code == 200:
                res_json = self._safe_json(resp)
                if res_json.get("code") == 200:
                    data = res_json.get("data")
                    if isinstance(data, dict):
                        return data.get("_id") or data.get("collectionId")
                    return data # 如果 data 直接是 ID 字符串
            else:
                print(f"Error creating collection {name}: {resp.status_code} - {resp.text[:100]}")
        except Exception as e:
            print(f"API Error (get_or_create_collection): {e}")
        return None

    def upload_file(self, filepath, collection_id):
        """
        适配官方 create/localFile 接口上传文件
        """
        api_base = self._get_api_base()
        url = f"{api_base}/core/dataset/collection/create/localFile"
        
        file_path_obj = Path(filepath)
        
        for attempt in range(RETRY_TIMES):
            try:
                with open(filepath, "rb") as f:
                    files = {
                        "file": (file_path_obj.name, f)
                    }
                    # 严格按照官方示例参数
                    data_payload = {
                        "datasetId": FASTGPT_DATASET_ID,
                        "parentId": collection_id,
                        "trainingType": "chunk",
                        "chunkSize": 512,
                        "chunkSplitter": "",
                        "qaPrompt": "",
                        "metadata": {}
                    }
                    form_data = {
                        "data": json.dumps(data_payload)
                    }
                    
                    upload_headers = {
                        "Authorization": f"Bearer {FASTGPT_API_KEY}",
                        "apikey": FASTGPT_API_KEY,
                        "datasetId": FASTGPT_DATASET_ID
                    }
                    
                    resp = requests.post(url, headers=upload_headers, files=files, data=form_data, timeout=120)
                    if resp.status_code == 200:
                        res_json = self._safe_json(resp)
                        if res_json.get("code") == 200:
                            print(f"Successfully uploaded: {file_path_obj.name}")
                            return True
                        else:
                            print(f"Upload API error: {res_json.get('message')}")
                    else:
                        print(f"Upload failed (HTTP {resp.status_code}): {resp.text[:200]}")
            except Exception as e:
                print(f"Upload exception: {e}")
            
            if attempt < RETRY_TIMES - 1:
                time.sleep(RETRY_DELAY)
        return False

    def _diagnose_dataset(self):
        """
        诊断模式：列出当前 API Key 下所有可见的数据集，帮助排查 ID 错误
        """
        api_base = self._get_api_base()
        url = f"{api_base}/core/dataset/list"
        print(f"[{datetime.now()}] [DIAGNOSIS] Probing datasets at: {url}")
        
        try:
            resp = requests.get(url, headers=self.headers, timeout=20)
            if resp.status_code == 200:
                data = resp.json().get("data", [])
                if not data:
                    print("[DIAGNOSIS] ⚠️ API Key 有效，但该账号下没有任何数据集。")
                else:
                    print(f"[DIAGNOSIS] ✅ Success! Found {len(data)} datasets:")
                    for ds in data:
                        marker = "⭐ (MATCH)" if ds.get("_id") == FASTGPT_DATASET_ID else ""
                        print(f"  - Name: {ds.get('name')}, ID: {ds.get('_id')} {marker}")
            else:
                print(f"[DIAGNOSIS] ❌ Failed (HTTP {resp.status_code}): {resp.text[:200]}")
        except Exception as e:
            print(f"[DIAGNOSIS] ❌ Error: {e}")

    def _parse_dirs(self, raw_val):
        """
        智能解析目录列表：支持标准 JSON 数组格式或逗号分隔字符串
        """
        if not raw_val:
            return []
        
        # 尝试 JSON 解析
        if raw_val.strip().startswith("[") and raw_val.strip().endswith("]"):
            try:
                import json
                parsed = json.loads(raw_val)
                if isinstance(parsed, list):
                    return [p.strip() for p in parsed if p.strip()]
            except:
                pass # 解析失败则降级到逗号分隔
        
        # 降级处理：逗号分隔
        return [d.strip() for d in raw_val.split(",") if d.strip()]

    def _get_file_identity(self, filename):
        """
        提取文件唯一标识：优先提取 NCT 编号（不含后缀），否则使用完整文件名
        """
        nct_match = re.search(r'NCT\d{8}', filename)
        if nct_match:
            return nct_match.group(0)
        return filename

    def sync_once(self):
        print(f"[{datetime.now()}] Starting sync...")
        
        # 1. 状态平滑迁移：将旧的以文件名作为 Key 的状态，转换为以 NCT/Identity 作为 Key
        migrated_files = {}
        original_files = self.state.get("files", {})
        print(f"[{datetime.now()}] Current state contains {len(original_files)} records.")
        
        for key, val in original_files.items():
            # 这里必须确保 key 被正确转换
            new_identity = self._get_file_identity(key)
            if new_identity not in migrated_files:
                if "filename" not in val:
                    val["filename"] = key
                migrated_files[new_identity] = val
            else:
                # 如果已经存在（例如 NCT06959615.md 和 2026...NCT06959615-zh.md）
                # 我们可以合并或保留最新的，这里选择保留已有的（通常是更规范的标识）
                pass
        
        # 强制更新状态，无论数量是否变化（因为我们想把 Key 从 .md 变成纯 NCT）
        print(f"[{datetime.now()}] Migration: Converting keys to clean identities.")
        self.state["files"] = migrated_files
        self._save_state()

        # 2. 支持多根目录智能解析
        raw_val = os.getenv("FASTGPT_LOCAL_DIR", "./output")
        roots = [Path(d) for d in self._parse_dirs(raw_val)]
        
        added, modified, skipped = 0, 0, 0
        collection_cache = {} # 集合 ID 缓存，避免重复 API 调用

        for root in roots:
            if not root.exists():
                print(f"Warning: Local dir {root} not found, skipping...")
                continue
            
            print(f"[{datetime.now()}] Scanning source: {root}")
            
            # 策略：递归扫描所有包含 "-zh" 的 md 文件
            # 使用 rglob("*") 遍历所有深度，不再局限于 cn 子目录
            all_files = [f for f in root.rglob("*") if f.is_file() and f.suffix == ".md"]
            
            for file_path in all_files:
                filename = file_path.name
                
                # 【核心过滤】：文件名必须含有 "-zh" 且排除系统干扰文件
                if "-zh" not in filename or ".DS_Store" in filename:
                    continue
                
                # 【日期过滤】：根据模式决定是否过滤历史文件
                if UPLOAD_FILTER_MODE == "today":
                    today_str = datetime.now().strftime("%Y-%m-%d")
                    if not filename.startswith(today_str):
                        skipped += 1
                        continue
                
                # 【智能去重标识】：提取 NCT 编号或使用文件名作为 ID
                file_identity = self._get_file_identity(filename)
                file_hash = self._get_file_hash(file_path)
                
                # 【去重逻辑】：基于标识符（NCT/文件名）和内容指纹（Hash）双重校验
                file_state = self.state["files"].get(file_identity)
                
                if file_state and file_state.get("hash") == file_hash:
                    skipped += 1
                    continue
                
                # 智能确定集合名称 (Collection Name)
                # 策略：默认取父目录名，若是技术子目录则向上溯源，若是历史路径则强制归类
                collection_name = file_path.parent.name
                
                if collection_name in [FASTGPT_CN_SUBDIR, "zh", "en"]:
                    collection_name = file_path.parent.parent.name
                
                if "history" in file_path.parts:
                    collection_name = "history"
                
                # 如果 collection_name 提取失败或仍是根目录，则使用 root 的文件夹名
                if not collection_name or collection_name in [".", "/", root.name]:
                    collection_name = "Default_Collection"

                if collection_name in collection_cache:
                    collection_id = collection_cache[collection_name]
                else:
                    collection_id = self.get_or_create_collection(collection_name)
                    if collection_id:
                        collection_cache[collection_name] = collection_id
                
                if not collection_id:
                    print(f"Skipping {filename} due to collection error ({collection_name}).")
                    continue

                action = "Updating" if file_state else "Adding"
                print(f"[{datetime.now()}] {action}: {filename} (in {collection_name})")
                
                if self.upload_file(file_path, collection_id):
                    self.state["files"][file_identity] = {
                        "filename": filename,
                        "hash": file_hash,
                        "uploadTime": datetime.now().isoformat(),
                        "collectionId": collection_id,
                        "sourcePath": str(file_path.relative_to(root))
                    }
                    if file_state:
                        modified += 1
                    else:
                        added += 1
                    self._save_state()
                
        print(f"[{datetime.now()}] Sync complete: ✅ Added: {added}, Modified: {modified}, Skipped: {skipped}")

def main():
    parser = argparse.ArgumentParser(description="FastGPT Local Knowledge Base Syncer")
    parser.add_argument("--once", action="store_true", help="Run sync once and exit")
    parser.add_argument("--daemon", action="store_true", help="Run as a daemon with scheduler")
    parser.add_argument("--mode", type=str, default="today", choices=["today", "all"], 
                       help="Upload mode: 'today' (only today's files) or 'all' (including history)")
    args = parser.parse_args()

    syncer = FastGPTSyncer()
    
    # 设置全局过滤模式
    global UPLOAD_FILTER_MODE
    UPLOAD_FILTER_MODE = args.mode

    if args.once:
        syncer.sync_once()
    elif args.daemon:
        print(f"[{datetime.now()}] Scheduler started. Sync time: {DAILY_SYNC_TIME}, Timezone: {TIMEZONE}")
        scheduler = BlockingScheduler(timezone=TIMEZONE)
        hour, minute = DAILY_SYNC_TIME.split(":")
        scheduler.add_job(syncer.sync_once, CronTrigger(hour=hour, minute=minute))
        try:
            scheduler.start()
        except (KeyboardInterrupt, SystemExit):
            pass
    else:
        parser.print_help()

if __name__ == "__main__":
    main()
