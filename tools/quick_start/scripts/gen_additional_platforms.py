#!/usr/bin/env python3
"""
Generates additional-platforms.json for the
https://pytorch.org/get-started/additional-platforms/ page.

Usage:
    python3 scripts/gen_additional_platforms.py

The script will:
1. Read all JSON files from _additional_platforms/ directory
2. Read all MD files from _get_started/additional_platforms/ directory
   and convert them to HTML
3. Combine platform data into a single object (keyed by filename)
4. Write the result to additional-platforms.json
"""

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Set

import markdown
from markdown.extensions.codehilite import CodeHiliteExtension


BASE_DIR = Path(__file__).parent.parent
ADDITIONAL_PLATFORM_DIR = BASE_DIR / "_additional_platforms"
MARKDOWN_DIR = BASE_DIR / "_get_started" / "additional_platforms"

# External consumer JSON bundle
# Bump SCHEMA_VERSION on any breaking change
# to the `platforms` / `html` shape.
SCHEMA_VERSION = 1
JSON_OUT_PATH = "additional-platforms.json"

# Schema definitions derived from additional_platforms.md
REQUIRED_TOP_LEVEL_FIELDS: Set[str] = {"name", "support_channel", "stable"}
ALLOWED_TOP_LEVEL_FIELDS: Set[str] = {"name", "support_channel", "stable", "preview"}
# At least one OS key from ALLOWED_INSTALL_KEYS must be present in stable/preview
ALLOWED_INSTALL_KEYS: Set[str] = {"linux", "windows"}
MAX_MARKDOWN_LINES: int = 200


def validate_platform_json(
    platform_id: str, data: Dict[str, Any], filename: str
) -> None:
    """Validate a platform JSON against the schema defined in additional_platforms.md.

    Checks that:
    1. All required top-level fields are present (name, support_channel, stable; preview is optional)
    2. No extra/unknown top-level fields are present
    3. 'stable' and 'preview' objects (if present) contain at least one OS key ('linux' or 'windows')
    4. 'stable' and 'preview' objects (if present) only contain allowed keys ('linux', 'windows')

    Raises RuntimeError if any validation check fails.
    """
    errors: List[str] = []

    # Check required top-level fields
    present_fields = set(data.keys())
    missing_fields = REQUIRED_TOP_LEVEL_FIELDS - present_fields
    if missing_fields:
        errors.append(
            f"Missing required fields: {sorted(missing_fields)}. "
            f"Required fields are: {sorted(REQUIRED_TOP_LEVEL_FIELDS)}"
        )

    # Check for extra/unknown top-level fields
    extra_fields = present_fields - ALLOWED_TOP_LEVEL_FIELDS
    if extra_fields:
        errors.append(
            f"Unknown fields: {sorted(extra_fields)}. "
            f"Only allowed fields are: {sorted(ALLOWED_TOP_LEVEL_FIELDS)}"
        )

    # Validate 'stable' and 'preview' objects
    for field in ["stable", "preview"]:
        if field in data:
            install_data = data[field]
            if not isinstance(install_data, dict):
                errors.append(
                    f"Field '{field}' must be an object, got {type(install_data).__name__}"
                )
            else:
                install_keys = set(install_data.keys())

                # Check that at least one allowed OS key is present
                present_install_keys = install_keys & ALLOWED_INSTALL_KEYS
                if not present_install_keys:
                    errors.append(
                        f"Field '{field}' must contain at least one OS key from "
                        f"{sorted(ALLOWED_INSTALL_KEYS)}, but found none. "
                        f"Existing keys: {sorted(install_keys)}"
                    )

                # Check for unknown install keys
                extra_install_keys = install_keys - ALLOWED_INSTALL_KEYS
                if extra_install_keys:
                    errors.append(
                        f"Field '{field}' contains unknown OS key(s): "
                        f"{sorted(extra_install_keys)}. "
                        f"Only allowed OS keys are: {sorted(ALLOWED_INSTALL_KEYS)}"
                    )

    if errors:
        error_msg = "\n  - ".join(errors)
        raise RuntimeError(
            f"Validation error in {filename} (platform_id: {platform_id}):\n  - {error_msg}"
        )


def read_platform_json_files() -> Dict[str, Any]:
    """Read all JSON files from _additional_platforms directory and validate them."""
    platform_data: Dict[str, Any] = {}

    if not ADDITIONAL_PLATFORM_DIR.exists():
        print(f"Warning: {ADDITIONAL_PLATFORM_DIR} does not exist")
        return platform_data

    for json_file in sorted(ADDITIONAL_PLATFORM_DIR.glob("*.json")):
        try:
            content = json_file.read_text(encoding="utf-8")
            data = json.loads(content)
            # Use filename (without .json) as platform_id
            platform_id = json_file.stem
            # Validate the JSON data against the schema
            validate_platform_json(platform_id, data, json_file.name)
            platform_data[platform_id] = data
        except json.JSONDecodeError as e:
            raise RuntimeError(f"Error parsing {json_file.name}: {e}")

    return platform_data


def convert_markdown_to_html(markdown_text: str) -> str:
    """Convert markdown to HTML with syntax highlighting.

    Uses Python markdown library with codehilite extension for syntax highlighting.
    This produces HTML similar to Jekyll's markdownify filter.
    """
    # Remove Jekyll/Kramdown special syntax (e.g., {:.no_toc}, {: #id})
    html_text = re.sub(r"\{:[^}]*\}", "", markdown_text)

    # Convert markdown to HTML with codehilite extension
    # Codehilite uses Pygments for syntax highlighting (similar to Rouge used by Jekyll)
    md = markdown.Markdown(
        extensions=[
            CodeHiliteExtension(
                css_class="highlight", guess_lang=False, linenums=False
            ),
            "fenced_code",
            "tables",
            "toc",
        ]
    )

    html = md.convert(html_text)
    return html


def validate_markdown_file(platform_id: str, content: str, filename: str) -> None:
    """Validate a markdown file against the rules defined in additional_platforms.md.

    Checks that:
    1. The markdown file does not exceed 200 lines

    Raises RuntimeError if any validation check fails.
    """
    errors: List[str] = []

    line_count = len(content.splitlines())
    if line_count > MAX_MARKDOWN_LINES:
        errors.append(
            f"Markdown file exceeds maximum line limit: {line_count} lines "
            f"(maximum allowed: {MAX_MARKDOWN_LINES} lines)"
        )

    if errors:
        error_msg = "\n  - ".join(errors)
        raise RuntimeError(
            f"Validation error in {filename} (platform_id: {platform_id}):\n  - {error_msg}"
        )


def read_markdown_files() -> Dict[str, str]:
    """Read all markdown files from _get_started/additional_platforms directory,
    validate them, and convert them to HTML with syntax highlighting."""
    html_content: Dict[str, str] = {}

    if not MARKDOWN_DIR.exists():
        print(f"Warning: {MARKDOWN_DIR} does not exist")
        return html_content

    for md_file in sorted(MARKDOWN_DIR.glob("*.md")):
        try:
            content = md_file.read_text(encoding="utf-8")
            # Use filename (without .md) as platform_id
            platform_id = md_file.stem
            # Validate the markdown content
            validate_markdown_file(platform_id, content, md_file.name)
            # Convert markdown to HTML with syntax highlighting
            html = convert_markdown_to_html(content)
            html_content[platform_id] = html
        except Exception as e:
            raise RuntimeError(f"Error processing {md_file.name}: {e}")

    return html_content


def generate() -> Dict[Path, str]:
    """Return the regenerated files as {path: content}."""
    payload = {
        "schema_version": SCHEMA_VERSION,
        "platforms": read_platform_json_files(),
        "html": read_markdown_files(),
    }
    content = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    return {BASE_DIR / JSON_OUT_PATH: content}


def main():
    for path, content in generate().items():
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(content)
        print(f"Wrote {path}")


if __name__ == "__main__":
    main()
