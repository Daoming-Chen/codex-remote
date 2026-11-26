#include <jni.h>

// The Java caller keeps the direct buffer alive for the entire Node invocation.
// Both writable argv strings share one allocation, as required by node::Start.
namespace node { int Start(int argc, char** argv); }
extern "C" JNIEXPORT jint JNICALL
Java_local_codex_receiver_NodeRuntime_start(JNIEnv* env, jclass, jobject buffer) {
    if (!buffer) return -1;
    char* bytes = static_cast<char*>(env->GetDirectBufferAddress(buffer));
    const jlong size = env->GetDirectBufferCapacity(buffer);
    if (!bytes || size < 8 || bytes[size - 1] != 0) return -1;
    if (bytes[0] != 'n' || bytes[1] != 'o' || bytes[2] != 'd' ||
        bytes[3] != 'e' || bytes[4] != 0 || bytes[5] != '/') return -1;
    for (jlong i = 5; i < size - 1; ++i) if (bytes[i] == 0) return -1;
    char* argv[] = {bytes, bytes + 5, nullptr};
    return node::Start(2, argv);
}
