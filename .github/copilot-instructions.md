# PyTorch Test Infrastructure

PyTorch Test Infrastructure is a multi-language repository containing CI/CD infrastructure, web applications, and development tools supporting the PyTorch ecosystem. The main components are TorchCI (Next.js web application), Terraform AWS GitHub Runner modules, Python utilities, and AWS Lambda functions.

Always reference these instructions first and fallback to search or bash commands only when you encounter unexpected information that does not match the info here.

## Working Effectively

### Bootstrap and Setup
- **NEVER CANCEL builds or tests** - they may take 45+ minutes. Use timeouts of 60+ minutes for builds, 30+ minutes for tests.
- Install dependencies and bootstrap the repository:
  - Ensure Node.js v20+ and Python 3.12+ are available
  - Install yarn: `npm install -g yarn` (if not present)
  - Check versions: `node --version`, `python3 --version`, `yarn --version`

### Linting and Code Quality
- **Primary linting system**: `pip3 install lintrunner==0.12.5 boto3-stubs==1.34.51`
- Initialize linters: `lintrunner init` -- takes ~26 seconds. NEVER CANCEL.
- Run linting: `lintrunner --force-color --all-files` for full repo or `lintrunner <file>` for specific files
- **Known issue**: actionlint component may fail due to network restrictions - document but continue
- **Timing**: Single file linting ~1 second, full repo linting ~5-10 minutes

### TorchCI Web Application (Primary Component)
- **Location**: `/torchci` directory
- **Technology**: Next.js 14 + TypeScript + React
- **Setup workflow**:
  - `cd torchci`
  - `yarn install --frozen-lockfile` -- takes ~82 seconds. NEVER CANCEL. Set timeout to 120+ seconds.
  - `yarn lint` -- takes ~7 seconds
  - `yarn tsc` -- takes ~15 seconds (TypeScript compilation)
  - `yarn build` -- takes ~107 seconds (1m 47s). NEVER CANCEL. Set timeout to 180+ seconds.
  - `yarn test` -- takes ~10 seconds
- **Development server**:
  - `yarn dev` -- starts in ~1.4 seconds
  - Runs on http://localhost:3000
  - **Note**: Many features require API credentials in `.env.local` (see `.env.example`)
- **Full validation workflow**: `yarn install --frozen-lockfile && yarn lint && yarn tsc && yarn build && yarn test`

### Terraform AWS GitHub Runner (Infrastructure)
- **Location**: `/terraform-aws-github-runner/modules/runners/lambdas/runners`
- **Technology**: TypeScript + AWS Lambda
- **Setup workflow**:
  - `cd terraform-aws-github-runner/modules/runners/lambdas/runners`
  - `yarn install` -- takes ~24 seconds
  - `yarn commit-check` -- takes ~60 seconds. NEVER CANCEL. Set timeout to 120+ seconds.
  - This runs: format + lint + test + build
- **Commands available**:
  - `yarn test` -- Run unit tests
  - `yarn lint` -- ESLint
  - `yarn build` -- TypeScript compilation with ncc
  - `yarn dist` -- Build + create lambda zip
  - `yarn format` -- Prettier formatting

### Python Tools and Utilities
- **Main tools location**: `/tools/torchci`
- **Requirements**: See `requirements.txt` files in various subdirectories
- **Known issue**: pip installs may timeout due to network restrictions - document timeouts
- **Setup**: `pip3 install -r requirements.txt` then `pip3 install -e .`
- **Testing**: `pytest tests/` (when dependencies are available)

### AWS Lambda Functions
- **Locations**: `/aws/lambda/*` directories
- **Each has own Makefile and requirements.txt**
- **Technology**: Python-based
- **Build**: `make build` in respective directories

## Validation Scenarios

After making changes, ALWAYS run these validation scenarios to ensure functionality:

### TorchCI Web Application Validation
1. **Build validation**: `cd torchci && yarn install --frozen-lockfile && yarn build`
2. **Development server test**: `yarn dev` - verify starts on http://localhost:3000
3. **Code quality**: `yarn lint && yarn tsc && yarn test`
4. **Manual testing**: If server starts, basic page loads confirm core functionality

### Lambda Infrastructure Validation
1. **Runner lambda**: `cd terraform-aws-github-runner/modules/runners/lambdas/runners && yarn commit-check`
2. **Other lambdas**: Check Makefile in `/aws/lambda/*` directories and run `make build`

### Repository-wide Validation
1. **Linting**: `lintrunner --force-color --all-files` (may take 5-10 minutes)
2. **Formatting**: Included in lintrunner workflow
3. **Python tools**: Test individual tools with their specific requirements

## Critical Timing and Timeout Information

- **TorchCI yarn install**: 82 seconds - Set timeout to 120+ seconds. NEVER CANCEL.
- **TorchCI yarn build**: 107 seconds - Set timeout to 180+ seconds. NEVER CANCEL.
- **Lambda yarn commit-check**: 60 seconds - Set timeout to 120+ seconds. NEVER CANCEL.
- **Lintrunner init**: 26 seconds - Set timeout to 60+ seconds. NEVER CANCEL.
- **Full repository linting**: 5-10 minutes - Set timeout to 15+ minutes. NEVER CANCEL.
- **Python pip installs**: May timeout due to network - document but continue with available tools

## Common Issues and Workarounds

### Network Limitations
- **pip install timeouts**: Document as "pip install fails due to network limitations"
- **actionlint S3 download fails**: Expected in restricted environments, other linters work
- **Always wait full timeout periods** before concluding failures

### Missing Dependencies
- **TorchCI .env.local**: Most functionality requires API credentials, but basic build/dev server works
- **AWS credentials**: Lambda testing requires AWS access, but builds work without

### Build Failures
- **Always run lintrunner** before committing changes to catch formatting/style issues
- **TypeScript errors**: Run `yarn tsc` to catch before build
- **Test failures**: Run individual test suites to isolate issues

## Key Projects Summary

1. **TorchCI** (`/torchci`): Main web dashboard (hud.pytorch.org) - Next.js application
2. **GitHub Runner Infrastructure** (`/terraform-aws-github-runner`): AWS-based CI runner management
3. **Python Utilities** (`/tools`, `/aws/lambda`): CI/CD automation and monitoring tools
4. **Linting Infrastructure** (`/.lintrunner.toml`): Multi-language code quality enforcement

## Repository Quick Facts
- **Primary languages**: TypeScript, Python, HCL (Terraform)
- **Package managers**: yarn (Node.js), pip (Python)
- **Build systems**: Next.js, tsc, ncc, Make
- **Testing**: Jest (JS/TS), pytest (Python)
- **Linting**: lintrunner with 15+ specialized linters
- **Main branch**: `main`
- **CI/CD**: GitHub Actions (see `.github/workflows/`)

Always build and exercise your changes using the validation scenarios above to ensure they integrate properly with the existing infrastructure.