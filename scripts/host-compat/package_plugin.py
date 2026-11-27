"""Package ds-harness-remote 0.6.8 with Codex speed, permission review, and goal controls."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plugin", type=Path, help="installed ds-harness-remote package directory")
    parser.add_argument("output", type=Path, help="new .tgz file")
    args = parser.parse_args()
    manifest = json.loads((args.plugin / "package.json").read_text(encoding="utf-8"))
    if (manifest.get("name"), manifest.get("version")) != ("ds-harness-remote", "0.6.8"):
        parser.error("expected ds-harness-remote 0.6.8")
    if args.output.exists():
        parser.error("output file already exists")
    npm = shutil.which("npm.cmd") or shutil.which("npm")
    if not npm:
        parser.error("npm not found")
    patches = [Path(__file__).resolve().with_name(f"ds-harness-remote-0.6.8-{name}.patch")
               for name in ("service-tier", "approval-reviewer", "goals", "upload", "download", "model-defaults")]
    with tempfile.TemporaryDirectory() as temporary:
        source = Path(temporary) / "plugin"
        shutil.copytree(args.plugin, source, ignore=shutil.ignore_patterns("node_modules", ".git"))
        helper = Path(__file__).resolve().with_name("attachment-upload.mjs")
        shutil.copyfile(helper, source / "dist" / helper.name)
        if "dist/" + helper.name not in manifest["files"]:
            manifest["files"].append("dist/" + helper.name)
        (source / "package.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        # An installed compatibility build can be the source for the next release.
        # Normalize its known patches in the temporary copy before applying the set.
        for patch in reversed(patches):
            applied = subprocess.run(["git", "apply", "--reverse", "--check", str(patch)],
                                     cwd=source, capture_output=True)
            if applied.returncode == 0:
                subprocess.run(["git", "apply", "--reverse", str(patch)], cwd=source, check=True)
        for patch in patches:
            subprocess.run(["git", "apply", "--check", str(patch)], cwd=source, check=True)
            subprocess.run(["git", "apply", str(patch)], cwd=source, check=True)
        subprocess.run([npm, "pack", "--ignore-scripts", "--pack-destination", temporary],
                       cwd=source, check=True)
        packed = Path(temporary) / "ds-harness-remote-0.6.8.tgz"
        with packed.open("rb") as payload, args.output.open("xb") as target:
            shutil.copyfileobj(payload, target)
    print(args.output.resolve())


if __name__ == "__main__":
    main()
