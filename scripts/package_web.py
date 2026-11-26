from pathlib import Path
import json
import struct
import zipfile
import zlib

root = Path(__file__).resolve().parents[1]
web = root / "web"
vendor = web / "vendor"
out = root / "dist" / "Codex-Remote-Web.zip"
out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    manifest = json.loads((root / "scripts/web-files.json").read_text(encoding="utf-8-sig"))
    for name in manifest:
        if name == "start.sh":
            item = zipfile.ZipInfo(name)
            item.create_system = 3
            item.external_attr = 0o100755 << 16
            archive.writestr(item, (web/name).read_bytes().replace(b"\r\n", b"\n"), compress_type=zipfile.ZIP_DEFLATED)
        elif not name.isascii():
            item = zipfile.ZipInfo(name)
            encoded = name.encode()
            item.extra = struct.pack("<HHBI", 0x7075, len(encoded)+5, 1, zlib.crc32(encoded))+encoded
            archive.writestr(item, (web/name).read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
        else:
            archive.write(web/name, name)
    for package in json.loads((vendor/"package-lock.json").read_text())["packages"]:
        if not package:
            continue
        directory = vendor/package
        if not directory.is_dir():
            raise SystemExit("Run npm ci --prefix web/vendor first")
        for path in sorted(directory.rglob("*")):
            if path.is_file() and "node_modules" not in path.relative_to(directory).parts:
                archive.write(path, path.relative_to(web).as_posix())
with zipfile.ZipFile(out) as archive:
    assert archive.testzip() is None
print(out)
