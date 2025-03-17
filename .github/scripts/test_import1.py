import faulthandler

with open("fault_handler.log", "w") as fobj:
    faulthandler.enable(fobj)
    import torch
    print(torch.__version__)
