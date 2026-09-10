import os, base64, json, ssl, time, urllib.request, urllib.error, urllib.parse, sys

TOKEN = os.environ.get("GH_PAT")
if not TOKEN:
    sys.exit("GH_PAT not set")
REPO = "cybercancel/xiaojun-meihz-collection-miniprogram"
ROOT = r"F:/中转站/毕设/Ai毕设/_thesis_source_export"
API = "https://api.github.com"

# 走沙箱代理（curl 实证可 PUT/POST）
os.environ["HTTPS_PROXY"] = "http://127.0.0.1:59942"
os.environ["HTTP_PROXY"] = "http://127.0.0.1:59942"
ctx = ssl._create_unverified_context()

def collect():
    out = []
    for dp, dn, fns in os.walk(ROOT):
        parts = set(dp.split(os.sep))
        if parts & {".git", "node_modules", "论文素材", "交接文档"}:
            continue
        for fn in fns:
            if fn in {"截图采集清单.md"} or fn.lower().endswith((".pem", ".p12", ".pfx", ".key")):
                continue
            full = os.path.join(dp, fn)
            rel = os.path.relpath(full, ROOT).replace(os.sep, "/")
            out.append((rel, full))
    return sorted(out)

def api(method, url, data=None, retries=6):
    last = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, data=data, method=method)
            req.add_header("Authorization", "Bearer " + TOKEN)
            req.add_header("Accept", "application/vnd.github+json")
            req.add_header("Content-Type", "application/json")
            req.add_header("User-Agent", "thesis-push")
            with urllib.request.urlopen(req, timeout=90, context=ctx) as r:
                return r.read().decode(), r.status
        except (urllib.error.HTTPError, urllib.error.URLError, OSError) as e:
            last = e
            code = getattr(e, "code", None)
            # 409 内容冲突(文件已存在)直接当成功跳过
            if code == 409 and method == "PUT":
                return '{"skip":true}', 200
            sys.stderr.write(f"  retry {attempt}/{retries} {method} -> {code or e}\n")
            if attempt < retries:
                time.sleep(min(10, 2 ** attempt))
    raise last

files = collect()
print(f"collected {len(files)} files", flush=True)

ok = 0
for i, (rel, full) in enumerate(files, 1):
    with open(full, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    url = f"{API}/repos/{REPO}/contents/{urllib.parse.quote(rel)}"
    api("PUT", url, json.dumps({"message": f"add {rel}", "content": b64}).encode())
    ok += 1
    if i % 50 == 0:
        print(f"  pushed {i}/{len(files)}", flush=True)
print(f"pushed {ok}/{len(files)}", flush=True)

# 清理探针文件
try:
    body, _ = api("GET", f"{API}/repos/{REPO}/contents/.init_probe.txt")
    sha = json.loads(body)["sha"]
    api("DELETE", f"{API}/repos/{REPO}/contents/.init_probe.txt",
        json.dumps({"message": "cleanup probe", "sha": sha}).encode())
    print("probe removed", flush=True)
except Exception as e:
    print("probe cleanup skipped:", e, flush=True)

print("DONE", flush=True)
