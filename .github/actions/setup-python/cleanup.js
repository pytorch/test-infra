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
  // Try sudo if permitted (`-n` never prompts): guaranteed to clean this
  // user-only folder even with read-only/root-owned leftovers. Otherwise fall
  // back to a plain `rm -rf` and let it throw, so a genuinely poisoned runner
  // still surfaces an error.
  if (!tryRun(`sudo -n rm -rf "${venvPath}"`)) {
    execSync(`rm -rf "${venvPath}"`, {stdio: 'inherit'});
  }
} else {
  console.log('No virtual environment to remove.');
}
