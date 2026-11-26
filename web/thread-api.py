import json
import os
import signal
import subprocess
import sys

mode, target = sys.argv[1:3]
shared = None
proc = None
if mode in ("shared-read","archive-set","list","read-state-update") or (mode == "read" and len(sys.argv) > 3):
    import runpy
    try:
        shared = runpy.run_path(sys.argv[3])["Connection"]()
    except (OSError, EOFError, RuntimeError):
        if mode not in ("read", "list"): raise
if shared is None and mode not in ("scheduled-local", "project-file-snapshot"):
    proc = subprocess.Popen(["codex", "app-server", "--stdio"], stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)

def send(message):
    proc.stdin.write(json.dumps(message) + "\n")
    proc.stdin.flush()

def rpc(number, method, params):
    if shared: return shared.call(method, params)
    send({"id": number, "method": method, "params": params})
    for line in proc.stdout:
        reply = json.loads(line)
        if reply.get("id") == number:
            if "error" in reply:
                raise ValueError(reply["error"].get("message", "Codex RPC error"))
            return reply["result"]
    raise ValueError("App Server closed")

PINNED = "01984de2-8f74-7c91-a3b2-5c5e937cf318"

def goal_timeout(signum, frame):
    raise TimeoutError("Goal lookup timed out")

def voice_preview_title(preview):
    import re
    from html import unescape
    if not isinstance(preview, str) or not preview.startswith("<realtime_delegation>"):
        return None
    if not re.match(r"<realtime_delegation>\s*<source>transcript_tail_flush</source>", preview):
        return None
    # The directory can truncate a preview before the transcript or its closing tag.
    match = re.search(r"<transcript_delta>\s*user:[ \t]*([^\n<]+)", preview)
    question = " ".join(unescape(match[1]).split()) if match else ""
    return question[:85] or "语音聊天"

def summaries(page):
    return [{"activeFlags": (t["status"].get("activeFlags") or []) if isinstance(t.get("status"), dict) and t["status"].get("type") == "active" else [],
                  "readState": (page.get("readStates") or {}).get(t["id"]), "thread": t["id"], "projectId": t.get("projectId"), "cwd": t.get("cwd", ""), "updated": t["updatedAt"],
                  "title": t.get("name") or voice_preview_title(t.get("preview")) or (t.get("preview") or "未命名任务")[:85]}
                 for t in page["data"]]

def pins():
    params = {"sectionId":PINNED, "sortKey":"section_position", "limit":100, "modelProviders":[]}
    items = []
    while True:
        page = rpc(4, "thread/list", params)
        items.extend(summaries(page))
        if not page.get("nextCursor"): return items
        params["cursor"] = page["nextCursor"]

def local_schedules():
    import stat
    import sqlite3
    from pathlib import Path
    home = Path(os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex"))
    directory = home / "automations"
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY
    try:
        root = os.open(directory,flags)
    except FileNotFoundError:
        return {"tasks":[],"skipped":0}
    tasks, skipped = [], 0
    try:
        for name in sorted(os.listdir(root)):
            try:
                if not stat.S_ISDIR(os.stat(name,dir_fd=root,follow_symlinks=False).st_mode): continue
                folder = os.open(name,flags,dir_fd=root)
                try:
                    fd = os.open("automation.toml",os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,dir_fd=folder)
                finally:
                    os.close(folder)
                with os.fdopen(fd,"rb") as source:
                    if not stat.S_ISREG(os.fstat(fd).st_mode): raise ValueError()
                    raw = source.read(262145)
                if len(raw)>262144: raise ValueError()
                try:
                    import tomllib
                except ImportError:
                    import tomli as tomllib
                task = tomllib.loads(raw.decode("utf-8"))
                if task.get("id",name)!=name or not isinstance(task["name"],str) or not isinstance(task["prompt"],str): raise ValueError()
                tasks.append({"id":name,**{k:task[k] for k in ("name","prompt","status","kind","rrule") if isinstance(task.get(k),str)}})
            except FileNotFoundError:
                continue
            except (ValueError,KeyError,OSError):
                skipped += 1
    finally:
        os.close(root)
    result = {"tasks":tasks,"skipped":skipped}
    request = json.loads(target) if target != "-" else None
    if request and not any(t["id"]==request["id"] for t in tasks):
        raise ValueError("本地定时任务已不存在")
    db = home / "sqlite" / "codex.db"
    if not db.is_file() or db.is_symlink() or db.parent.is_symlink():
        if request: raise ValueError("主机没有可读取的定时任务数据库")
        return result
    connection = sqlite3.connect(db.absolute().as_uri()+"?mode=ro",uri=True,timeout=2)
    connection.row_factory = sqlite3.Row
    try:
        if request:
            cursor = request.get("cursor")
            where = "automation_id=?"
            args = [request["id"]]
            if cursor:
                where += " AND (created_at, thread_id)<(?,?)"
                args.extend(cursor)
            rows = connection.execute("SELECT thread_id AS thread,created_at AS created,status,"
                "coalesce(nullif(inbox_title,''),thread_title,'') AS title FROM automation_runs WHERE "+where+
                " ORDER BY created_at DESC,thread_id DESC LIMIT 21",args).fetchall()
            return {"runs":[dict(row) for row in rows[:20]],"cursor":[rows[19]["created"],rows[19]["thread"]] if len(rows)>20 else None}
        for task in tasks:
            times = connection.execute("SELECT next_run_at,last_run_at FROM automations WHERE id=?",(task["id"],)).fetchone()
            if times: task.update(nextRunAt=times[0],lastRunAt=times[1])
        result["databaseAvailable"] = True
    except sqlite3.DatabaseError:
        if request: raise ValueError("主机的运行记录暂时无法读取")
    finally:
        connection.close()
    return result

def project_file_snapshot(query):
    root, path = query["root"], query["path"]
    relative = os.path.relpath(path, root).replace(os.sep, "/")
    if relative == ".." or relative.startswith("../") or relative.startswith(".git/"):
        raise ValueError("文件不在项目目录中")
    git = ["git", "--no-replace-objects", "--literal-pathspecs", "-C", root]
    entry = subprocess.check_output(git + ["ls-files", "--stage", "-z", "--", relative])
    records = entry.rstrip(b"\0").split(b"\0")
    if len(records) != 1 or not records[0]:
        raise ValueError("Git 暂存区中没有可预览的文件版本")
    meta, name = records[0].split(b"\t", 1)
    mode, oid, stage = meta.split()
    if mode not in (b"100644", b"100755") or stage != b"0" or name != os.fsencode(relative):
        raise ValueError("此条目无法作为文本预览")
    blob = oid.decode("ascii")
    if int(subprocess.check_output(git + ["cat-file", "-s", blob])) > 256 * 1024:
        raise ValueError("文件超过 256 KiB 预览上限")
    data = subprocess.check_output(git + ["cat-file", "blob", blob])
    if b"\0" in data:
        raise ValueError("此文件不是 UTF-8 文本")
    return {"text":data.decode("utf-8-sig"), "version":blob}

try:
    if proc:
        rpc(1, "initialize", {"clientInfo": {"name": "codex-window", "version": "1"},
                          "capabilities": {"experimentalApi": True}})
        send({"method": "initialized", "params": {}})
    if mode == "scheduled-local":
        result = local_schedules()
    elif mode == "project-file-snapshot":
        result = project_file_snapshot(json.loads(target))
    elif mode == "plugin-detail":
        query = json.loads(target)
        markets = rpc(2, "plugin/list", {})["marketplaces"]
        market = next((m for m in markets if m["name"] == query["market"] and
                       any(p["name"] == query["catalogName"] for p in m["plugins"])), None)
        if not market: raise ValueError("目录中没有这个插件")
        source = {"marketplacePath":market["path"]} if market.get("path") else {"remoteMarketplaceName":market["name"]}
        summary = next(p for p in market["plugins"] if p["name"] == query["catalogName"])
        import signal
        def detail_timeout(signum, frame):
            raise TimeoutError("插件详情暂不可用")
        signal.signal(signal.SIGALRM, detail_timeout)
        signal.alarm(8)
        try:
            detail = rpc(3, "plugin/read", {**source, "pluginName":query["catalogName"]})["plugin"]
        except (ValueError, TimeoutError):
            detail = {}
        finally:
            signal.alarm(0)
        if detail:
            if detail["summary"]["name"] == query["catalogName"] and detail["marketplaceName"] == market["name"]:
                summary = detail["summary"]
            else:
                detail = {}
        info = summary.get("interface") or {}
        result = {"name":info.get("displayName") or summary["name"], "catalogName":summary["name"],
                  "market":market["name"], "description":detail.get("description") or info.get("longDescription") or info.get("shortDescription"),
                  "developer":info.get("developerName"), "version":summary.get("localVersion") or summary.get("version"),
                  "installed":summary["installed"], "enabled":summary["enabled"], "detailAvailable":bool(detail),
                  "skills":[s["name"] for s in detail.get("skills",[])], "mcpServers":detail.get("mcpServers") or []}
    elif mode in ("plugins","plugin-page"):
        page = rpc(2, "plugin/list", {})
        plugins = []
        for market in page["marketplaces"]:
            for plugin in market["plugins"]:
                info = plugin.get("interface") or {}
                plugins.append({"name":info.get("displayName") or plugin["name"], "market":market["name"],
                                "description":info.get("shortDescription") or "", "installed":plugin["installed"],
                                "enabled":plugin["enabled"]})
                if mode == "plugin-page":
                    plugins[-1]["catalogName"] = plugin["name"]
        result = {"plugins":plugins, "partial":bool(page.get("marketplaceLoadErrors"))}
        if mode == "plugin-page":
            from collections import Counter
            names = Counter((p["market"],p["name"]) for p in plugins)
            args = json.loads(target)
            query = args["query"].casefold()
            groups = []
            for installed in [True, False]:
                if args["group"] is not None and args["group"] != installed: continue
                matches = [p for p in plugins if p["installed"] == installed and
                           query in " ".join((p["name"], p["catalogName"], p["description"], p["market"])).casefold()]
                start = args["offset"]
                entries = matches[start:start+40]
                for p in entries:
                    p["sameDisplayName"] = names[p["market"],p["name"]] > 1
                groups.append({"installed":installed, "total":len(matches), "entries":entries})
            result = {"groups":groups, "partial":result["partial"]}
    elif mode == "project-files":
        query = json.loads(target)
        root = query["root"]
        base = os.path.realpath(root)
        hits = rpc(2, "fuzzyFileSearch", {"query":query["query"], "roots":[root], "cancellationToken":None})
        files = []
        for hit in hits["files"]:
            path = os.path.join(root,hit["path"])
            if os.path.commonpath([base,os.path.realpath(path)]) != base: continue
            relative = os.path.relpath(path,root)
            if relative == ".." or relative.startswith("../"): continue
            files.append({"path":relative, "directory":os.path.isdir(path)})
        result = {"files":files}
    elif mode in ("list", "search", "archived", "project-page"):
        params = {"limit": 30, "sortKey": "updated_at", "sortDirection": "desc"}
        if mode == "archived": params["archived"] = True
        if mode == "project-page":
            query = json.loads(target)
            params.update(projectId=query.get("projectId"), limit=10)
            if "projectCwd" in query: params["cwd"] = query["projectCwd"]
            if query.get("cursor"): params["cursor"] = query["cursor"]
        elif mode == "search":
            query = json.loads(target)
            params["searchTerm"] = query["term"]
            if query.get("cursor"): params["cursor"] = query["cursor"]
        elif target != "-":
            params["cursor"] = target
        page = rpc(2, "thread/list", params)
        items = summaries(page)
        result = {"items": items, "cursor": page.get("nextCursor")}
        if mode == "project-page": result.update({k:query[k] for k in ("projectId","projectCwd") if k in query})
        if mode == "list" and target == "-":
            try: result["pinned"] = pins()
            except ValueError: pass
            projects = []
            params = {"limit":100}
            try:
                while True:
                    page = rpc(3, "project/list", params)
                    for project in page["data"]:
                        roots = [root["path"] for root in project["roots"]]
                        projects.append({"id":project["id"], "name":project["name"], "roots":roots,
                                         "hasGitRoot":any(os.path.exists(os.path.join(path, ".git")) for path in roots)})
                    if not page.get("nextCursor"): break
                    params["cursor"] = page["nextCursor"]
                result["projects"] = projects
            except ValueError:
                pass
    elif mode in ("archive-check","archive-set"):
        req = json.loads(target)
        ids = req["ids"]
        def archived_ids():
            page = rpc(6,"thread/list",{"archived":True,"includedThreadIds":ids,"limit":len(ids),"modelProviders":[]})
            return [t["id"] for t in page["data"] if t["id"] in ids]
        archived = archived_ids()
        if mode == "archive-set":
            thread = ids[0]
            desired = req["archived"]
            if (thread in archived) != desired:
                if desired:
                    record = rpc(7,"thread/read",{"threadId":thread,"includeTurns":False})["thread"]
                    if (record.get("status") or {}).get("type")=="active": raise ValueError("请等待当前任务结束后再归档")
                rpc(8,"thread/archive" if desired else "thread/unarchive",{"threadId":thread})
                archived = archived_ids()
            if (thread in archived) != desired: raise ValueError("主机尚未确认归档状态")
        result = {"ids":archived}
    elif mode == "read-state-update":
        req = json.loads(target)
        params = {"threadId":req["thread"],"expectedRevision":req["revision"],"operation":{"type":req["operation"]}}
        try:
            result = rpc(2, "thread/readState/update", params)
        except ValueError:
            current = rpc(3, "thread/read", {"threadId":req["thread"],"includeTurns":False}).get("readState")
            if not current or current.get("revision") == req["revision"]: raise
            result = {"conflict":True,"readState":current}
    elif mode == "pin":
        req = json.loads(target)
        thread = req["thread"]
        def section():
            data = rpc(5, "thread/read", {"threadId":thread,"includeTurns":False})["thread"]
            return (data.get("section") or {}).get("id")
        before = section()
        desired = PINNED if req["pinned"] else None
        if before != desired:
            if before != req["expected"]: raise ValueError("会话分组已变化")
            rpc(6, "thread/section/move", {"threadId":thread,"sectionId":desired})
        if section() != desired: raise ValueError("主机未确认分组变化")
        result = {"pinned":pins(), "sectionId":desired}
    else:
        reply = rpc(2, "thread/read", {"threadId": target, "includeTurns": True})
        thread = reply["thread"]
        if thread.get("id") != target:
            raise ValueError("主机返回的聊天与所选会话不一致，请重新读取")
        messages = []
        for turn in thread.get("turns", []):
            turn_start = len(messages)
            for item in turn.get("items", []):
                if item["type"] == "userMessage":
                    text = "\n".join(c.get("text","") for c in item.get("content", []) if c["type"]=="text")
                    images = [c["url"] for c in item.get("content", []) if c.get("type")=="image" and isinstance(c.get("url"),str) and c["url"].startswith(("data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,"))]
                    if text or images: messages.append({"role":"user","turn":turn["id"],"text":text,"images":images,"clientId":item.get("clientId")})
                elif item["type"] == "agentMessage" and item.get("text"):
                    messages.append({"role":"assistant","turn":turn["id"],"id":item.get("id"),"text":item["text"]})
                elif item["type"] == "plan" and item.get("text"):
                    messages.append({"role":"plan","turn":turn["id"],"id":item["id"],"text":item["text"]})
                elif item["type"] in ("commandExecution", "mcpToolCall", "dynamicToolCall", "webSearch", "fileChange"):
                    kind = item["type"]
                    title = item.get("command") or item.get("tool") or item.get("query") or kind
                    output = item.get("aggregatedOutput") or ""
                    if kind == "fileChange":
                        output = "\n".join(change["path"] for change in item.get("changes", []) if change.get("path"))
                    record = {"id":item["id"], "type":kind, "title":title, "output":output,
                              "exitCode":item.get("exitCode"), "status":item.get("status")}
                    if kind == "fileChange":
                        record["changes"] = item.get("changes", [])
                    elif kind in ("mcpToolCall","dynamicToolCall"):
                        from turn import tool_record
                        record = tool_record(item)
                    if messages and messages[-1].get("role") == "activity" and messages[-1]["turn"] == turn["id"]:
                        messages[-1]["items"].append(record)
                    else:
                        messages.append({"role":"activity", "turn":turn["id"], "items":[record]})
            if turn.get("status") in ("interrupted", "failed"):
                messages.append({"role":"status", "turn":turn["id"], "status":turn["status"],
                                 "text":(turn.get("error") or {}).get("message") or ""})
            if turn.get("status") in ("completed","interrupted"):
                from turn import turn_duration
                duration = turn_duration(turn)
                final = next((m for m in reversed(messages[turn_start:]) if m["role"] in ("assistant","status")),None)
                if final is not None and duration is not None:
                    final["turnDurationMs"] = duration
        result = {"thread":target,"readState":reply.get("readState"), "sectionId":(thread.get("section") or {}).get("id"), "projectId":thread.get("projectId"), "name":thread.get("name") or voice_preview_title(next((m.get("text") for m in messages if m["role"]=="user"),None)), "cwd":thread.get("cwd",""), "messages":messages}
        if "model" in thread or "reasoningEffort" in thread:
            result["threadConfig"] = {"model":thread.get("model"), "effort":thread.get("reasoningEffort")}
        if "serviceTier" in thread:
            result["threadServiceTier"] = thread["serviceTier"]
        if shared:
            status = thread.get("status") or {}
            latest = next(reversed(thread.get("turns") or []), {})
            live = status.get("type") not in ("idle", "notLoaded", "systemError")
            result["activeTurn"] = latest.get("id") if live and latest.get("status") == "inProgress" else None
            if result["activeTurn"] and status.get("type") == "active":
                result["activeFlags"] = status.get("activeFlags", [])
        try:
            if hasattr(signal, "SIGALRM"):
                signal.signal(signal.SIGALRM, goal_timeout)
                signal.alarm(2)
            result["goal"] = rpc(3, "thread/goal/get", {"threadId":target})["goal"]
        except (ValueError, OSError, EOFError, RuntimeError, KeyError):
            pass
        finally:
            if hasattr(signal, "SIGALRM"):
                signal.alarm(0)
    json.dump(result, sys.stdout, ensure_ascii=False)
except Exception as exc:
    json.dump({"error":str(exc)[:350]},sys.stdout,ensure_ascii=False)
finally:
    if proc: proc.terminate()
    if shared:
        shared.reader.close()
        shared.sock.close()
