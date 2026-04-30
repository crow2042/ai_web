import base64
import hashlib
import http.cookies
import http.server
import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
DATA_DIR = ROOT / "data"
CONFIG_FILE = DATA_DIR / "config.json"
LOG_FILE = DATA_DIR / "generations.jsonl"
PORT = int(os.environ.get("PORT", "3000"))

sessions = {}
lock = threading.RLock()


def hash_password(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 120000).hex()


def ensure_data():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not CONFIG_FILE.exists():
        salt = secrets.token_hex(16)
        CONFIG_FILE.write_text(
            json.dumps(
                {
                    "admin": {
                        "username": "admin",
                        "salt": salt,
                        "hash": hash_password("1596357", salt),
                    },
                    "apis": [],
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )


def read_config():
    ensure_data()
    with lock:
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))


def save_config(config):
    with lock:
        CONFIG_FILE.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")


def append_log(entry):
    with lock:
        with LOG_FILE.open("a", encoding="utf-8") as file:
            file.write(json.dumps(entry, ensure_ascii=False) + "\n")


def public_apis(config):
    return [
        {
            "id": api["id"],
            "name": api["name"],
            "model": api["model"],
            "size": api.get("size", "1024x1024"),
        }
        for api in config.get("apis", [])
        if api.get("enabled", True)
    ]


def sanitize_api(api):
    return {
        "id": api.get("id") or secrets.token_hex(16),
        "name": str(api.get("name", "")).strip(),
        "model": str(api.get("model", "")).strip(),
        "endpoint": str(api.get("endpoint", "")).strip(),
        "apiKey": str(api.get("apiKey", "")).strip(),
        "size": str(api.get("size", "1024x1024")).strip(),
        "enabled": api.get("enabled", True) is not False,
    }


def validate_api(api):
    if not api["name"]:
        return "模型显示名称不能为空"
    if not api["model"]:
        return "模型 ID 不能为空"
    if not api["endpoint"]:
        return "API 地址不能为空"
    if not api["apiKey"]:
        return "API Key 不能为空"
    return ""


def extract_image(payload):
    first = payload.get("data", [None])[0] if isinstance(payload.get("data"), list) else None
    if isinstance(first, dict) and first.get("b64_json"):
        return "data:image/png;base64," + first["b64_json"]
    if isinstance(first, dict) and first.get("url"):
        return first["url"]
    if payload.get("image"):
        return payload["image"]
    if payload.get("url"):
        return payload["url"]
    if payload.get("b64_json"):
        return "data:image/png;base64," + payload["b64_json"]
    return ""


def call_image_api(api, prompt, reference):
    body = {
        "model": api["model"],
        "prompt": prompt,
        "n": 1,
        "size": api.get("size", "1024x1024"),
        "response_format": "url",
        "stream": False,
        "watermark": True,
        "sequential_image_generation": "disabled",
    }
    if reference:
        body["image"] = reference

    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        api["endpoint"],
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + api["apiKey"],
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as response:
            text = response.read().decode("utf-8")
            payload = json.loads(text) if text else {}
    except urllib.error.HTTPError as error:
        text = error.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(text)
            detail = payload.get("error", {}).get("message") or payload.get("message") or text
        except json.JSONDecodeError:
            detail = text or f"HTTP {error.code}"
        raise RuntimeError(detail)
    except urllib.error.URLError as error:
        raise RuntimeError(str(error.reason))

    image = extract_image(payload)
    if not image:
        raise RuntimeError("API 返回成功，但未找到图片 URL 或 base64 图片字段")
    return image


class Handler(http.server.SimpleHTTPRequestHandler):
    server_version = "AIImageAdmin/1.0"

    def translate_path(self, path):
        parsed = urllib.parse.urlparse(path)
        clean = urllib.parse.unquote(parsed.path)
        if clean == "/":
            clean = "/index.html"
        target = (PUBLIC_DIR / clean.lstrip("/")).resolve()
        if not str(target).startswith(str(PUBLIC_DIR.resolve())):
            return str(PUBLIC_DIR / "index.html")
        return str(target)

    def json_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 4 * 1024 * 1024:
            raise ValueError("请求体过大")
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def send_json(self, status, payload, headers=None):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def cookie_value(self, name):
        raw = self.headers.get("Cookie", "")
        cookies = http.cookies.SimpleCookie(raw)
        return cookies[name].value if name in cookies else ""

    def is_authed(self):
        token = self.cookie_value("admin_session")
        return bool(token and sessions.get(token, 0) > time.time())

    def require_admin(self):
        if self.is_authed():
            return True
        self.send_json(401, {"error": "请先登录管理员账号"})
        return False

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/models":
            self.send_json(200, {"models": public_apis(read_config())})
            return
        if parsed.path == "/api/admin/config":
            if not self.require_admin():
                return
            config = read_config()
            apis = []
            for api in config.get("apis", []):
                masked = dict(api)
                masked["apiKey"] = "********" if masked.get("apiKey") else ""
                apis.append(masked)
            self.send_json(200, {"username": config["admin"]["username"], "apis": apis})
            return
        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        try:
            body = self.json_body()
            if parsed.path == "/api/generate":
                self.generate(body)
            elif parsed.path == "/api/admin/login":
                self.login(body)
            elif parsed.path == "/api/admin/logout":
                token = self.cookie_value("admin_session")
                sessions.pop(token, None)
                self.send_json(200, {"ok": True}, {"Set-Cookie": "admin_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"})
            elif parsed.path == "/api/admin/apis":
                self.save_api(body)
            elif parsed.path == "/api/admin/password":
                self.change_password(body)
            else:
                self.send_error(404)
        except json.JSONDecodeError:
            self.send_json(400, {"error": "JSON 格式不正确"})
        except Exception as error:
            self.send_json(500, {"error": str(error)})

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/admin/apis/"):
            if not self.require_admin():
                return
            api_id = urllib.parse.unquote(parsed.path.rsplit("/", 1)[-1])
            config = read_config()
            config["apis"] = [api for api in config.get("apis", []) if api.get("id") != api_id]
            save_config(config)
            self.send_json(200, {"ok": True})
            return
        self.send_error(404)

    def generate(self, body):
        visitor = str(body.get("visitor", "")).strip()
        prompt = str(body.get("prompt", "")).strip()
        model_id = str(body.get("modelId", "")).strip()
        reference = str(body.get("reference", "")).strip()
        if not visitor:
            self.send_json(400, {"error": "请先填写访问者身份"})
            return
        if not prompt:
            self.send_json(400, {"error": "Prompt 不能为空"})
            return

        config = read_config()
        api = next((item for item in config.get("apis", []) if item.get("id") == model_id and item.get("enabled", True)), None)
        if not api:
            self.send_json(400, {"error": "请选择可用的生图模型"})
            return

        started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        try:
            image = call_image_api(api, prompt, reference)
            append_log({"time": started_at, "visitor": visitor, "model": api["name"], "modelId": api["id"], "prompt": prompt, "reference": reference, "status": "success"})
            self.send_json(200, {"image": image})
        except Exception as error:
            append_log({"time": started_at, "visitor": visitor, "model": api["name"], "modelId": api["id"], "prompt": prompt, "reference": reference, "status": "failed", "error": str(error)})
            self.send_json(502, {"error": str(error)})

    def login(self, body):
        config = read_config()
        admin = config["admin"]
        ok = body.get("username") == admin["username"] and hash_password(str(body.get("password", "")), admin["salt"]) == admin["hash"]
        if not ok:
            self.send_json(401, {"error": "管理员账号或密码错误"})
            return
        token = secrets.token_hex(32)
        sessions[token] = time.time() + 8 * 60 * 60
        self.send_json(200, {"ok": True}, {"Set-Cookie": f"admin_session={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800"})

    def save_api(self, body):
        if not self.require_admin():
            return
        config = read_config()
        incoming = sanitize_api(body)
        current = next((api for api in config.get("apis", []) if api.get("id") == incoming["id"]), None)
        if incoming["apiKey"] == "********" and current:
            incoming["apiKey"] = current["apiKey"]
        problem = validate_api(incoming)
        if problem:
            self.send_json(400, {"error": problem})
            return
        apis = config.setdefault("apis", [])
        for index, api in enumerate(apis):
            if api.get("id") == incoming["id"]:
                apis[index] = incoming
                break
        else:
            apis.append(incoming)
        save_config(config)
        masked = dict(incoming)
        masked["apiKey"] = "********"
        self.send_json(200, {"ok": True, "api": masked})

    def change_password(self, body):
        if not self.require_admin():
            return
        config = read_config()
        admin = config["admin"]
        old_ok = body.get("currentUsername") == admin["username"] and hash_password(str(body.get("currentPassword", "")), admin["salt"]) == admin["hash"]
        if not old_ok:
            self.send_json(401, {"error": "当前管理员账号或密码错误"})
            return
        next_username = str(body.get("nextUsername", "")).strip()
        next_password = str(body.get("nextPassword", ""))
        if not next_username or len(next_password) < 6:
            self.send_json(400, {"error": "新账号不能为空，新密码至少 6 位"})
            return
        salt = secrets.token_hex(16)
        config["admin"] = {"username": next_username, "salt": salt, "hash": hash_password(next_password, salt)}
        save_config(config)
        self.send_json(200, {"ok": True})


if __name__ == "__main__":
    ensure_data()
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"AI image admin site running at http://0.0.0.0:{PORT}")
    httpd.serve_forever()
