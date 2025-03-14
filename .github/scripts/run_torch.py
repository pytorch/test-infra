import faulthandler
import time

faulthandler.enable()  # by default will dump on sys.stderr, but can also print to a regular file

import torch
