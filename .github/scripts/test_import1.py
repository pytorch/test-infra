import subprocess

SEGFAULT_PROCESS_RETURNCODE = -11


try:
    subprocess.run(["python3", "-m", "run_torch.py"],
                   check=True)
except subprocess.CalledProcessError as err:
    if err.returncode == SEGFAULT_PROCESS_RETURNCODE:
        print("probably segfaulted")
    else:
        print(f"crashed for other reasons: {err.returncode}")
else:
    print("ok")
