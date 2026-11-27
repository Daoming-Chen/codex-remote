import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import assert from 'node:assert/strict';

// Update after checking the installed desktop controls against the tablet flows.
const reviewedVersion = '26.1120.6357.0';

test('installed Codex desktop version matches the tablet interaction review', t => {
  if (process.platform !== 'win32') return t.skip('桌面端版本检查需要 Windows');
  const version = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '(Get-AppxPackage -Name OpenAI.Codex).Version',
  ], {encoding: 'utf8'}).trim();
  if (!version) return t.skip('本机未安装 Windows 商店版 Codex');
  assert.equal(version, reviewedVersion,
    `桌面端已更新至 ${version}。请复核输入框命令、目标、任务权限、模型、上下文圆环、文件与图片预览、Markdown 回复以及运行中的发送和停止，再更新交互测试和版本基线。`);
});
