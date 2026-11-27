package local.codex.receiver;

import android.app.*;
import android.content.*;
import android.net.*;
import android.os.*;
import java.io.IOException;
import java.net.*;
import java.util.concurrent.*;

/** Maintains the selected peer while the user has background connection enabled. */
public final class ConnectionService extends Service {
    static final String SETTING="backgroundConnection";
    private static final String CHANNEL="remote-connection";
    private final Handler handler=new Handler(Looper.getMainLooper());
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private ConnectivityManager networks;
    private volatile String route;
    private Network activeNetwork;
    private boolean validated;
    private boolean busy,wakeAgain;
    private long delay=1000;
    private final Runnable check=this::probe;
    private final ConnectivityManager.NetworkCallback callback=new ConnectivityManager.NetworkCallback(){
        @Override public void onAvailable(Network network){
            activeNetwork=network;validated=false;delay=1000;schedule(500);
        }
        @Override public void onCapabilitiesChanged(Network network,NetworkCapabilities capabilities){
            if(!network.equals(activeNetwork))return;
            boolean ready=capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
            if(ready&&!validated)schedule(500);
            validated=ready;
        }
        @Override public void onLost(Network network){
            if(!network.equals(activeNetwork))return;
            activeNetwork=null;validated=false;wakeAgain=false;handler.removeCallbacks(check);
        }
    };
    private void schedule(long ms){
        handler.removeCallbacks(check);
        if(route!=null&&activeNetwork!=null)handler.postDelayed(check,ms);
    }
    @Override public void onCreate(){
        super.onCreate();
        NotificationChannel channel=new NotificationChannel(CHANNEL,"后台连接",NotificationManager.IMPORTANCE_LOW);
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
        networks=getSystemService(ConnectivityManager.class);
        networks.registerDefaultNetworkCallback(callback,handler);
    }
    @Override public int onStartCommand(Intent intent,int flags,int startId){
        if(intent==null || "stop".equals(intent.getAction())){
            if(intent!=null)getSharedPreferences("receiver",MODE_PRIVATE).edit().putBoolean(SETTING,false).apply();
            stopSelf();return START_NOT_STICKY;
        }
        String next=intent.getStringExtra("route");
        if(next==null || !next.matches("/devices/[0-9a-f]{64}/") || ReceiverActivity.runtimeToken()==null){
            stopSelf();return START_NOT_STICKY;
        }
        Intent open=new Intent(this,ReceiverActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP|Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int immutable=PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT;
        Notification.Builder builder=new Notification.Builder(this,CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync).setContentTitle("Codex Remote")
            .setContentText("正在后台保持主机连接").setOngoing(true).setOnlyAlertOnce(true)
            .setContentIntent(PendingIntent.getActivity(this,0,open,immutable))
            .addAction(new Notification.Action.Builder(null,"停止保持连接",PendingIntent.getService(this,1,
                new Intent(this,ConnectionService.class).setAction("stop"),immutable)).build());
        if(Build.VERSION.SDK_INT>=31)builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        startForeground(1,builder.build());
        if(!next.equals(route)){route=next;delay=1000;schedule(0);}
        return START_NOT_STICKY;
    }
    private void probe(){
        if(busy){wakeAgain=true;return;}
        final String selected=route;
        if(selected==null)return;
        busy=true;
        final String origin="http://127.0.0.1:"+getSharedPreferences("receiver",MODE_PRIVATE).getInt("port",0);
        worker.execute(()->{
            int status=0;
            HttpURLConnection request=null;
            try{
                request=(HttpURLConnection)new URL(origin+selected+"api/resume").openConnection(java.net.Proxy.NO_PROXY);
                request.setInstanceFollowRedirects(false);request.setRequestMethod("POST");
                request.setRequestProperty("Origin",origin);request.setRequestProperty("Cookie","receiver="+ReceiverActivity.runtimeToken());
                request.setConnectTimeout(3000);request.setReadTimeout(65000);
                status=request.getResponseCode();
            }catch(IOException ignored){}finally{if(request!=null)request.disconnect();}
            final int result=status;
            handler.post(()->{
                busy=false;
                if(route==null)return;
                if(selected.equals(route)&&result==403){stopSelf();return;}
                boolean connected=result==200;
                long next=wakeAgain || !selected.equals(route)?500:connected?60000:delay;
                wakeAgain=false;delay=connected?1000:Math.min(delay*2,15000);schedule(next);
            });
        });
    }
    @Override public IBinder onBind(Intent intent){return null;}
    @Override public void onDestroy(){
        route=null;handler.removeCallbacks(check);networks.unregisterNetworkCallback(callback);
        worker.shutdownNow();stopForeground(STOP_FOREGROUND_REMOVE);super.onDestroy();
    }
}
