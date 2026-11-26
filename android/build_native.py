from pathlib import Path
import os
import shutil
import subprocess

android = Path(__file__).resolve().parent
ndk = Path(os.environ["ANDROID_NDK_HOME"])
runtime = Path(os.environ["NODE_MOBILE_ANDROID"])
host = "windows-x86_64" if os.name == "nt" else "linux-x86_64"
toolchain = ndk/"toolchains/llvm/prebuilt"/host
compiler = toolchain/"bin"/("clang++.exe" if os.name == "nt" else "clang++")
if not compiler.is_file():
    raise SystemExit(f"NDK compiler missing: {compiler}")
for abi, triple in [("arm64-v8a","aarch64-linux-android"), ("x86_64","x86_64-linux-android")]:
    output = android/"native"/abi
    output.mkdir(exist_ok=True)
    subprocess.run([str(compiler), "--target="+triple+"26", "-shared", "-fPIC", "-O2",
                    str(android/"native/receiver.cpp"), "-L"+str(runtime/"bin"/abi),
                    "-lnode", "-Wl,-soname,libreceiver.so", "-o", str(output/"libreceiver.so")], check=True)
    shutil.copyfile(toolchain/"sysroot/usr/lib"/triple/"libc++_shared.so",output/"libc++_shared.so")
