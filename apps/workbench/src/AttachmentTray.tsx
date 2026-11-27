import { render } from 'preact';

interface Attachment {
  name: string;
  remotePath?: string;
  directory?: boolean;
  url?: string;
  uploadPath?: string;
}
interface AttachmentTrayProps {
  files: Attachment[];
  host: string;
  preview: (url: string, name: string) => void;
  openFile: (file: Attachment) => void;
  progress?: string;
  remove: (file: Attachment) => void;
}
function Icon({ name }: { name: string }) {
  return <svg aria-hidden="true"><use href={'/icons.svg#' + name} /></svg>;
}
export function renderAttachments(container: HTMLElement, props: AttachmentTrayProps) {
  render(<>{props.files.map((file, index) => <div class="chip" key={index}
    title={(file.uploadPath || file.remotePath) ? props.host + ' · ' + (file.uploadPath || file.remotePath) : undefined}>
    {file.url
      ? <button type="button" class="attachment-preview" aria-label={'查看' + file.name}
          aria-haspopup="dialog" onClick={() => props.preview(file.url!, file.name)}>
          <img class="attachment-image" src={file.url} alt={file.name} />
        </button>
      : <Icon name={file.directory ? 'folder-open' : 'file-text'} />}
    {file.uploadPath
      ? <button type="button" class="attachment-open" aria-label={'打开主机文件 '+file.name} onClick={() => props.openFile(file)}>{file.name}</button>
      : <span>{file.name}</span>}
    <button type="button" class="icon" title={'移除 ' + file.name} aria-label={'移除 ' + file.name}
      onClick={() => props.remove(file)}><Icon name="x" /></button>
  </div>)}{props.progress && <span role="status" class="quiet">{props.progress}</span>}</>, container);
}
