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
  // Best-effort cleanup on pet runners: a plain `rm -rf` can fail with EACCES
  // when an installed package (e.g. torch) leaves read-only directories, or
  // when a prior job seeded root-owned files under the venv. Clear the
  // read-only bits and retry, then fall back to a privileged remove. Never
  // fail the job on cleanup; the next job re-cleans leftover site-packages.
  if (!tryRun(`rm -rf "${venvPath}"`)) {
    tryRun(`chmod -R u+w "${venvPath}"`);
    if (!tryRun(`rm -rf "${venvPath}"`)) {
      tryRun(`sudo rm -rf "${venvPath}"`);
    }
  }
} else {
  console.log('No virtual environment to remove.');
}
