import torch as troch

A = troch.arange(9).reshape(3, 3)
A3 = troch.chain_matmul(A, A, A)

