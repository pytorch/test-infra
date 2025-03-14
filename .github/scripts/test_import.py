import traceback

def do_stuff():
    import torch

try:
    do_stuff()
except Exception:
    print(traceback.format_exc())
