package local.codex.receiver;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
final class NodeRuntime {
    static { System.loadLibrary("c++_shared"); System.loadLibrary("node"); System.loadLibrary("receiver"); }
    static native int start(ByteBuffer args);
    static int run(String path) {
        byte[] data=("node\0"+path+"\0").getBytes(StandardCharsets.UTF_8);
        ByteBuffer buffer=ByteBuffer.allocateDirect(data.length);
        buffer.put(data);
        buffer.flip();
        return start(buffer);
    }
}
