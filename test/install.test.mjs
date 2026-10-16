import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (process.platform === 'win32') {
  run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'test/install.test.ps1']);
  const gitBash = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
  if (existsSync(gitBash)) run(gitBash, ['test/install.test.sh']);
  else console.log('SKIP: Unix installer tests (Git Bash unavailable; run on Linux/macOS)');
} else {
  run('bash', ['test/install.test.sh']);
}
