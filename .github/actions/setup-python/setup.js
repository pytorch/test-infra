const {execSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform !== 'darwin') {
  console.error('This action only runs on macOS.');
  process.exit(1);
}

let pythonVersion = process.env['INPUT_PYTHON_VERSION'];
const requirementsPath = process.env['INPUT_PIP-REQUIREMENTS-FILE'];

if (pythonVersion.split('.').length > 2) {
  console.log(`Warning: HomeBrew only supports version specified by major and minor, but got ${pythonVersion}`)
  pythonVersion = pythonVersion.split('.', 2).join('.')
}
const formula = `python@${pythonVersion}`;

const timestamp = Math.floor(Date.now() / 1000);
const venvPath = path.join(process.env['RUNNER_TEMP'], `venv-${pythonVersion}-${timestamp}`);

execSync('brew update', {stdio: 'inherit'});
execSync(`brew install ${formula}`, {stdio: 'inherit'});
const prefix = execSync('brew --prefix', {encoding: 'utf8'}).trim();
const pythonBin = path.join(prefix, 'bin', `python${pythonVersion}`);

console.log(`Using python at ${pythonBin} to create venv ${venvPath}`);
execSync(`"${pythonBin}" -m venv "${venvPath}"`, {stdio: 'inherit'});

if (requirementsPath) {
  console.log(`Installing requirements from ${requirementsPath}`);
  execSync(`"${venvPath}/bin/python" -m pip install -r "${requirementsPath}"`, {stdio: 'inherit'});
}

fs.appendFileSync(process.env['GITHUB_ENV'], `VENV_PATH=${venvPath}${os.EOL}`);
fs.appendFileSync(process.env['GITHUB_PATH'], path.join(venvPath, 'bin') + os.EOL);
fs.appendFileSync(process.env['GITHUB_STATE'], `venvPath=${venvPath}${os.EOL}`);
