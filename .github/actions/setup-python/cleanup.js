const {execSync} = require('child_process');

const venvPath = process.env['STATE_venvPath'];
if (venvPath) {
  console.log(`Removing virtual environment at ${venvPath}`);
  const tryRun = (cmd) => {
    try {
      execSync(cmd, {stdio: 'inherit'});
      return true;
    } catch (e) {
      console.log(`Warning: \`${cmd}\` failed: ${e.message}`);
      return false;
    }
  };
  // Best-effort cleanup on pet runners: a plain `rm -rf` fails with EACCES when
  // the venv contains read-only or root-owned leftovers (regularly seen on the
  // torch/distributed subtree). Try a privileged remove first since it clears
  // both cases; `-n` keeps sudo non-interactive so it never blocks on a
  // password prompt, and we fall back to a plain `rm -rf` if passwordless sudo
  // is unavailable. Never fail the job on cleanup; the next job re-cleans
  // leftover site-packages.
  if (!tryRun(`sudo -n rm -rf "${venvPath}"`)) {
    tryRun(`rm -rf "${venvPath}"`);
  }
} else {
  console.log('No virtual environment to remove.');
}
