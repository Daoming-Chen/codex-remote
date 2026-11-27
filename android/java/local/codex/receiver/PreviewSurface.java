package local.codex.receiver;

import android.app.Activity;
import android.net.Uri;
import android.view.View;
import android.webkit.*;
import android.widget.FrameLayout;
import java.io.ByteArrayInputStream;

/** An unprivileged browser surface, laid out inside the workbench side panel. */
public final class PreviewSurface {
    private final Activity activity;
    private final FrameLayout parent;
    private final WebView workbench;
    private WebView page;
    private int generation;
    PreviewSurface(Activity activity, FrameLayout parent, WebView workbench){
        this.activity=activity;this.parent=parent;this.workbench=workbench;
    }

    @JavascriptInterface public void show(String address,int id,int x,int y,int width,int height,int viewport){
        Uri target=Uri.parse(address);
        if(!"http".equals(target.getScheme()) || target.getHost()==null ||
            !target.getHost().matches("dsh-[0-9a-f]{48}\\.localhost") ||
            target.getUserInfo()!=null || target.getPort()<1 || viewport<=0)return;
        activity.runOnUiThread(()->{
            if(activity.isDestroyed() || activity.isFinishing())return;
            if(page==null || generation!=id){
                clear();
                generation=id;
                page=new WebView(activity);
                page.getSettings().setJavaScriptEnabled(true);
                page.getSettings().setDomStorageEnabled(true);
                page.getSettings().setAllowFileAccess(false);
                page.getSettings().setAllowContentAccess(false);
                page.setWebViewClient(new WebViewClient(){
                    private boolean allowed(Uri url){
                        return target.getScheme().equals(url.getScheme()) &&
                            target.getEncodedAuthority().equals(url.getEncodedAuthority());
                    }
                    @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){
                        return !allowed(request.getUrl());
                    }
                    @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request){
                        Uri url=request.getUrl();
                        if(!allowed(url) && ("http".equals(url.getScheme()) || "https".equals(url.getScheme())))
                            return new WebResourceResponse("text/plain","utf-8",new ByteArrayInputStream(new byte[0]));
                        return null;
                    }
                });
                parent.addView(page);
                page.loadUrl(address);
            }
            float scale=(float)workbench.getWidth()/viewport;
            FrameLayout.LayoutParams bounds=new FrameLayout.LayoutParams(Math.max(1,Math.round(width*scale)),Math.max(1,Math.round(height*scale)));
            bounds.leftMargin=Math.round(x*scale);bounds.topMargin=Math.round(y*scale);
            page.setLayoutParams(bounds);
            page.setVisibility(View.VISIBLE);
        });
    }
    @JavascriptInterface public void hide(){activity.runOnUiThread(()->{if(page!=null)page.setVisibility(View.GONE);});}
    @JavascriptInterface public void dispose(int id){activity.runOnUiThread(()->{if(generation==id)clear();});}
    boolean goBackIfFocused(){
        if(page==null || !page.isShown() || !page.hasFocus() || !page.canGoBack())return false;
        page.goBack();
        return true;
    }
    void clear(){if(page!=null){parent.removeView(page);page.destroy();page=null;}}
    void pause(){if(page!=null)page.onPause();}
    void resume(){if(page!=null)page.onResume();}
}
