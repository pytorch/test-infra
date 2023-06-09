import torch
import functorch

batch_size, feature_size = 3, 5
weights = torch.randn(feature_size, requires_grad=True)

def model(feature_vec):
    # Very simple linear model with activation
    return feature_vec.dot(weights).relu()

examples = torch.randn(batch_size, feature_size)
result = functorch.vmap(model)(examples)
print(result)

# Non-runnable, just to check name changes.
def f():
    functorch.vmap()
    functorch.grad()
    functorch.vjp()
    functorch.jvp()
    functorch.jacrev()
    functorch.jacfwd()
    functorch.hessian()
    functorch.functionalize()
