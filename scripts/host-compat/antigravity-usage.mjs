export async function readAntigravityUsage(execFile, binary, cwd) {
  const options = {
    cwd, maxBuffer: 256 * 1024, windowsHide: true,
    env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
  };
  const version = await execFile(binary, ['--version'], { ...options, timeout: 3000 });
  const match = /^v?(\d+)\.(\d+)\.(\d+)\b/.exec(version.stdout.trim());
  const [major, minor, patch] = match?.slice(1).map(Number) ?? [];
  // Older print-mode clients can treat an unknown slash command as a model prompt.
  if (!match || major < 1 || (major === 1 && (minor < 1 || (minor === 1 && patch < 11)))) {
    throw Error('Antigravity CLI does not support structured quota output');
  }
  const { stdout } = await execFile(binary, ['--print', '/usage', '--output-format', 'json'], {
    ...options, timeout: 13000,
  });
  const result = JSON.parse(stdout);
  const groups = result.command?.data?.groups;
  if (result.command?.name !== 'usage' || !Array.isArray(groups))
    throw Error('Antigravity CLI did not return structured quotas');
  return groups.slice(0, 20).flatMap(group => {
    if (!Array.isArray(group?.buckets)) return [];
    const name = group.name;
    if (typeof name !== 'string' || !name.trim()) return [];
    const windows = group.buckets.slice(0, 10).flatMap(bucket => {
      const remaining = bucket?.remaining_fraction;
      if (!Number.isFinite(remaining) || remaining < 0 || remaining > 1) return [];
      const window = typeof bucket.window === 'string' ? bucket.window.slice(0, 48) : '';
      const windowDurationMins = window === '5h' ? 300 : window === 'weekly' ? 10080 : undefined;
      const resetsAt = typeof bucket.reset_time === 'number' ? bucket.reset_time :
        Date.parse(bucket.reset_time) / 1000;
      return [{ usedPercent: 100 * (1 - remaining), windowDurationMins,
        label: window, resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : undefined }];
    });
    return windows.length ? [{ name: name.slice(0, 100), windows }] : [];
  });
}
