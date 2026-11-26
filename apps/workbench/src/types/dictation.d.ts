interface LocalRecognition {
  lang: string;
  continuous: boolean;
  processLocally: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: () => void;
  onend: () => void;
  onerror: (event: { error: string }) => void;
  onresult: (event: { results: ArrayLike<{isFinal: boolean; 0: { transcript: string }}> }) => void;
}
interface LocalRecognitionEngine {
  new(): LocalRecognition;
  available(options: LocalRecognitionOptions): Promise<string>;
  install?(options: LocalRecognitionOptions): Promise<boolean>;
}
interface LocalRecognitionOptions { langs: string[]; processLocally: boolean; quality: 'dictation' }
interface Window {
  ReceiverKeyboard?: { usesDoubaoKeyboard?(): boolean; hideForDictation(): void };
}
interface DocumentEventMap {
  'draft-submitted': CustomEvent<string>;
  'chat-selected': CustomEvent<string>;
}
declare function current(): { id: string };
declare function toast(message: string): void;
declare function deviceFetch(path: string, options: RequestInit): Promise<Response>;
declare const composingPrompt: boolean;
declare function modal(title: string): HTMLElement;
declare function element(tag: string, className: string, text: string): HTMLElement;
declare function row(label: string, icon: string, click: () => void): HTMLButtonElement;
declare function closeDialog(): void;
