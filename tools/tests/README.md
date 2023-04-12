# Testing during CI
The tests in this folder are automatically executed during CI by `.github/workflows/tests.yml`.  

If you add a new test that requires installing additional modules, please update the `pip install` command in that workflow.

# Local Testing
To run these tests locally, run the same commands that tests.yml workflow executes:

1. From the test-infra directory, create a new virtual environment: `python -m venv .venv/`
2. Activate it: `source .venv/bin/activate`
3. Install any pip packages you need. If you need something beyond what `.github/workflows/tests.yml` installs, please update the list in that workflow
4. Run your tests from the test-infra dir with: `python3 -m unittest discover -vs tools/tests -p 'test_*.py'`