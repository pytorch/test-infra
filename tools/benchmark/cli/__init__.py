import inspect
import os


# Allow import only if caller is cli.* or being executed as CLI script
caller = inspect.stack()[1].frame.f_globals.get("__name__", "")
env_calling_cli_directly = os.environ.get("ALLOW_CLI_IMPORT", "") == "1"

if not (
    caller.startswith("cli.")
    or caller == "__main__"
    or "pt2-bm-cli" in os.path.basename(inspect.stack()[-1].filename)
    or env_calling_cli_directly
):
    raise ImportError(
        "The 'cli' package is internal to the command-line interface. Do not import it from non-CLI modules."
    )
