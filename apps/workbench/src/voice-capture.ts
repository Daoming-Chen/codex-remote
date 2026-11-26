declare abstract class AudioWorkletProcessor { readonly port: MessagePort }
declare function registerProcessor(name: string, processor: typeof VoiceCapture): void;

class VoiceCapture extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]){
    const channel=inputs[0]?.[0];
    if(channel?.length)this.port.postMessage(channel.slice());
    return true
  }
}
registerProcessor('voice-capture',VoiceCapture);
