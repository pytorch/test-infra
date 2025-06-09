const {execSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform !== 'darwin') {
  console.error('This action only runs on macOS.');
  process.exit(1);
}

const pythonVersion = process.env['INPUT_PYTHON-VERSION'] || '3.11';
const requirementsPath = process.env['INPUT_PIP_REQUIREMENTS_FILE'];
const formula = `python@${pythonVersion}`;

const timestamp = Math.floor(Date.now() / 1000);
const venvPath = `venv-${pythonVersion}-${timestamp}`;

execSync(`brew install ${formula}`, {stdio: 'inherit'});
const prefix = execSync(`brew --prefix`, {encoding: 'utf8'}).trim();
const pythonBin = path.join(prefix, 'bin', `python${pythonVersion}`);

console.log(`Using python at ${pythonBin}`);
execSync(`"${pythonBin}" -m venv "${venvPath}"`, {stdio: 'inherit'});

if (requirementsPath) {
  execSync(`"${venvPath}/bin/python" -m pip install -r "${requirementsPath}"`, {stdio: 'inherit'});
}

fs.appendFileSync(process.env['GITHUB_PATH'], path.join(venvPath, 'bin') + os.EOL);
fs.appendFileSync(process.env['GITHUB_STATE'], `venvPath=${venvPath}${os.EOL}`);
