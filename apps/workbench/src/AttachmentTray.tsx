import { render } from 'preact';

interface Attachment {
  name: string;
  remotePath?: string;
  directory?: boolean;
  url?: string;
}
interface AttachmentTrayProps {
  files: Attachment[];
  host: string;
  preview: (url: string, name: string) => void;
  remove: (file: Attachment) => void;
}
function Icon({ name }: { name: string }) {
  return <svg aria-hidden="true"><use href={'/icons.svg#' + name} /></svg>;
}
export function renderAttachments(container: HTMLElement, props: AttachmentTrayProps) {
  render(<>{props.files.map((file, index) => <div class="chip" key={index}
    title={file.remotePath ? props.host + ' · ' + file.remotePath : undefined}>
    {file.url
      ? <button type="button" class="attachment-preview" aria-label={'查看' + file.name}
          aria-haspopup="dialog" onClick={() => props.preview(file.url!, file.name)}>
          <img class="attachment-image" src={file.url} alt={file.name} />
        </button>
      : <Icon name={file.directory ? 'folder-open' : 'file-text'} />}
    <span>{file.name}</span>
    <button type="button" class="icon" title={'移除 ' + file.name} aria-label={'移除 ' + file.name}
      onClick={() => props.remove(file)}><Icon name="x" /></button>
  </div>)}</>, container);
}
