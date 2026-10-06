'use strict';

const { execFileSync } = require('node:child_process');

// Finder/Dock launches do not inherit the terminal's Homebrew/fnm/CLI PATH.
// Read the user's login shell once, before any harness or config is loaded.
function restoreMacPath({ platform = process.platform, env = process.env, run = execFileSync } = {}) {
  if (platform !== 'darwin') return false;
  try {
    const shell = env.SHELL || '/bin/zsh';
    const output = run(shell, ['-ilc', 'printf "\\0"; /usr/bin/env -0'], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
      env, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const entry = output.split('\0').find((value) => value.startsWith('PATH='));
    if (!entry || !entry.slice(5)) return false;
    env.PATH = entry.slice(5);
    env.SHELL = shell;
    return true;
  } catch {
    // A broken shell startup must not prevent the dashboard from opening.
    return false;
  }
}

module.exports = { restoreMacPath };
