const {execSync} = require('child_process');

const venvPath = process.env['STATE_venvPath'];
if (venvPath) {
  console.log(`Removing virtual environment at ${venvPath}`);
  execSync(`rm -rf "${venvPath}"`, {stdio: 'inherit'});
} else {
  console.log('No virtual environment to remove.');
}
