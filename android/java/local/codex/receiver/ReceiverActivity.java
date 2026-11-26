package local.codex.receiver;
import android.app.*;
import android.os.*;
import android.content.*;
import android.net.Uri;
import android.webkit.*;
import android.widget.*;
import android.view.View;
import java.io.*;
import java.nio.file.*;
import java.security.SecureRandom;
import java.util.UUID;
import java.util.zip.*;
import org.json.JSONObject;

public final class ReceiverActivity extends Activity {
    private static boolean running;
    private static volatile String failure;
    private final Handler handler=new Handler(Looper.getMainLooper());
    private WebView web;
    private static final int SELECT_ATTACHMENTS=1201;
    private static final int VOICE_MICROPHONE=1202;
    private PermissionRequest pendingMicrophone;
    private boolean requestingMicrophone;
    private ValueCallback<Uri[]> pendingFiles;
    private TextView message;
    private Button button;
    private Button scanButton;
    private AlertDialog scanDialog;
    private File root;
    private String origin,token,screen="";
    private boolean loaded, cookiePending, cookieFailed;
    private boolean pageReady, authorizationReady;
    public static final class DraftStore {
        private final SharedPreferences drafts,attachments;
        DraftStore(Context context){
            drafts=context.getSharedPreferences("composer-drafts",MODE_PRIVATE);
            attachments=context.getSharedPreferences("composer-attachments",MODE_PRIVATE);
        }
        private boolean valid(String id){return id!=null&&id.matches("(?:[0-9a-f]{64}:)?[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}");}
        @JavascriptInterface public String read(String id){return valid(id)?drafts.getString(id,null):null;}
        @JavascriptInterface public void write(String id,String text){
            if(valid(id)&&text!=null&&!text.equals(drafts.getString(id,null))){
                drafts.edit().putString(id,text).remove(id+".cursor").apply();
            }
        }
        @JavascriptInterface public void writeCursor(String id,String text,String position){
            if(valid(id)&&text!=null&&text.equals(drafts.getString(id,null))&&position!=null&&position.length()<256){
                drafts.edit().putString(id+".cursor",position).apply();
            }
        }
        @JavascriptInterface public String readCursor(String id){
            return valid(id)?drafts.getString(id+".cursor",null):null;
        }
        @JavascriptInterface public String readAttachments(String id){
            return valid(id)?attachments.getString(id,null):null;
        }
        @JavascriptInterface public boolean writeAttachments(String id,String state){
            return valid(id)&&state!=null&&attachments.edit().putString(id,state).commit();
        }
    }
    @Override public void onCreate(Bundle state){
        super.onCreate(state);
        root=getFilesDir();
        android.content.SharedPreferences prefs=getSharedPreferences("receiver",MODE_PRIVATE);
        int port=prefs.getInt("port",0);
        if(port==0){port=40000+new SecureRandom().nextInt(20000);prefs.edit().putInt("port",port).commit();}
        origin="http://127.0.0.1:"+port;
        LinearLayout layout=new LinearLayout(this);layout.setOrientation(LinearLayout.VERTICAL);
        message=new TextView(this);message.setPadding(28,40,28,20);layout.addView(message);
        button=new Button(this);layout.addView(button);
        scanButton=new Button(this);scanButton.setText("用另一台设备扫码");scanButton.setVisibility(View.GONE);layout.addView(scanButton);
        web=new WebView(this){
            @Override public android.view.inputmethod.InputConnection onCreateInputConnection(android.view.inputmethod.EditorInfo info){
                android.view.inputmethod.InputConnection connection=super.onCreateInputConnection(info);
                if(connection!=null)info.imeOptions|=android.view.inputmethod.EditorInfo.IME_FLAG_NO_FULLSCREEN;
                return connection;
            }
        };
        layout.addView(web,new LinearLayout.LayoutParams(-1,0,1));web.setVisibility(View.GONE);
        setContentView(layout);show("正在启动本机接收端…",null,null);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.addJavascriptInterface(new DraftStore(this),"ReceiverDrafts");
        web.addJavascriptInterface(new Object(){
            @JavascriptInterface public boolean usesDoubaoKeyboard(){
                String selected=android.provider.Settings.Secure.getString(getContentResolver(),
                    android.provider.Settings.Secure.DEFAULT_INPUT_METHOD);
                android.content.ComponentName component=selected==null?null:android.content.ComponentName.unflattenFromString(selected);
                return component!=null&&"com.bytedance.android.doubaoime".equals(component.getPackageName());
            }
            @JavascriptInterface public void hideForDictation(){
                runOnUiThread(()->{
                    String url=web.getUrl();
                    if(url==null||!isWorkbenchOrigin(Uri.parse(url)))return;
                    android.view.inputmethod.InputMethodManager keyboard=
                        (android.view.inputmethod.InputMethodManager)getSystemService(INPUT_METHOD_SERVICE);
                    if(keyboard!=null)keyboard.hideSoftInputFromWindow(web.getWindowToken(),0);
                });
            }
        },"ReceiverKeyboard");
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.setWebChromeClient(new WebChromeClient(){
            @Override public void onPermissionRequest(PermissionRequest request){
                String[] resources=request.getResources();
                if(requestingMicrophone||!isWorkbenchOrigin(request.getOrigin())||resources.length!=1||
                    !PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resources[0])){
                    request.deny();return;
                }
                if(checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)==android.content.pm.PackageManager.PERMISSION_GRANTED){
                    request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});return;
                }
                pendingMicrophone=request;
                requestingMicrophone=true;
                requestPermissions(new String[]{android.Manifest.permission.RECORD_AUDIO},VOICE_MICROPHONE);
            }
            @Override public void onPermissionRequestCanceled(PermissionRequest request){
                if(request==pendingMicrophone)pendingMicrophone=null;
            }
            @Override public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> callback,FileChooserParams params){
                if(pendingFiles!=null){callback.onReceiveValue(null);return true;}
                pendingFiles=callback;
                Intent choose=new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE);
                choose.setType("*/*");
                choose.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,params.getMode()==FileChooserParams.MODE_OPEN_MULTIPLE);
                try{startActivityForResult(choose,SELECT_ATTACHMENTS);}
                catch(ActivityNotFoundException e){finishFiles(null);Toast.makeText(ReceiverActivity.this,"未找到系统文件选择器",Toast.LENGTH_LONG).show();}
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient(){
            @Override public void onPageFinished(WebView view,String url){
                if(isWorkbenchOrigin(Uri.parse(url))){
                    pageReady=true;refreshAuthorizedChat();
                }
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest req){
                Uri uri=req.getUrl();if(origin.equals(uri.getScheme()+"://"+uri.getEncodedAuthority()))return false;
                if(req.isForMainFrame()&&req.hasGesture()&&"https".equals(uri.getScheme()))openExternal(uri);
                return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest req){
                Uri u=req.getUrl();
                if(("http".equals(u.getScheme())||"https".equals(u.getScheme()))&&!origin.equals(u.getScheme()+"://"+u.getEncodedAuthority()))
                    return new WebResourceResponse("text/plain","utf-8",new ByteArrayInputStream(new byte[0]));
                return null;
            }
        });
        synchronized(ReceiverActivity.class){
            if(!running){
                running=true;
                token=UUID.randomUUID().toString();activeToken=token;
                final int listenPort=port;new File(root,"screen.json").delete();new File(root,"retry").delete();
                new Thread(()->boot(listenPort),"embedded-node").start();
            }else token=activeToken;
        }
    }
    private boolean isWorkbenchOrigin(Uri uri){
        return uri!=null&&origin.equals(uri.getScheme()+"://"+uri.getEncodedAuthority());
    }
    @Override public void onRequestPermissionsResult(int code,String[] permissions,int[] results){
        super.onRequestPermissionsResult(code,permissions,results);
        if(code!=VOICE_MICROPHONE)return;
        requestingMicrophone=false;
        PermissionRequest request=pendingMicrophone;
        pendingMicrophone=null;
        if(request==null)return;
        if(results.length==1&&results[0]==android.content.pm.PackageManager.PERMISSION_GRANTED&&
            isWorkbenchOrigin(request.getOrigin())&&web.getUrl()!=null&&isWorkbenchOrigin(Uri.parse(web.getUrl()))){
            request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        }else request.deny();
    }
    private void finishFiles(Uri[] files){
        ValueCallback<Uri[]> callback=pendingFiles;
        pendingFiles=null;
        if(callback!=null)callback.onReceiveValue(files);
    }
    @Override protected void onActivityResult(int request,int result,Intent data){
        super.onActivityResult(request,result,data);
        if(request!=SELECT_ATTACHMENTS)return;
        java.util.LinkedHashSet<Uri> files=new java.util.LinkedHashSet<>();
        if(result==RESULT_OK&&data!=null){
            ClipData clips=data.getClipData();
            if(clips!=null)for(int i=0;i<clips.getItemCount();i++)files.add(clips.getItemAt(i).getUri());
            if(data.getData()!=null)files.add(data.getData());
            files.removeIf(uri->uri==null||!"content".equals(uri.getScheme())||
                checkUriPermission(uri,android.os.Process.myPid(),android.os.Process.myUid(),Intent.FLAG_GRANT_READ_URI_PERMISSION)!=android.content.pm.PackageManager.PERMISSION_GRANTED);
        }
        finishFiles(files.isEmpty()?null:files.toArray(new Uri[0]));
    }
    private static String activeToken;
    private void prepareAssets(File app) throws Exception {
        long installed=getPackageManager().getPackageInfo(getPackageName(),0).lastUpdateTime;
        File marker=new File(root,"assets-installed");
        String version=Long.toString(installed);
        if(marker.isFile()&&new File(app,"embedded.mjs").isFile()&&
            version.equals(new String(Files.readAllBytes(marker.toPath()),"UTF-8")))return;
        Files.deleteIfExists(marker.toPath());
        app.mkdirs();
        try(ZipInputStream zip=new ZipInputStream(getAssets().open("receiver.zip"))){
            ZipEntry entry;
            while((entry=zip.getNextEntry())!=null){
                File out=new File(app,entry.getName());
                if(!out.getCanonicalPath().startsWith(app.getCanonicalPath()+File.separator))throw new IOException("Invalid asset path");
                if(entry.isDirectory()){out.mkdirs();continue;}
                out.getParentFile().mkdirs();Files.copy(zip,out.toPath(),StandardCopyOption.REPLACE_EXISTING);
            }
        }
        Files.write(marker.toPath(),version.getBytes("UTF-8"));
    }
    private void boot(int port){
        try{
            File app=new File(root,"app");
            prepareAssets(app);
            JSONObject cfg=new JSONObject().put("port",port).put("token",token);
            Files.write(new File(root,"launch.json").toPath(),cfg.toString().getBytes("UTF-8"));
            int code=NodeRuntime.run(new File(app,"embedded.mjs").getAbsolutePath());failure="接收端已退出（"+code+"）。";
        }catch(Exception|LinkageError e){failure="接收端启动失败 · "+e.getClass().getSimpleName()+": "+e.getMessage();}
    }
    private void show(String text,String label,Runnable action){
        message.setText(text);message.setVisibility(View.VISIBLE);
        button.setVisibility(label==null?View.GONE:View.VISIBLE);button.setText(label);button.setOnClickListener(action==null?null:v->action.run());
    }
    private void openExternal(Uri uri){
        try{startActivity(new Intent(Intent.ACTION_VIEW,uri));}catch(ActivityNotFoundException e){Toast.makeText(this,"未找到可打开链接的浏览器",Toast.LENGTH_LONG).show();}
    }
    private final Runnable refresh=new Runnable(){public void run(){
        if(failure!=null){show(failure,null,null);return;}
        try{
            File status=new File(root,"screen.json");
            if(status.exists()){
                String json=new String(Files.readAllBytes(status.toPath()),"UTF-8");
                if(!json.equals(screen)){screen=json;JSONObject data=new JSONObject(json);String stage=data.getString("stage");
                    scanButton.setVisibility(View.GONE);
                    if(scanDialog!=null){scanDialog.dismiss();scanDialog=null;}
                    if(!stage.equals("bind-error"))openWorkbench();
                    if(stage.equals("authorize")){Uri uri=Uri.parse(data.getString("url"));
                        if("https".equals(uri.getScheme())){
                            show("首次使用需要授权此设备连接 Remote。","打开设备授权",()->openExternal(uri));
                            String qr=data.optString("qr");
                            if(!qr.isEmpty()){
                                scanButton.setVisibility(View.VISIBLE);
                                scanButton.setOnClickListener(v->showAuthorizationCode(qr));
                            }
                        }}
                    else if(stage.equals("retry"))show(data.optBoolean("expired")?"授权链接已过期，请获取新链接。":data.optString("reason","设备授权未完成。"),"重新授权",()->{try{new File(root,"retry").createNewFile();show("正在获取授权链接…",null,null);}catch(IOException e){screen="";}});
                    else if(stage.equals("ready")){
                        message.setVisibility(View.GONE);button.setVisibility(View.GONE);
                        authorizationReady=true;refreshAuthorizedChat();
                    }else if(stage.equals("pairing"))show("正在检查设备授权…",null,null);
                    else if(stage.equals("bind-error"))show("接收端端口被占用，请关闭占用该端口的服务后重新启动。",null,null);
                    else if(stage.equals("starting"))show("正在连接工作台…",null,null);
                }
            }
            if(cookieFailed)showCookieRetry();
        }catch(Exception e){screen="";}
        if(!screen.contains("\"stage\":\"ready\""))handler.postDelayed(this,500);
    }};
    private void openWorkbench(){
        if(loaded||cookiePending||cookieFailed)return;
        cookiePending=true;
        CookieManager cookies=CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setCookie(origin,"receiver="+token+"; HttpOnly; SameSite=Strict; Path=/",ok->{
            cookiePending=false;
            if(isFinishing()||isDestroyed())return;
            if(!Boolean.TRUE.equals(ok)){
                cookieFailed=true;
                showCookieRetry();
                return;
            }
            loaded=true;
            web.setVisibility(View.VISIBLE);
            web.loadUrl(origin+"/");
        });
    }
    private void showCookieRetry(){
        scanButton.setVisibility(View.GONE);
        show("无法建立本机工作台会话","重试打开工作台",()->{
            cookieFailed=false;
            screen="";
            handler.removeCallbacks(refresh);
            handler.post(refresh);
        });
    }
    private void refreshAuthorizedChat(){
        if(!pageReady||!authorizationReady)return;
        authorizationReady=false;
        web.evaluateJavascript("typeof receiverAuthorized==='function' && void receiverAuthorized()",null);
    }
    private void showAuthorizationCode(String encoded){
        byte[] png=android.util.Base64.decode(encoded,android.util.Base64.DEFAULT);
        ImageView code=new ImageView(this);
        code.setAdjustViewBounds(true);
        code.setImageBitmap(android.graphics.BitmapFactory.decodeByteArray(png,0,png.length));
        code.setContentDescription("Remote 设备授权二维码");
        scanDialog=new AlertDialog.Builder(this).setTitle("扫码授权此设备").setView(code)
            .setNegativeButton("关闭",null).show();
    }
    @Override protected void onResume(){super.onResume();web.onResume();handler.post(refresh);}
    @Override protected void onPause(){handler.removeCallbacks(refresh);web.onPause();super.onPause();}
    private void navigateBack(){
        if(loaded&&web.canGoBack())web.goBack();else super.onBackPressed();
    }
    @Override public void onBackPressed(){
        if(!loaded||web.getVisibility()!=View.VISIBLE){navigateBack();return;}
        web.evaluateJavascript("typeof dismissWorkbenchOverlay==='function' && dismissWorkbenchOverlay()",handled->{
            if(!isFinishing()&&!isDestroyed()&&!"true".equals(handled))navigateBack();
        });
    }
    @Override protected void onDestroy(){handler.removeCallbacks(refresh);finishFiles(null);web.destroy();super.onDestroy();}
}
