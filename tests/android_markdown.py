"""Render the sample from an APK in an isolated Android emulator WebView."""
import argparse
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import zipfile

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("emulator")
parser.add_argument("screenshot", type=Path)
parser.add_argument("--apk", type=Path, default=root / "dist/Codex-Remote-Android-test.apk")
parser.add_argument("--capture-only", action="store_true", help="also capture older APKs with known rendering issues")
args = parser.parse_args()
adb = [os.environ.get("ADB", "adb"), "-s", args.emulator]
if subprocess.check_output(adb + ["shell", "getprop", "ro.kernel.qemu"]).strip() != b"1":
    raise SystemExit("This fixture requires an emulator")
build_tools = Path(os.environ["ANDROID_BUILD_TOOLS"])
jdk = Path(os.environ["JAVA_HOME"]) / "bin"
platform = os.environ["ANDROID_PLATFORM_JAR"]
win = os.name == "nt"
package = "local.codex.markdownfixture"
sample = (root / "tests/fixtures/tablet-reply.md").read_text(encoding="utf8").strip()
chat = {"id": "sample", "title": "Markdown", "draft": "", "files": [],
        "cwd": "C:/Users/Chend/Documents/2Dev/CodexRemote", "messages": [{"role": "assistant", "text": sample}]}
state = json.dumps({"active": "sample", "chats": [chat], "collapsed": True}, ensure_ascii=True)
scope = "a" * 64

with tempfile.TemporaryDirectory() as temp:
    work = Path(temp)
    assets = work / "assets"
    assets.mkdir()
    with zipfile.ZipFile(args.apk) as apk, zipfile.ZipFile(io.BytesIO(apk.read("assets/receiver.zip"))) as payload:
        for name in ["chat.js", "markdown.js", "chat.css", "icons.svg", "codex.png", "dictation.js", "voice-chat.js", "index.html"]:
            (assets / name).write_bytes(payload.read(name))
    page = (assets / "index.html").read_text(encoding="utf8").replace("__RECEIVER_SCOPE__", scope).replace("__RECEIVER_NAME__", "模拟主机").replace("__CLIENT_VERSION__", "0123456789abcdef")
    seed = "<script>localStorage.setItem('receiver:" + scope + ":tim-ser-chats-v2'," + json.dumps(state) + ")</script>"
    probe = """<script>
    window.addEventListener('load', () => {
      const timer=setInterval(()=>{
        const el=document.querySelector('#messages .answer');
        if(!el || !el.querySelector('li')) return;
        clearInterval(timer);
        el.scrollIntoView({block:'center'});
        console.log('fixture-result '+JSON.stringify({
          bold:el.querySelectorAll('strong').length, lists:el.querySelectorAll('li').length,
          boldWeight:getComputedStyle(el.querySelector('strong')).fontWeight,
          listIndent:getComputedStyle(el.querySelector('ul')).paddingInlineStart,
          links:el.querySelectorAll('a').length, literalDelimiters:el.textContent.includes('**'),
          width:el.clientWidth, overflow:el.scrollWidth-el.clientWidth, ua:navigator.userAgent
        }));
      },150);
    });
    </script>"""
    (assets / "index.html").write_text(page.replace("</head>", seed + probe + "</head>"), encoding="utf8")
    manifest = work / "AndroidManifest.xml"
    manifest.write_text(f'''<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="{package}">
      <uses-sdk android:minSdkVersion="26" android:targetSdkVersion="34"/>
      <application android:theme="@android:style/Theme.Material.Light.NoActionBar">
      <activity android:name=".Preview" android:exported="true"/></application></manifest>''')
    java = work / "Preview.java"
    java.write_text('''package local.codex.markdownfixture;
import android.app.Activity;
import android.os.Bundle;
import android.util.Log;
import android.webkit.*;
import java.io.*;
public class Preview extends Activity {
  public void onCreate(Bundle state) {
    super.onCreate(state);
    WebView web = new WebView(this);
    web.getSettings().setJavaScriptEnabled(true);
    web.getSettings().setDomStorageEnabled(true);
    web.getSettings().setUseWideViewPort(true);
    web.setWebChromeClient(new WebChromeClient() {
      @Override public boolean onConsoleMessage(ConsoleMessage message) {
        Log.i("MarkdownFixture", message.message()); return true;
      }
    });
    web.setWebViewClient(new WebViewClient() {
      @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        String path = request.getUrl().getPath();
        if (!"fixture.invalid".equals(request.getUrl().getHost()) || path == null)
          return new WebResourceResponse("text/plain","utf-8",null);
        if(path.equals("/api/devices")) return new WebResourceResponse("application/json","utf-8",
          new ByteArrayInputStream("{\\"devices\\":[{\\"name\\":\\"Fixture\\",\\"online\\":true,\\"deviceId\\":\\"fixture\\",\\"scope\\":\\"__SCOPE__\\"}]}".getBytes()));
        path=path.replace("/devices/__SCOPE__","");
        if (path.startsWith("/api/")) return new WebResourceResponse("application/json","utf-8",
          new ByteArrayInputStream("{\\"items\\":[],\\"projects\\":[],\\"models\\":[],\\"native\\":false}".getBytes()));
        String name = path.equals("/") ? "index.html" : path.substring(1);
        String mime = name.endsWith(".js") ? "application/javascript" : name.endsWith(".css") ? "text/css" :
          name.endsWith(".svg") ? "image/svg+xml" : name.endsWith(".png") ? "image/png" : "text/html";
        try {return new WebResourceResponse(mime,"utf-8", getAssets().open(name));}
        catch(IOException e){return new WebResourceResponse("text/plain","utf-8",null);}
      }
    });
    setContentView(web); web.loadUrl("https://fixture.invalid/devices/__SCOPE__/");
  }
}'''.replace("__SCOPE__", scope))
    classes = work / "classes"
    classes.mkdir()
    def run(*argv):
        subprocess.run([str(arg) for arg in argv], check=True, cwd=work, stdout=subprocess.DEVNULL)
    run(jdk / "javac", "--release", "8", "-classpath", platform, "-d", classes, java)
    run(jdk / "jar", "cf", "classes.jar", "-C", classes, ".")
    run(build_tools / ("d8.bat" if win else "d8"), "--lib", platform, "--min-api", "26", "--output", work, "classes.jar")
    run(build_tools / "aapt2", "link", "-I", platform, "--manifest", manifest, "-A", assets, "-o", "preview.apk")
    with zipfile.ZipFile(work / "preview.apk", "a") as apk:
        apk.write(work / "classes.dex", "classes.dex")
    run(build_tools / ("apksigner.bat" if win else "apksigner"), "sign", "--ks",
        root / "android/build/local-test.jks", "--ks-pass", "pass:android", "preview.apk")
    run(*adb, "install", "-r", work / "preview.apk")
    try:
        run(*adb, "shell", "am", "start", "-W", "-n", package + "/.Preview")
        pid = subprocess.check_output(adb + ["shell", "pidof", package]).decode().strip()
        for _ in range(30):
            log = subprocess.check_output(adb + ["logcat", "-d", "--pid=" + pid, "-s", "MarkdownFixture:I", "-v", "raw"]).decode(errors="replace")
            result = next((line[15:] for line in reversed(log.splitlines()) if line.startswith("fixture-result ")), None)
            if result:
                print(result)
                # Wait for the rendered reply to reach Android's accessibility tree.
                dump = "/data/local/tmp/codex-markdown-fixture.xml"
                for _ in range(5):
                    run(*adb, "shell", "uiautomator", "dump", dump)
                    tree = subprocess.check_output(adb + ["shell", "cat", dump]).decode("utf8")
                    if "先别刷新" in tree:
                        break
                else:
                    raise RuntimeError("The emulator did not display the sample reply")
                args.screenshot.write_bytes(subprocess.check_output(adb + ["exec-out", "screencap", "-p"]))
                if not args.capture_only:
                    measured = json.loads(result)
                    assert measured["bold"] == 5 and measured["lists"] == 2 and measured["links"] == 4, measured
                    assert measured["boldWeight"] == "700" and measured["listIndent"] == "22.75px", measured
                    assert not measured["literalDelimiters"] and measured["overflow"] <= 1, measured
                break
            time.sleep(1)
        else:
            raise RuntimeError("Sample did not render: " + log[-2000:])
    finally:
        run(*adb, "uninstall", package)
