"""Run one Codex turn over the host user's private App Server WebSocket."""
import base64
import hashlib
import json
import os
from pathlib import Path
import socket
import struct
import sys
import time
import uuid
import queue
import threading
from collections import deque

LIMIT = 16 * 1024 * 1024

def desktop_recent_models():
    home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    try:
        state = json.loads((home / ".codex-global-state.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(state, dict):
        return []
    owner = state.get("electron-renderer-content-owner")
    scope = "electron-owner-atoms:" + owner if isinstance(owner, str) else "electron-persisted-atom-state"
    atoms = state.get(scope)
    records = atoms.get("composer-recent-model-configurations-v1") if isinstance(atoms, dict) else None
    if not isinstance(records, list):
        return []
    result = []
    for item in records:
        if not isinstance(item, dict) or not isinstance(item.get("model"), str):
            continue
        effort, tier = item.get("reasoningEffort"), item.get("serviceTier")
        if any(value is not None and not isinstance(value, str) for value in (effort, tier)):
            continue
        result.append({"model": item["model"], "effort": effort, "tier": tier})
        if len(result) == 3:
            break
    return result


def turn_duration(turn):
    duration = turn.get("durationMs")
    if type(duration) is int and duration >= 0:
        return duration
    start, end = turn.get("startedAt"), turn.get("completedAt")
    if type(start) is int and type(end) is int and end >= start:
        return (end-start)*1000

def tool_record(item):
    dynamic = item["type"] == "dynamicToolCall"
    content = item.get("contentItems") if dynamic else (item.get("result") or {}).get("content")
    chunks = []
    for block in content or []:
        if not isinstance(block,dict) or block.get("type") != ("inputText" if dynamic else "text"):
            continue
        audience = (block.get("annotations") or {}).get("audience")
        if audience is not None and "user" not in audience:
            continue
        if isinstance(block.get("text"),str) and block["text"]:
            chunks.append(block["text"])
    error = (item.get("error") or {}).get("message")
    if isinstance(error,str) and error: chunks.append(error)
    text = "\n\n".join(chunks)
    return {"id":item["id"],"type":item["type"],"title":item.get("tool") or "工具调用",
            "source":item.get("namespace" if dynamic else "server"),"status":item.get("status"),
            "output":text[-16384:],"truncated":len(text)>16384,"durationMs":item.get("durationMs")}

class Connection:
    def __init__(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(30)
        self.sock.connect(str(Path.home() / ".codex/app-server-control/app-server-control.sock"))
        self.reader = self.sock.makefile("rb")
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(("GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n"
                           "Connection: Upgrade\r\nSec-WebSocket-Key: " + key +
                           "\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        if b" 101 " not in self.reader.readline(8192):
            raise RuntimeError("主机 daemon 拒绝了 WebSocket 握手")
        headers = {}
        while (line := self.reader.readline(8192).strip()):
            name, value = line.split(b":", 1)
            headers[name.lower()] = value.strip()
        expected = hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
        if headers.get(b"sec-websocket-accept") != base64.b64encode(expected):
            raise RuntimeError("WebSocket 握手校验失败")
        self.sequence = 0
        self.send_lock = threading.Lock()
        self.notifications = deque()
        self.call("initialize", {"clientInfo":{"name":"codex-window","version":"1"},
                                 "capabilities":{"experimentalApi":True}})
        self.json_send({"method":"initialized","params":{}})
        self.sock.settimeout(None)

    def frame(self, opcode, data):
        length = len(data)
        if length < 126:
            header = bytes([128 + length])
        elif length < 65536:
            header = b"\xfe" + struct.pack(">H", length)
        else:
            header = b"\xff" + struct.pack(">Q", length)
        mask = os.urandom(4)
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        with self.send_lock:
            self.sock.sendall(bytes([128 + opcode]) + header + mask + payload)

    def json_send(self, value):
        self.frame(1, json.dumps(value, ensure_ascii=False).encode())

    def read_exact(self, n):
        data = self.reader.read(n)
        if len(data) != n:
            raise EOFError("App Server 连接已关闭")
        return data

    def receive(self):
        data = bytearray()
        while True:
            flags, length = self.read_exact(2)
            opcode = flags & 15
            if length & 128 or flags & 112:
                raise RuntimeError("无效的主机 WebSocket 帧")
            if length == 126: length = struct.unpack(">H", self.read_exact(2))[0]
            elif length == 127: length = struct.unpack(">Q", self.read_exact(8))[0]
            if len(data) + length > LIMIT: raise RuntimeError("主机帧超过大小限制")
            payload = self.read_exact(length)
            if opcode == 8: raise EOFError("App Server 已断开")
            if opcode == 9:
                self.frame(10, payload)
                continue
            if opcode == 10: continue
            if opcode not in (0,1): raise RuntimeError("不支持的主机帧")
            data.extend(payload)
            if flags & 128: return json.loads(data)

    def call(self, method, params):
        self.sequence += 1
        self.json_send({"id":self.sequence,"method":method,"params":params})
        while True:
            msg = self.receive()
            if "method" in msg:
                self.notifications.append(msg)
            elif msg.get("id") == self.sequence:
                if "error" in msg: raise ValueError(msg["error"]["message"])
                return msg["result"]

def emit(kind, **values):
    print(json.dumps({"type":kind, **values}, ensure_ascii=False), flush=True)

def wait_for_voice_stop(directory, lease_seconds=45):
    """Return the stop reason even if the receiver disappears without hanging up."""
    lease = directory / "heartbeat"
    stop = directory / "stop"
    last_stamp = None
    deadline = time.monotonic() + lease_seconds
    while True:
        if stop.exists():
            return "client"
        try:
            stamp = lease.stat().st_mtime_ns
        except FileNotFoundError:
            stamp = None
        now = time.monotonic()
        if stamp is not None and stamp != last_stamp:
            last_stamp = stamp
            deadline = now + lease_seconds
        if now >= deadline:
            return "lease expired"
        time.sleep(min(0.25, deadline - now))


def run_voice_session(client, thread, directory, request):
    offer = request["sdp"]
    if not isinstance(offer, str) or not offer.startswith("v=0") or len(offer) > 65536:
        raise ValueError("无效的 WebRTC 提议")
    client.sock.settimeout(25)
    if thread == "-":
        setup = request["setup"]
        params = {"sandbox": setup["sandbox"], "approvalPolicy": setup["approvalPolicy"],
                  "cwd": setup.get("cwd") or str(Path.home())}
        for key in ("projectId", "model", "serviceTier"):
            if setup.get(key): params[key] = setup[key]
        if setup.get("effort"): params["config"] = {"model_reasoning_effort": setup["effort"]}
        thread = client.call("thread/start", params)["thread"]["id"]
    else:
        thread = str(uuid.UUID(thread))
        client.call("thread/resume", {"threadId": thread, "excludeTurns": True})
    emit("voice.thread", thread=thread)
    client.call("thread/realtime/start", {
        "threadId": thread, "version": "v3", "outputModality": "audio",
        "transport": {"type": "webrtc", "sdp": offer}
    })

    def next_voice_event(deadline):
        while time.monotonic() < deadline:
            client.sock.settimeout(max(0.1, deadline - time.monotonic()))
            event = client.notifications.popleft() if client.notifications else client.receive()
            if event.get("params", {}).get("threadId") == thread:
                return event
        raise TimeoutError("等待主机实时语音事件超时")

    closed = False
    try:
        deadline = time.monotonic() + 25
        while True:
            event = next_voice_event(deadline)
            method = event.get("method")
            if method == "thread/realtime/closed":
                closed = True
                emit("voice.closed", reason="host")
                return
            if method == "thread/realtime/error":
                raise RuntimeError("主机未能启动实时语音")
            if method == "thread/realtime/sdp":
                emit("voice.answer", sdp=event["params"]["sdp"])
                break
        reason = wait_for_voice_stop(directory)
    finally:
        if not closed:
            client.sock.settimeout(20)
            client.call("thread/realtime/stop", {"threadId": thread})
            deadline = time.monotonic() + 20
            while next_voice_event(deadline).get("method") != "thread/realtime/closed":
                pass
    emit("voice.closed", reason=reason)


def file_preview(rows):
    valid = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict) or not isinstance(row.get("path"), str) or not row["path"]:
            continue
        kind = row.get("kind")
        if not isinstance(kind, dict) or kind.get("type") not in ("add", "delete", "update"):
            continue
        diff = row.get("diff")
        if not isinstance(diff, str):
            continue
        if kind["type"] == "update" and not diff and not kind.get("move_path"):
            continue
        valid.append(row)
    return valid, bool(valid) and len(valid) == len(rows)


def turn_events(client, thread, turn):
    """Keep reading host events while the user considers a question."""
    inbox = queue.Queue()
    pending = {}
    patches = {}
    file_requests = {}
    def resolve(token):
        del pending[token]
        file_requests.pop(token, None)
        emit("input.resolved", token=token)

    def offer(request_id, params, file_change):
        decisions = {"拒绝":"decline", "取消本轮":"cancel", "仅允许本次":"accept"}
        if file_change:
            changes, complete = file_preview(patches.get(params.get("itemId")))
            if not complete:
                decisions.pop("仅允许本次")
            review = {"fileReview":params, "changes":changes, "complete":complete}
        else:
            review = {"commandReview":params}
        offered = params.get("availableDecisions")
        if isinstance(offered, list):
            decisions = {k:v for k,v in decisions.items() if v in offered}
        if not decisions:
            return False
        token = str(uuid.uuid4())
        pending[token] = (request_id, decisions)
        if file_change:
            file_requests[token] = params
        question = {"id":"decision","question":"是否允许本次文件修改？" if file_change else "是否允许运行这条命令？",
                    **review, "options":[{"label":k} for k in decisions]}
        emit("input.requested", token=token, questions=[question])
        return True

    def update_patch(item_id, rows, completed=False):
        if not completed and rows == patches.get(item_id):
            return
        if completed:
            patches.pop(item_id, None)
        else:
            patches[item_id] = rows
        for token, params in list(file_requests.items()):
            if params.get("itemId") == item_id:
                request_id = pending[token][0]
                resolve(token)
                if not completed:
                    offer(request_id, params, True)

    directory = Path(__file__).parent
    def receive():
        try:
            while True:
                inbox.put(client.notifications.popleft() if client.notifications else client.receive())
        except Exception as error:
            inbox.put(error)
    threading.Thread(target=receive, daemon=True).start()
    while True:
        for token, (request_id, decisions) in list(pending.items()):
            if token in file_requests and not inbox.empty():
                continue
            path = directory / ("answer-" + token)
            if path.exists():
                answers = json.loads(path.read_text(encoding="utf8"))
                if decisions is None:
                    result = {"answers":answers}
                else:
                    label = answers["decision"]["answers"][0]
                    result = {"decision":decisions[label]}
                client.json_send({"id":request_id, "result":result})
                path.write_bytes(b"")
                resolve(token)
        try: event = inbox.get(timeout=0.2 if pending else None)
        except queue.Empty: continue
        if isinstance(event, Exception): raise event
        method, params = event.get("method"), event.get("params", {})
        if method == "item/tool/requestUserInput" and "id" in event and params.get("threadId")==thread and params.get("turnId")==turn:
            questions = params.get("questions", [])
            if any(q.get("isSecret") for q in questions):
                client.json_send({"id":event["id"],"error":{"code":-32601,
                    "message":"This remote client cannot collect secret answers. Use a local secure input flow."}})
                continue
            if questions:
                token = str(uuid.uuid4())
                pending[token] = (event["id"], None)
                emit("input.requested", token=token, questions=questions)
                continue
        owned = params.get("threadId")==thread and params.get("turnId")==turn
        if owned and method in ("item/started","item/completed"):
            item = params.get("item") or {}
            if item.get("type")=="fileChange" and item.get("id"):
                update_patch(item["id"], item.get("changes"), method=="item/completed")
        if owned and method=="item/fileChange/patchUpdated" and params.get("itemId"):
            update_patch(params["itemId"], params.get("changes"))
        command = (method=="item/commandExecution/requestApproval" and
                   params.get("kind","command")=="command" and params.get("command"))
        file_change = method=="item/fileChange/requestApproval"
        if owned and "id" in event and (command or file_change):
            if offer(event["id"], params, file_change):
                continue
        if method == "serverRequest/resolved" and params.get("threadId")==thread:
            for token, (request_id, decisions) in list(pending.items()):
                if request_id == params.get("requestId"):
                    resolve(token)
        yield event

def change_goal(client, thread, expected, update, setup, progress):
    if thread is None:
        params = {k:setup[k] for k in ("cwd", "model", "projectId", "sandbox", "approvalPolicy") if setup.get(k)}
        params.setdefault("cwd", str(Path.home()))
        progress["sending"] = True
        opened = client.call("thread/start", params)["thread"]
        thread, cwd = opened["id"], opened["cwd"]
        progress.update(thread=thread, sending=False)
    else:
        cwd = None
    goal = client.call("thread/goal/get", {"threadId":thread})["goal"]
    if (expected is None and goal is not None) or (expected is not None and
            (goal is None or any(goal.get(k) != v for k, v in expected.items()))):
        return {"conflict":True, "thread":thread, "goal":goal}
    if setup:
        if cwd is None:
            opened = client.call("thread/resume", {"threadId":thread, "excludeTurns":True})["thread"]
            cwd = opened["cwd"]
        sandbox = setup["sandbox"]
        policy = {"type":"readOnly","networkAccess":False}
        if sandbox == "workspace-write":
            policy = {"type":"workspaceWrite","writableRoots":[],"networkAccess":False,
                      "excludeTmpdirEnvVar":True,"excludeSlashTmp":True}
        elif sandbox == "danger-full-access":
            policy = {"type":"dangerFullAccess"}
        settings = {k:setup[k] for k in ("model", "effort", "approvalPolicy", "approvalsReviewer") if setup.get(k)}
        if setup.get("serviceTier"):
            settings["serviceTier"] = None if setup["serviceTier"] == "default" else setup["serviceTier"]
        client.call("thread/settings/update", {"threadId":thread, "sandboxPolicy":policy, **settings})
    if update.get("clear"):
        cleared = client.call("thread/goal/clear", {"threadId":thread, "origin":"user"})
        if not cleared["cleared"]:
            return {"conflict":True, "thread":thread, "goal":client.call("thread/goal/get", {"threadId":thread})["goal"]}
        goal = None
    else:
        progress["sending"] = True
        goal = client.call("thread/goal/set", {"threadId":thread, "origin":"user", **update})["goal"]
    return {"goal":goal, "thread":thread, "cwd":cwd}


def expire_upload_receipts(cache, now):
    """Clean abandoned chunks when the host next receives a file."""
    import fcntl
    import stat
    from contextlib import ExitStack
    flags = os.O_NOFOLLOW | os.O_RDONLY | os.O_DIRECTORY
    with ExitStack() as handles:
        cache_fd = os.open(cache, flags)
        handles.callback(os.close, cache_fd)
        sweep = os.open("uploads-cleanup", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=cache_fd)
        handles.callback(os.close, sweep)
        try:
            fcntl.flock(sweep, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        if os.fstat(sweep).st_size and now-os.fstat(sweep).st_mtime < 60:
            return
        os.pwrite(sweep, b"1", 0)
        for name in os.listdir(cache_fd):
            if not name.startswith("upload-") or not name.endswith(".json"):
                continue
            try:
                upload_id = str(uuid.UUID(name[7:-5]))
                with ExitStack() as entry:
                    def open_checked(path, options, parent=None):
                        fd = os.open(path, options | os.O_NOFOLLOW, dir_fd=parent)
                        entry.callback(os.close, fd)
                        return fd
                    receipt = open_checked(name, os.O_RDONLY, cache_fd)
                    fcntl.flock(receipt, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    if now-os.fstat(receipt).st_mtime < 15*60:
                        continue
                    metadata = json.loads(os.read(receipt, 8192))
                    root, _, filename, size = metadata["scope"]
                    root_fd = open_checked(root, flags)
                    root_stat = os.fstat(root_fd)
                    if metadata["rootIdentity"] != [root_stat.st_dev, root_stat.st_ino]:
                        continue
                    folder = ".codex-upload-"+upload_id
                    folder_fd = open_checked(folder, flags, root_fd)
                    file = open_checked(filename, os.O_RDWR | os.O_NONBLOCK, folder_fd)
                    directory, info = os.fstat(folder_fd), os.fstat(file)
                    if metadata["identity"] != [directory.st_dev, directory.st_ino, info.st_dev, info.st_ino]:
                        continue
                    if stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size < size:
                        os.ftruncate(file, 0)
                        os.unlink(filename, dir_fd=folder_fd)
                        os.rmdir(folder, dir_fd=root_fd)
                    os.unlink(name, dir_fd=cache_fd)
            except (OSError, ValueError, KeyError):
                # Leave active or replaced entries alone.
                continue


def upload_attachment(client, args):
    import fcntl
    import re
    import stat
    from contextlib import ExitStack
    name, total, offset = args["name"], args["total"], args["offset"]
    if (not isinstance(name, str) or not name or len(name.encode("utf-8")) > 180 or
            re.search(r'[<>:"/\\|?*\x00-\x1f\x7f]', name) or name.endswith((".", " ")) or
            re.match(r"^(con|prn|aux|nul|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(\.|$)", name, re.I)):
        raise ValueError("文件名无效")
    if type(total) is not int or not 0 <= total <= 64*1024*1024 or type(offset) is not int or not 0 <= offset <= total:
        raise ValueError("文件大小或分块位置无效")
    data = base64.b64decode(args["data"], validate=True)
    if len(data) > 128*1024 or offset+len(data) > total or (not data and total):
        raise ValueError("附件分块无效")
    upload_id = str(uuid.UUID(args["id"]))
    thread = args.get("threadId")
    if thread:
        thread = str(uuid.UUID(thread))
        record = client.call("thread/read", {"threadId":thread, "includeTurns":False})["thread"]
        if record["id"] != thread:
            raise ValueError("主机会话不匹配")
        root = record["cwd"]
    else:
        root = args["cwd"]
        cursor = None
        while True:
            page = client.call("project/list", {"limit":100, **({"cursor":cursor} if cursor else {})})
            if any(path["path"] == root for project in page["data"] for path in project["roots"]):
                break
            cursor = page.get("nextCursor")
            if not cursor:
                raise ValueError("请选择已登记的主机项目")
    root = os.path.realpath(root)
    folder = ".codex-upload-"+upload_id
    cache = os.path.dirname(os.path.realpath(__file__))
    expire_upload_receipts(cache, time.time())
    nofollow = os.O_NOFOLLOW
    directories = os.O_RDONLY | os.O_DIRECTORY | nofollow
    with ExitStack() as handles:
        def open_fd(path, flags, directory=None):
            fd = os.open(path, flags, 0o600, dir_fd=directory)
            handles.callback(os.close, fd)
            return fd
        root_fd = open_fd(root, directories)
        root_stat = os.fstat(root_fd)
        root_identity = [root_stat.st_dev, root_stat.st_ino]
        cache_fd = open_fd(cache, directories)
        receipt = open_fd("upload-"+upload_id+".json", os.O_RDWR | os.O_CREAT | nofollow, cache_fd)
        fcntl.flock(receipt, fcntl.LOCK_EX)
        raw = os.read(receipt, 8192)
        metadata = json.loads(raw) if raw else None
        scope = [root, thread, name, total]
        if metadata is None:
            if offset:
                raise ValueError("需要从头上传文件")
            os.mkdir(folder, 0o700, dir_fd=root_fd)
        elif metadata["scope"] != scope or metadata.get("rootIdentity") != root_identity:
            raise ValueError("附件目标已变化")
        directory = open_fd(folder, directories, root_fd)
        file = open_fd(name, os.O_RDWR | nofollow | os.O_NONBLOCK |
                       (os.O_CREAT | os.O_EXCL if metadata is None else 0), directory)
        directory_info, info = os.fstat(directory), os.fstat(file)
        identity = [directory_info.st_dev, directory_info.st_ino, info.st_dev, info.st_ino]
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or (metadata and metadata["identity"] != identity):
            raise ValueError("附件存储位置已变化")
        if metadata is None:
            raw = json.dumps({"scope":scope, "identity":identity, "rootIdentity":root_identity}, ensure_ascii=False).encode("utf-8")
            os.write(receipt, raw)
            os.fsync(receipt)
        current = info.st_size
        if current > total or offset > current:
            raise ValueError("附件分块位置不匹配")
        overlap = min(len(data), current-offset)
        if overlap and os.pread(file, overlap, offset) != data[:overlap]:
            raise ValueError("重传的附件内容不一致")
        written = overlap
        while written < len(data):
            count = os.pwrite(file, data[written:], offset+written)
            if count == 0:
                raise OSError("附件写入失败")
            written += count
        size = os.fstat(file).st_size
        os.utime(receipt, None)
        if size < total:
            return {"complete":False, "offset":size}
        os.fsync(file)
        path = os.path.join(root, folder, name)
        visible = os.stat(path, follow_symlinks=False)
        if os.path.realpath(path) != path or (visible.st_dev, visible.st_ino) != (info.st_dev, info.st_ino):
            raise ValueError("附件存储位置已变化")
        return {"complete":True, "offset":size, "size":total, "path":path, "name":name, "root":root}


def main():
    connecting = time.monotonic_ns()
    client = Connection()
    connected = time.monotonic_ns()
    try:
        if sys.argv[1] == "--upload-attachment":
            raw = sys.stdin.buffer.read(256*1024+1)
            if len(raw) > 256*1024:
                raise ValueError("附件分块过长")
            args = json.loads(base64.b64decode(raw))
            print(json.dumps(upload_attachment(client, args), ensure_ascii=False))
            return
        if sys.argv[1] == "--voice":
            run_voice_session(client, sys.argv[2], Path(sys.argv[3]), json.load(sys.stdin))
            return
        if sys.argv[1] == "--observe":
            thread = str(uuid.UUID(sys.argv[2]))
            client.call("thread/resume", {"threadId":thread, "excludeTurns":True})
            print("READY", flush=True)
            last_update = 0
            while True:
                event = client.notifications.popleft() if client.notifications else client.receive()
                if "id" in event or event.get("params", {}).get("threadId") != thread:
                    continue
                method = event.get("method", "")
                params = event["params"]
                item = params.get("item") or {}
                if method == "item/started" and item.get("type") == "agentMessage":
                    print("TEXT "+json.dumps([params.get("turnId"), item.get("id"), None]), flush=True)
                if method == "item/agentMessage/delta" and isinstance(params.get("delta"), str):
                    delta = params["delta"]
                    for offset in range(0, len(delta), 512):
                        print("TEXT "+json.dumps([params.get("turnId"), params.get("itemId"), delta[offset:offset+512]]), flush=True)
                now = time.monotonic()
                if method in ("turn/started", "turn/completed", "thread/status/changed", "serverRequest/resolved",
                              "thread/goal/updated", "thread/goal/cleared") or (
                    method.startswith("item/") and now - last_update >= 1
                ):
                    print("CHANGED", flush=True)
                    last_update = now
        if sys.argv[1] == "--usage":
            result = client.call("account/rateLimits/read", {})
            buckets = result.get("rateLimitsByLimitId") or {"codex":result.get("rateLimits")}
            groups = []
            for key, bucket in buckets.items():
                if not bucket: continue
                windows = []
                for name in ("primary","secondary"):
                    window = bucket.get(name)
                    if window and isinstance(window.get("usedPercent"), (int,float)):
                        windows.append({k:window.get(k) for k in ("usedPercent","windowDurationMins","resetsAt")})
                if windows: groups.append({"name":bucket.get("limitName") or key,"windows":windows})
            print(json.dumps({"groups":groups}))
            return
        if sys.argv[1] == "--edit-goal":
            thread = None if sys.argv[2] == "-" else str(uuid.UUID(sys.argv[2]))
            change = json.loads(Path(sys.argv[3]).read_bytes())
            progress = {"thread":thread, "sending":False}
            try:
                result = change_goal(client, thread, change["expected"], change["update"], change.get("setup"), progress)
            except (ValueError, OSError, RuntimeError, EOFError) as exc:
                result = {"goalError":str(exc)[:350], "thread":progress["thread"],
                          "retryable":isinstance(exc, ValueError) or not progress["sending"]}
            print(json.dumps(result))
            return
        if sys.argv[1] == "--active-threads":
            cursor = None
            items = {}
            while True:
                params = {"limit":50}
                if cursor: params["cursor"] = cursor
                page = client.call("thread/loaded/list", params)
                for thread_id in page["data"]:
                    try:
                        reply = client.call("thread/read", {"threadId":thread_id,"includeTurns":False})
                        record = reply["thread"]
                    except ValueError as exc:
                        if any(s in str(exc).lower() for s in ("not found","no rollout","not loaded")): continue
                        raise
                    state = record.get("status") or {}
                    read_state = reply.get("readState") or {}
                    unread = read_state.get("firstUnread") is not None
                    if state.get("type") == "active" or unread:
                        items[thread_id] = {"thread":thread_id,"title":(record.get("name") or record.get("preview") or "执行中的任务")[:85],
                                            "cwd":record.get("cwd"),"updated":record.get("updatedAt",0),
                                            "active":state.get("type")=="active","flags":state.get("activeFlags",[]),"unread":unread}
                cursor = page.get("nextCursor")
                if not cursor: break
            # Idle threads can be unloaded while their first unread position persists.
            params = {"limit":100,"archived":False,"useStateDbOnly":True,"modelProviders":[]}
            cursors = set()
            while True:
                page = client.call("thread/list", params)
                states = page.get("readStates") or {}
                for record in page["data"]:
                    thread_id = record["id"]
                    if thread_id in items or not (states.get(thread_id) or {}).get("firstUnread"):
                        continue
                    items[thread_id] = {"thread":thread_id,"title":(record.get("name") or record.get("preview") or "未命名任务")[:85],
                                        "cwd":record.get("cwd"),"updated":record.get("updatedAt",0),
                                        "active":False,"flags":[],"unread":True}
                cursor = page.get("nextCursor")
                if not cursor: break
                if cursor in cursors: raise ValueError("主机返回了重复的活动目录游标")
                cursors.add(cursor)
                params["cursor"] = cursor
            print(json.dumps({"items":sorted(items.values(),key=lambda item:item["updated"],reverse=True)}))
            return
        if sys.argv[1] == "--activity":
            thread_id = str(uuid.UUID(sys.argv[2]))
            record = client.call("thread/read", {"threadId":thread_id,"includeTurns":False})["thread"]
            if record["id"] != thread_id: raise ValueError("会话 ID 不一致")
            try:
                page = client.call("thread/turns/list", {"threadId":thread_id, "limit":1,
                                   "sortDirection":"desc", "itemsView":"notLoaded"})
                last = next(iter(page["data"]), {})
            except ValueError as error:
                if not any(term in str(error).lower() for term in ("unknown variant", "method not found", "unknown method")):
                    raise
                history = client.call("thread/read", {"threadId":thread_id,"includeTurns":True})["thread"]
                last = next(reversed(history.get("turns") or []), {})
            print(json.dumps({"thread":thread_id, "state":(record.get("status") or {}).get("type"),
                              "turn":last.get("id"),"turnStatus":last.get("status")}))
            return
        if sys.argv[1] == "--health":
            page = client.call("thread/loaded/list", {"limit":1})
            print(json.dumps({"ready":isinstance(page.get("data"), list)}))
            return
        if sys.argv[1] == "--fork":
            import fcntl
            source = str(uuid.UUID(sys.argv[2]))
            request = str(uuid.UUID(sys.argv[3]))
            args = sys.argv[4:]
            side_instructions = None
            if len(args) >= 2 and args[-2] == "--side-chat":
                side_instructions = base64.b64decode(args[-1], validate=True).decode()
                args = args[:-2]
            last_turn = str(uuid.UUID(args[0])) if args else None
            receipt_key = source + (":"+last_turn if last_turn else "")
            if side_instructions: receipt_key += ":side-chat"
            base = Path.home() / ".local/state/dsh-local-chat/forks"
            base.mkdir(mode=0o700, parents=True, exist_ok=True)
            with (base / request).open("a+", encoding="utf8") as receipt:
                fcntl.flock(receipt, fcntl.LOCK_EX)
                receipt.seek(0)
                lines = receipt.read().splitlines()
                if lines and lines[0] != receipt_key:
                    raise ValueError("分支请求对应的原会话不一致")
                if not lines:
                    receipt.write(receipt_key + "\n")
                    receipt.flush()
                    os.fsync(receipt.fileno())
                    params = {"threadId":source,"sandbox":"read-only","approvalPolicy":"never"}
                    if last_turn: params["lastTurnId"] = last_turn
                    if side_instructions: params["developerInstructions"] = side_instructions
                    fork = client.call("thread/fork", params)
                    fork_id = str(uuid.UUID(fork["thread"]["id"]))
                    receipt.write(fork_id + "\n")
                    receipt.flush()
                    os.fsync(receipt.fileno())
                elif len(lines) == 2:
                    fork_id = str(uuid.UUID(lines[1]))
                else:
                    raise ValueError("主机尚未确认分支结果，请查看主机会话目录")
            print(json.dumps({"thread":fork_id,"source":source}))
            return
        if sys.argv[1] in ("--name", "--get-name"):
            thread = sys.argv[2]
            if sys.argv[1] == "--name":
                name = base64.b64decode(sys.argv[3], validate=True).decode()
                client.call("thread/name/set", {"threadId":thread, "name":name})
            record = client.call("thread/read", {"threadId":thread, "includeTurns":False})["thread"]
            print(json.dumps({"thread":record["id"], "name":record.get("name")}))
            return
        if sys.argv[1] == "--models":
            models = []
            cursor = None
            while True:
                params = {"limit":100,"includeHidden":False}
                if cursor: params["cursor"] = cursor
                page = client.call("model/list", params)
                for model in page["data"]:
                    models.append({"id":model["model"],"name":model["displayName"],"isDefault":model.get("isDefault",False),
                                   "description":model.get("description") or "",
                                   "retirementAt":(model.get("upgradeInfo") or {}).get("retirementAt"),
                                   "serviceTiers":[{"id":tier["id"],"name":tier["name"],"description":tier.get("description","")}
                                                   for tier in model.get("serviceTiers") or []],
                                   "defaultEffort":model["defaultReasoningEffort"], "defaultServiceTier":model.get("defaultServiceTier"),
                                   "efforts":[x["reasoningEffort"] for x in model["supportedReasoningEfforts"]]})
                cursor = page.get("nextCursor")
                if not cursor: break
            cwd = base64.b64decode(sys.argv[2], validate=True).decode() if len(sys.argv)>2 else os.getcwd()
            config = client.call("config/read", {"cwd":cwd, "includeLayers":False})["config"]
            default = next((m for m in models if m["isDefault"]), {})
            model_id = config.get("model") or default.get("id")
            entry = next((m for m in models if m["id"] == model_id), {})
            print(json.dumps({"models":models, "recentConfigurations":desktop_recent_models(), "defaults":{"model":model_id,
                  "effort":config.get("model_reasoning_effort") or entry.get("defaultEffort"),
                  "serviceTier":config.get("service_tier")}}))
            return
        if sys.argv[1] == "--steer":
            import fcntl
            thread, turn, request = [str(uuid.UUID(v)) for v in sys.argv[2:5]]
            digest = sys.argv[5]
            root = Path(sys.argv[7]) if len(sys.argv)>7 else Path(__file__).parent
            with (root / ("steer-" + request + ".receipt")).open("a+") as receipt:
                fcntl.flock(receipt, fcntl.LOCK_EX)
                receipt.seek(0)
                state = receipt.read()
                if not state:
                    data = b"".join(p.read_bytes() for p in sorted(root.glob("steer-" + request + "-" + digest + "-part-*")))
                    if hashlib.sha256(data).hexdigest() != digest: raise ValueError("输入校验失败")
                    text = data.decode()
                    inputs = json.loads(text) if sys.argv[6:7]==["images"] else [{"type":"text","text":text}]
                    receipt.write(digest+"\npending\n");receipt.flush();os.fsync(receipt.fileno())
                    if len(sys.argv)<=7: client.call("thread/resume", {"threadId":thread})
                    result = client.call("turn/steer", {"threadId":thread,"expectedTurnId":turn,"clientUserMessageId":request,
                                                        "input":inputs})
                    if result["turnId"] != turn: raise ValueError("主机返回的轮次不一致")
                    receipt.write("accepted\n");receipt.flush();os.fsync(receipt.fileno())
                elif state != digest+"\npending\naccepted\n":
                    raise ValueError("主机尚未确认补充要求，请核对对话历史")
            print(json.dumps({"turn":turn}))
            return
        if sys.argv[1] in ("--interrupt", "--interrupt-shared"):
            thread, turn = sys.argv[2:4]
            if sys.argv[1] == "--interrupt":
                client.call("thread/resume", {"threadId":thread})
            else:
                record = client.call("thread/read", {"threadId":thread, "includeTurns":True})["thread"]
                if not any(t["id"]==turn and t.get("status")=="inProgress" for t in record["turns"]):
                    print("TURN_INACTIVE")
                    return
            client.call("turn/interrupt", {"threadId":thread, "turnId":turn})
            print("INTERRUPT_ACCEPTED", flush=True)
            return
        previous = sys.argv[1]
        selection = json.loads(base64.b64decode(sys.argv[2])) if len(sys.argv)>2 else {}
        overrides = {}
        if selection.get("model"): overrides["model"] = selection["model"]
        if selection.get("effort"): overrides["config"] = {"model_reasoning_effort":selection["effort"]}
        sandbox = selection.get("sandbox","read-only")
        preset = sandbox
        if preset in ("auto-review", "ask-for-approval"):
            sandbox = "workspace-write"
        if sandbox not in ("read-only","workspace-write","danger-full-access","host-default"): raise ValueError("未知的沙箱模式")
        approval = selection.get("approvalPolicy") or "never"
        if approval not in ("never","untrusted"): raise ValueError("未知审批策略")
        setup = {} if preset == "host-default" else {"sandbox":sandbox,"approvalPolicy":approval}
        reviewer = "auto_review" if preset == "auto-review" else "user"
        if preset in ("auto-review", "ask-for-approval"):
            approval = "on-request"
            setup.update(approvalPolicy=approval, approvalsReviewer=reviewer)
        opening = time.monotonic_ns()
        if previous == "-":
            if selection.get("projectId"): setup["projectId"] = selection["projectId"]
            opened = client.call("thread/start", {**setup,**overrides,"cwd":os.getcwd()})
        else:
            opened = client.call("thread/resume", {"threadId":previous,"excludeTurns":True,**overrides})
        thread_ready = time.monotonic_ns()
        thread = opened["thread"]["id"]
        emit("thread.started", thread_id=thread, model=opened.get("model"), effort=opened.get("reasoningEffort"),
             **({"threadServiceTier": opened["serviceTier"]} if "serviceTier" in opened else {}))
        policy = {"type":"readOnly","networkAccess":False}
        if sandbox == "workspace-write":
            policy = {"type":"workspaceWrite","writableRoots":[],"networkAccess":False,
                      "excludeTmpdirEnvVar":True,"excludeSlashTmp":True}
        elif sandbox == "danger-full-access":
            policy = {"type":"dangerFullAccess"}
        turn_policy = {} if preset == "host-default" else {
            "sandboxPolicy":policy,"approvalPolicy":approval,"approvalsReviewer":reviewer}
        # A running Desktop daemon may resume a loaded thread with its previous defaults.
        for key in ("model", "effort"):
            if selection.get(key): turn_policy[key] = selection[key]
        if selection.get("serviceTier"):
            turn_policy["serviceTierForTurn"] = selection["serviceTier"]
        mode = selection.get("collaborationMode")
        if mode in ("plan", "default"):
            turn_policy["collaborationMode"] = {"mode":mode, "settings":{
                "model":selection.get("model") or opened["model"], "reasoning_effort":selection.get("effort") or opened.get("reasoningEffort"),
                "developer_instructions":None}}
        raw = sys.stdin.read()
        inputs = json.loads(raw) if selection.get("structuredInput") else [{"type":"text","text":raw}]
        starting = time.monotonic_ns()
        turn = client.call("turn/start", {"threadId":thread,"input":inputs,
                                          **turn_policy})["turn"]["id"]
        started = time.monotonic_ns()
        if ((selection.get("model") and selection["model"] != opened.get("model")) or
            (selection.get("effort") and selection["effort"] != opened.get("reasoningEffort"))):
            try:
                active = client.call("thread/read", {"threadId":thread, "includeTurns":False})["thread"]
                if active.get("model"):
                    emit("thread.started", thread_id=thread, model=active["model"], effort=active.get("reasoningEffort"))
            except (RuntimeError, KeyError, ValueError):
                pass
        emit("turn.started", turn_id=turn, requestedPolicy=turn_policy,
             hostSetupMs={"connect":(connected-connecting)//1_000_000,
                          "thread":(thread_ready-opening)//1_000_000,
                          "turn":(started-starting)//1_000_000},
             threadSandbox=(opened.get("sandbox") or {}).get("type"), threadApproval=opened.get("approvalPolicy"))
        first_text = True
        started_supplements = {}
        for event in turn_events(client, thread, turn):
            method = event.get("method","")
            params = event.get("params",{})
            if params.get("threadId") != thread: continue
            if method in ("thread/goal/updated", "thread/goal/cleared"):
                emit("goal.changed",goal=params.get("goal"))
                continue
            if params.get("turnId",params.get("turn",{}).get("id")) != turn: continue
            if "id" in event and method:
                client.json_send({"id":event["id"],"error":{"code":-32601,"message":"Interactive request unavailable in this client"}})
                continue
            if method == "item/agentMessage/delta":
                timing = {}
                if first_text and params["delta"]:
                    timing["hostElapsedMs"] = (time.monotonic_ns() - started) // 1_000_000
                    timing["hostFirstTextAt"] = time.time_ns() // 1_000_000
                    first_text = False
                emit("text.delta", item_id=params["itemId"], delta=params["delta"], **timing)
            elif method == "turn/plan/updated":
                emit("steps.updated", explanation=params.get("explanation"), steps=params["plan"])
            elif method == "item/plan/delta":
                emit("plan.delta", item_id=params["itemId"], delta=params["delta"])
            elif method == "item/commandExecution/outputDelta":
                emit("command.output", item_id=params["itemId"], delta=params["delta"][-16384:],
                     truncated=len(params["delta"])>16384)
            elif method == "thread/tokenUsage/updated":
                usage = params.get("tokenUsage") or {}
                last = usage.get("last") or {}
                emit("usage.updated", input=last.get("inputTokens"), output=last.get("outputTokens"), total=last.get("totalTokens"),
                     contextWindow=usage.get("modelContextWindow"))
            elif method in ("item/started","item/completed"):
                item = params.get("item",{})
                kind = item.get("type")
                if kind == "userMessage" and item.get("clientId"):
                    text = "\n".join(part["text"] for part in item.get("content", []) if part.get("type")=="text")
                    images = [part["url"] for part in item.get("content", [])
                              if part.get("type") == "image" and isinstance(part.get("url"), str)
                              and part["url"].startswith(("data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,"))]
                    client_id = item["clientId"]
                    content = (text, images)
                    if started_supplements.get(client_id) != content:
                        emit("user.message",clientId=client_id,text=text,images=images)
                    if method == "item/started":
                        started_supplements[client_id] = content
                    else:
                        started_supplements.pop(client_id, None)
                if kind == "agentMessage" and method == "item/completed":
                    emit("item.completed",item={"id":item["id"],"type":"agent_message","text":item.get("text","")})
                elif kind == "plan":
                    emit("plan.snapshot", item_id=item["id"], text=item.get("text",""))
                elif kind in ("mcpToolCall","dynamicToolCall"):
                    emit(method.replace("/","."),item=tool_record(item))
                elif kind in ("commandExecution","webSearch","fileChange"):
                    changes = {"changes":item.get("changes", [])} if kind == "fileChange" else {}
                    output = item.get("aggregatedOutput")
                    captured = {"output":output[-16384:], "truncated":len(output)>16384} if output is not None else {}
                    emit(method.replace("/","."),item={"id":item["id"],"type":kind,"status":item.get("status"),
                        **changes, **captured,
                        "exitCode":item.get("exitCode"),
                        "title":str(item.get("command") or item.get("tool") or item.get("query") or kind)[:300]})
            elif method == "item/fileChange/patchUpdated":
                emit("item.updated",item={"id":params["itemId"],"type":"fileChange","title":"文件变更",
                                          "changes":params["changes"]})
            elif method == "turn/completed":
                result=params["turn"]
                if result.get("status") == "interrupted":
                    emit("turn.interrupted", turn_id=turn,durationMs=turn_duration(result))
                    return
                if result.get("status") != "completed":
                    raise ValueError((result.get("error") or {}).get("message") or result.get("status"))
                emit("turn.completed",turn_id=turn,durationMs=turn_duration(result))
                return
    finally:
        client.reader.close()
        client.sock.close()

if __name__ == "__main__":
    try: main()
    except Exception as err:
        emit("turn.failed",error={"message":str(err)[:500]})
        sys.exit(1)
