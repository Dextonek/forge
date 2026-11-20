// Git helpers. Everything is optional: a project without a repo simply has no diff/commit/worktree.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { DATA_DIR } from './store.mjs';

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(stdout));
  });
}

export async function repoRoot(dir) {
  try { return (await git(dir, ['rev-parse', '--show-toplevel'])).trim(); } catch { return null; }
}

// Returns the thread's working folder: the same subfolder of the new worktree as the game is of its repo.
export async function createWorktree(projectPath, repo, threadId) {
  const wt = path.join(DATA_DIR, 'worktrees', threadId);
  await git(projectPath, ['worktree', 'add', '-b', `forge/${threadId}`, wt]);
  return path.join(wt, path.relative(path.resolve(repo), projectPath));
}

// Both are limited to the game folder ("-- ."): a game can live inside a bigger repository, and Forge
// must never stage or commit files outside it.
export async function diff(cwd) {
  const tracked = await git(cwd, ['diff', 'HEAD', '--stat', '--patch', '--no-color', '--', '.']).catch(() => '');
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '--', '.']).catch(() => '')).trim();
  return { patch: tracked, untracked: untracked ? untracked.split('\n') : [] };
}

export async function commit(cwd, message) {
  await git(cwd, ['add', '-A', '--', '.']);
  return git(cwd, ['commit', '-m', message, '--', '.']);
}
