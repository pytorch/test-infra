import datetime
import json
import os
import pathlib
import re
from typing import Any, Callable, cast, Dict, List, Optional
from urllib.request import urlopen


FILE_CACHE_LIFESPAN_SECONDS = datetime.timedelta(hours=3).seconds
DISABLED_TESTS_FILE = ".pytorch-disabled-tests.json"
MODULE_OWNERS = [
    "NNC",
    "module: __torch_dispatch__",
    "module: __torch_function__",
    "module: 64-bit",
    "module: abi",
    "module: advanced indexing",
    "module: amp (automated mixed precision)",
    "module: android",
    "module: arm",
    "module: assert failure",
    "module: autograd",
    "module: backend",
    "module: batching",
    "module: bazel",
    "module: bc-breaking",
    "module: benchmark",
    "module: bfloat16",
    "module: boolean tensor",
    "module: bootcamp",
    "module: bottleneck",
    "module: build",
    "module: build warnings",
    "module: c10d",
    "module: CapabilityBasedPartitioner",
    "module: checkpoint",
    "module: ci",
    "module: codegen",
    "module: collect_env.py",
    "module: complex",
    "module: convolution",
    "module: correctness (silent)",
    "module: cpp",
    "module: cpp-extensions",
    "module: cpu",
    "module: CPU_tensor_apply",
    "module: crash",
    "module: cublas",
    "module: cuda",
    "module: cuda graphs",
    "module: CUDACachingAllocator",
    "module: cudnn",
    "module: custom-operators",
    "module: data",
    "module: data parallel",
    "module: dataloader", "module: ddp", "module: deadlock", "module: dependency bug", "module: deploy", "module: deprecation", "module: derivatives", "module: determinism", "module: dispatch", "module: distance functions", "module: distributions", "module: dlpack", "module: doc infra", "module: docker", "module: docs", "module: double backwards", "module: dynamic shapes", "module: edge cases", "module: elastic", "module: embedding", "module: error checking", "module: expecttest", "module: fakeTensor", "module: fft", "module: flaky-tests", "module: forward ad", "module: fsdp", "module: functional UX", "module: functionalization", "module: functorch", "module: fx", "module: fx.passes", "module: half", "module: hub", "module: infra", "module: initialization", "module: int overflow", "module: intel", "module: internals", "module: interpolation", "module: ios", "module: jetson", "module: jiterator", "module: known issue", "module: language binding", "module: lazy", "module: library", "module: linear algebra", "module: lint", "module: logging", "module: loss", "module: LrScheduler", "module: lts", "module: macos", "module: magma", "module: masked operators", "module: memory format", "module: memory usage", "module: meta tensors", "module: mkl", "module: mkldnn", "module: models", "module: molly-guard", "module: mpi", "module: mps", "module: mta", "module: multi-gpu", "module: multiprocessing", "module: multithreading", "module: named tensor", "module: NaNs and Infs", "module: nccl", "module: nestedtensor", "module: nn", "module: nn.utils.parametrize", "module: nnpack", "module: norms and normalization", "module: numba", "module: numerical-reproducibility", "module: numerical-stability", "module: numpy", "module: nvfuser", "module: onnx", "module: op-unification", "module: openblas", "module: openmp", "module: optimizer", "module: padding", "module: partial aliasing", "module: performance", "module: pickle", "module: pooling", "module: porting", "module: POWER", "module: primTorch", "module: printing", "module: protobuf", "module: ProxyTensor", "module: pruning", "module: pybind", "module: python array api", "module: python frontend", "module: pytree", "module: random", "module: reductions", "module: regression", "module: rnn", "module: rocm", "module: rpc", "module: safe resize", "module: sanitizers", "module: scatter & gather ops", "module: scientific computing", "module: selective build", "module: serialization", "module: shape checking", "module: single threaded", "module: sleef", "module: sorting and selection", "module: sparse", "module: special", "module: static linking", "module: structured kernels", "module: tbb", "module: tensor creation", "module: tensorboard", "module: tensorflow", "module: TensorIterator", "module: tensorpipe", "module: testing", "module: tests", "module: tf32", "module: third_party", "module: torchbind", "module: torchdynamo", "module: trigonometric functions", "module: type promotion", "module: typing", "module: undefined reference", "module: unknown", "module: ux", "module: vectorization", "module: viewing and reshaping", "module: vision", "module: vmap", "module: vulkan", "module: windows", "module: wsl", "module: xla",
    "module: xnnpack",
    "oncall: binaries", "oncall: distributed", "oncall: fx", "oncall: java", "oncall: jit", "oncall: mobile", "oncall: package/deploy", "oncall: profiler", "oncall: quantization", "oncall: r2p", "oncall: transformer/mha", "oncall: visualization",
]

def fetch(
    dirpath: str,
    name: str,
    url: str,
    process_fn: Callable[[Dict[str, Any]], Dict[str, Any]],
) -> Dict[str, Any]:
    """
    This fetch and cache utils allows sharing between different process.
    """
    path = os.path.join(dirpath, name)
    print(f"Downloading {url} to {path}")

    for _ in range(3):
        try:
            contents = urlopen(url, timeout=5).read().decode("utf-8")
            processed_contents = process_fn(json.loads(contents))
            with open(path, "w") as f:
                f.write(json.dumps(processed_contents))
            return processed_contents
        except Exception as e:
            print(f"Could not download {url} because: {e.__str__()}.")
    print(f"All retries exhausted, downloading {url} failed.")
    return {}

def write_issues_to_csv(
    dirpath: str, filename: str = DISABLED_TESTS_FILE
) -> Optional[Dict[str, Any]]:
    url = "https://raw.githubusercontent.com/pytorch/test-infra/generated-stats/stats/disabled-tests.json"
    def process_disabled_test(the_response: Dict[str, Any]) -> None:
        with open("disabled_tests.csv", "w") as f:
                f.write("Test,Issue,URL,Platforms,Labels\n")
                for item in the_response["items"]:
                    title = item["title"]
                    key = "DISABLED "
                    if title.startswith(key):
                        issue_url = item["html_url"]
                        issue_number = issue_url.split("/")[-1]
                        ignore_labels = ["skipped", "module: flaky-tests", "triaged", "high priority", "triage review"]
                        issue_labels = [d["name"] for d in item["labels"] if d["name"] not in ignore_labels]
                        test_name = title[len(key) :].strip()
                        body = item["body"]
                        platforms_to_skip = []
                        key = "platforms:"
                        # When the issue has no body, it is assumed that all platforms should skip the test
                        if body is not None:
                            for line in body.splitlines():
                                line = line.lower()
                                if line.startswith(key):
                                    pattern = re.compile(r"^\s+|\s*,\s*|\s+$")
                                    platforms_to_skip.extend(
                                        [x for x in pattern.split(line[len(key) :]) if x]
                                    )
                        f.write(f"{test_name},{issue_number},{issue_url}," +
                            f"\"{','.join(platforms_to_skip)}\", \"{','.join(issue_labels)}\"\n")
        for owner in MODULE_OWNERS:
            with open(f"{owner.replace(' ', '_').replace('/', '_')}_disabled_tests.csv", "w") as f:
                f.write("Test,Issue,URL,Platforms,Labels\n")
                for item in the_response["items"]:
                    title = item["title"]
                    key = "DISABLED "
                    if title.startswith(key):
                        ignore_labels = ["skipped", "module: flaky-tests", "triaged", "high priority", "triage review"]
                        issue_labels = [d["name"] for d in item["labels"] if d["name"] not in ignore_labels]
                        if owner in issue_labels:
                            test_name = title[len(key) :].strip()
                            body = item["body"]
                            issue_url = item["html_url"]
                            issue_number = issue_url.split("/")[-1]
                            platforms_to_skip = []
                            key = "platforms:"
                            # When the issue has no body, it is assumed that all platforms should skip the test
                            if body is not None:
                                for line in body.splitlines():
                                    line = line.lower()
                                    if line.startswith(key):
                                        pattern = re.compile(r"^\s+|\s*,\s*|\s+$")
                                        platforms_to_skip.extend(
                                            [x for x in pattern.split(line[len(key) :]) if x]
                                        )
                            f.write(f"{test_name},{issue_number},{issue_url}," +
                                f"\"{','.join(platforms_to_skip)}\", \"{','.join(issue_labels)}\"\n")


    return fetch(dirpath, filename, url, process_disabled_test)

def main() -> None:
    write_issues_to_csv("./")

if __name__ == "__main__":
    main()