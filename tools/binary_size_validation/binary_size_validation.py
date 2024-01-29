# Script that parses wheel index (e.g. https://download.pytorch.org/whl/test/torch/),
# fetches and validates binary size for the files that match the given regex.

import re
from collections import namedtuple
from urllib.parse import urljoin

import click
import requests
from bs4 import BeautifulSoup

Wheel = namedtuple("Wheel", ["name", "url"])


def parse_index(
    html: str,
    base_url: str,
    include_regex: str = "",
    exclude_regex: str = "",
    latest_version_only=False,
) -> list[Wheel]:
    """
    parse the html page and return a list of wheels
    :param html: html page
    :param base_url: base url of the page
    :param include_regex: regex to filter the wheel names. If empty, all wheels are included
    :param exclude_regex: regex to exclude the matching wheel names. If empty, no wheels are excluded
    :param latest_version_only: if True, return the wheels of the latest version only
    :return: list of wheels
    """
    soup = BeautifulSoup(html, "html.parser")

    wheels = []
    for a in soup.find_all("a"):
        wheel_name = a.text
        wheel_url = urljoin(base_url, a.get("href"))
        if (not include_regex or re.search(include_regex, wheel_name)) and (
            not exclude_regex or not re.search(exclude_regex, wheel_name)
        ):
            wheels.append(Wheel(name=wheel_name, url=wheel_url))

    # filter out the wheels that are not the latest version
    if len(wheels) > 0 and latest_version_only:
        # get the prefixes (up to the second '+'/'-' sign) of the wheels
        prefixes = set()
        for wheel in wheels:
            prefix = re.search(r"^([^-+]+[-+][^-+]+)[-+]", wheel.name).group(1)
            if not prefix:
                raise RuntimeError(
                    f"Failed to get version prefix of {wheel.name}"
                    "Please check the regex_filter or don't use --latest-version-only"
                )
            prefixes.add(prefix)
        latest_version = max(prefixes)
        print(f"Latest version prefix: {latest_version}")

        # filter out the wheels that are not the latest version
        wheels = [wheel for wheel in wheels if wheel.name.startswith(latest_version)]

    return wheels


def get_binary_size(file_url: str) -> int:
    """
    get the binary size of the given file
    :param file_url: url of the file
    :return: binary size in bytes
    """
    return int(requests.head(file_url).headers["Content-Length"])


@click.command(help="Validate the binary sizes of the given wheel index.")
@click.option(
    "--url",
    help="url of the wheel index",
    default="https://download.pytorch.org/whl/nightly/torch/",
)
@click.option(
    "--include",
    help="regex to filter the wheel names. Only the matching wheel names will be checked.",
    default="",
)
@click.option(
    "--exclude",
    help="regex to exclude wheel names. Matching wheel names will NOT be checked.",
    default="",
)
@click.option("--threshold", help="threshold in MB, optional", default=0)
@click.option(
    "--only-latest-version",
    help="only validate the latest version",
    is_flag=True,
    show_default=True,
    default=False,
)
def main(url, include, exclude, threshold, only_latest_version):
    page = requests.get(url)
    wheels = parse_index(page.text, url, include, exclude, only_latest_version)
    for wheel in wheels:
        print(f"Validating {wheel.url}...")
        size = get_binary_size(wheel.url)
        print(f"{wheel.name}: {int(size) / 1024 / 1024:.2f} MB")
        if threshold and int(size) > threshold * 1024 * 1024:
            raise RuntimeError(
                f"Binary size of {wheel.name} {int(size) / 1024 / 1024:.2f} MB exceeds the threshold {threshold} MB"
            )


if __name__ == "__main__":
    main()
