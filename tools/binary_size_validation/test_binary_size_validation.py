from binary_size_validation import parse_index

# ignore long lines in this file
# flake8: noqa: E501
test_html = """
<!DOCTYPE html>
<html>
  <body>
    <h1>Links for torch</h1>
    <a href="/whl/nightly/cpu/torch-1.13.0.dev20220728%2Bcpu-cp310-cp310-linux_x86_64.whl">torch-1.13.0.dev20220728+cpu-cp310-cp310-linux_x86_64.whl</a><br/>
    <a href="/whl/nightly/cpu/torch-1.13.0.dev20220728%2Bcpu-cp310-cp310-win_amd64.whl">torch-1.13.0.dev20220728+cpu-cp310-cp310-win_amd64.whl</a><br/>
    <a href="/whl/nightly/cpu/torch-1.13.0.dev20220728%2Bcpu-cp37-cp37m-linux_x86_64.whl">torch-1.13.0.dev20220728+cpu-cp37-cp37m-linux_x86_64.whl</a><br/>
    <a href="/whl/nightly/cpu/torch-1.13.0.dev20220728%2Bcpu-cp37-cp37m-win_amd64.whl">torch-1.13.0.dev20220728+cpu-cp37-cp37m-win_amd64.whl</a><br/>
    <a href="/whl/nightly/rocm5.3/torch-2.0.0.dev20230206%2Brocm5.3-cp39-cp39-linux_x86_64.whl">torch-2.0.0.dev20230206+rocm5.3-cp39-cp39-linux_x86_64.whl</a><br/>
    <a href="/whl/nightly/rocm5.3/torch-2.0.0.dev20230207%2Brocm5.3-cp310-cp310-linux_x86_64.whl">torch-2.0.0.dev20230207+rocm5.3-cp310-cp310-linux_x86_64.whl</a><br/>
    <a href="/whl/nightly/rocm5.3/torch-2.0.0.dev20230207%2Brocm5.3-cp38-cp38-linux_x86_64.whl">torch-2.0.0.dev20230207+rocm5.3-cp38-cp38-linux_x86_64.whl</a><br/>
    <a href="/whl/nightly/rocm5.3/torch-2.0.0.dev20230207%2Brocm5.3-cp39-cp39-linux_x86_64.whl">torch-2.0.0.dev20230207+rocm5.3-cp39-cp39-linux_x86_64.whl</a><br/>
  </body>
</html>
<!--TIMESTAMP 1675892605-->
"""

base_url = "https://download.pytorch.org/whl/nightly/torch/"


def test_get_whl_links():
    wheels = parse_index(test_html, base_url)
    assert len(wheels) == 8
    assert (
        wheels[0].url
        == "https://download.pytorch.org/whl/nightly/cpu/torch-1.13.0.dev20220728%2Bcpu-cp310-cp310-linux_x86_64.whl"
    )


def test_include_exclude():
    wheels = parse_index(test_html, base_url, "amd6\\d")
    assert len(wheels) == 2
    assert wheels[0].name == "torch-1.13.0.dev20220728+cpu-cp310-cp310-win_amd64.whl"
    assert wheels[1].name == "torch-1.13.0.dev20220728+cpu-cp37-cp37m-win_amd64.whl"

    wheels = parse_index(test_html, base_url, "amd6\\d", "cp37")
    assert len(wheels) == 1
    assert wheels[0].name == "torch-1.13.0.dev20220728+cpu-cp310-cp310-win_amd64.whl"


def test_latest_version_only():
    wheels = parse_index(test_html, base_url, latest_version_only=True)
    assert len(wheels) == 3
    assert all(w.name.startswith("torch-2.0.0.dev20230207") for w in wheels)
