from pathlib import Path
import os
import shutil
import subprocess

android = Path(__file__).resolve().parent
ndk = Path(os.environ["ANDROID_NDK_HOME"])
runtime = Path(os.environ["NODE_MOBILE_ANDROID"])
toolchain = ndk/"toolchains/llvm/prebuilt/windows-x86_64"
for abi, triple in [("arm64-v8a","aarch64-linux-android"), ("x86_64","x86_64-linux-android")]:
    output = android/"native"/abi
    output.mkdir(exist_ok=True)
    compiler = toolchain/"bin"/"clang++.exe"
    subprocess.run([str(compiler), "--target="+triple+"26", "-shared", "-fPIC", "-O2",
                    str(android/"native/receiver.cpp"), "-L"+str(runtime/"bin"/abi),
                    "-lnode", "-Wl,-soname,libreceiver.so", "-o", str(output/"libreceiver.so")], check=True)
    shutil.copyfile(toolchain/"sysroot/usr/lib"/triple/"libc++_shared.so",output/"libc++_shared.so")
