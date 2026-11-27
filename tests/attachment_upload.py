"""Exercise the Linux host's descriptor-relative upload and the canonical terminal wire format."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import pty
import shutil
import subprocess
import tempfile
import time
import uuid

source = Path(__file__).resolve().parents[1] / "apps/host/daemon-turn.py"

with tempfile.TemporaryDirectory() as temp:
    helper = Path(temp) / "turn.py"
    shutil.copyfile(source, helper)
    root = Path(temp) / "workspace"
    root.mkdir()
    spec = importlib.util.spec_from_file_location("driver", helper)
    driver = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(driver)

    class Host:
        def call(self, method, params):
            assert method == "project/list"
            return {"data":[{"roots":[{"path":str(root)}]}]}

    args = {"id":str(uuid.uuid4()), "cwd":str(root), "name":"notes.xlsx", "offset":0, "total":131075}
    payload = os.urandom(args["total"])
    args["data"] = base64.b64encode(payload[:-3]).decode("ascii")
    # Feed the exact bounded lines used by remoteLines into a real Linux PTY.
    runner = Path(temp) / "runner.py"
    runner.write_text("import io,sys,turn\n"
                      "class Host:\n"
                      " reader=io.BytesIO();sock=io.BytesIO()\n"
                      f" def call(self,m,p): return {{'data':[{{'roots':[{{'path':{str(root)!r}}}]}}]}}\n"
                      "turn.Connection=Host;sys.argv=['turn.py','--upload-attachment'];turn.main()\n")
    master, slave = pty.openpty()
    child = subprocess.Popen(["sh","-c",'stty -echo; echo READY; exec python3 "$1"',"sh",str(runner)],
                             stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    with os.fdopen(master,"r+b",buffering=0) as terminal:
        assert terminal.readline().strip() == b"READY"
        encoded = base64.b64encode(json.dumps(args).encode())
        lines = [encoded[i:i+1024] for i in range(0,len(encoded),1024)]
        for i in range(0,len(lines),24):
            packet = b"\r".join(lines[i:i+24])+b"\r"
            while packet:
                packet = packet[terminal.write(packet):]
        terminal.write(b"\x04")
        reply = terminal.readline().strip()
        assert json.loads(reply)=={"complete":False,"offset":131072},reply
    assert child.wait(timeout=5)==0

    last = {**args, "offset":131072, "data":base64.b64encode(payload[-3:]).decode()}
    result = driver.upload_attachment(Host(), last)
    assert Path(result["path"]).read_bytes() == payload
    assert driver.upload_attachment(Host(), last) == result
    abandoned = {**args, "id":str(uuid.uuid4()), "name":"abandoned.bin"}
    driver.upload_attachment(Host(), abandoned)
    partial_folder = root / (".codex-upload-"+abandoned["id"])
    assert (partial_folder / abandoned["name"]).stat().st_size == 131072
    driver.expire_upload_receipts(temp, time.time()+1000)
    assert not partial_folder.exists()
    assert Path(result["path"]).is_file()
    outside = Path(temp) / "foreign.txt"
    outside.write_text("intact")
    staged = Path(result["path"])
    staged.unlink()
    staged.symlink_to(outside)
    try:
        driver.upload_attachment(Host(), last)
        raise AssertionError("replaced destination accepted")
    except (OSError, ValueError):
        pass
    assert outside.read_text() == "intact"
    print("Host terminal binary transfer, retry, scope and symlink checks passed.")
