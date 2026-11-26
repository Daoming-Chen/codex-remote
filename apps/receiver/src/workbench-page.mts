interface PageOptions {
  deviceName: string;
  scope: string;
  version: string;
  dictationEngine: 'windows' | 'browser';
}

export function renderWorkbenchPage(template: string, options: PageOptions): string {
  const name = options.deviceName || '所选设备';
  const fields: Record<string, string> = {
    __RECEIVER_NAME__: name,
    __RECEIVER_INITIAL__: Array.from(name)[0].toLocaleUpperCase(),
    __RECEIVER_SCOPE__: options.scope,
    __CLIENT_VERSION__: options.version,
    __DICTATION_ENGINE__: options.dictationEngine,
  };
  return template.replace(/__(?:RECEIVER_NAME|RECEIVER_INITIAL|RECEIVER_SCOPE|CLIENT_VERSION|DICTATION_ENGINE)__/g,
    key => fields[key].replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'));
}
