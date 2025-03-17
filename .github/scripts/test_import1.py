import pdb
import faulthandler
faulthandler.enable()

print("Before torch import")
import torch
print(torch.__version__)
