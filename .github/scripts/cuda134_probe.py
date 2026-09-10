import torch


print(torch.__version__, torch.version.cuda, torch.version.git_version, flush=True)
print(torch.cuda.get_device_name(), flush=True)
with open("/proc/self/maps") as mappings:
    print(
        "\n".join(
            sorted(
                {
                    line.split()[-1]
                    for line in mappings
                    if "libstdc++" in line or "libgcc_s" in line
                }
            )
        ),
        flush=True,
    )
x = torch.randn(10, 10).cuda()
y = torch.randn(10, 10).cuda()
z = torch.mm(x, y)
torch.cuda.synchronize()
torch.testing.assert_close(z.cpu(), x.cpu() @ y.cpu())
print("Synchronized matmul matched CPU; normal process exit follows", flush=True)
