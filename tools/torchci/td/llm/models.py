"""The embedding models the LLM TD heuristic may use: registry, download, loading."""

import hashlib
import os
import re
import stat
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Mapping, Optional, Sequence

import numpy as np


# Bundles add the Apache-2.0 text under this name when the snapshot has none.
LICENSE_NAME = "LICENSE"
# Older sentence-transformers import any class path a local modules.json names.
MIN_SENTENCE_TRANSFORMERS_MAJOR = 6

QWEN3_QUERY_PROMPT = (
    "Instruct: Given a code change from a pull request, retrieve the unit tests that"
    " exercise the changed code\nQuery: "
)


class SnapshotError(Exception):
    pass


@dataclass(frozen=True)
class ModelSpec:
    key: str
    repo: str
    revision: str
    query_prompt: str
    doc_prompt: str
    max_tokens: int = 256
    # Relative path in the snapshot -> (sha256 hex, size in bytes). A model without
    # them can be neither downloaded nor bundled.
    files: Mapping[str, tuple[str, int]] = field(default_factory=dict)


def _files(table: str) -> dict[str, tuple[str, int]]:
    """Parse lines of `<sha256> <size> <relative path>`."""
    files = {}
    for line in table.splitlines():
        if line.strip():
            sha256, size, rel = line.split(maxsplit=2)
            files[rel] = (sha256, int(size))
    return files


MODELS: dict[str, ModelSpec] = {
    spec.key: spec
    for spec in [
        ModelSpec(
            key="qwen3-0.6b",
            repo="Qwen/Qwen3-Embedding-0.6B",
            revision="97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3",
            query_prompt=QWEN3_QUERY_PROMPT,
            doc_prompt="",
            files=_files(
                """
37bf193fa101f19101bfad9c31d3eb0f786e247b7b1e5cb7f007d730eed1ddbd 313 1_Pooling/config.json
b5bf1f51fc45be473a54718cef92448d90a1be001bf9b9a44b8c7f10a19feaa9 727 config.json
10667c72ddb772627bf1780cb7f86af8e2ae0032b8c243c731172064105c6961 215 config_sentence_transformers.json
28396d421a2108acce96383f6a7de78008f7f1b17f807958f3c14c51dbfb65fb 117 generation_config.json
8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5 1671853 merges.txt
0437e45c94563b09e13cb7a64478fc406947a93cb34a7e05870fc8dcd48e23fd 1191586416 model.safetensors
84e40c8e006c9b1d6c122e02cba9b02458120b5fb0c87b746c41e0207cf642cf 349 modules.json
def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a 11423705 tokenizer.json
253153d0738ceb4c668d2eff957714dd2bea0b56de772a9fdccd96cbf517e6a0 9706 tokenizer_config.json
ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910 2776833 vocab.json
"""
            ),
        ),
        ModelSpec(
            key="qwen3-4b",
            repo="Qwen/Qwen3-Embedding-4B",
            revision="5cf2132abc99cad020ac570b19d031efec650f2b",
            query_prompt=QWEN3_QUERY_PROMPT,
            doc_prompt="",
            files=_files(
                """
0f0ed3380602b252fced3fab6d07c76752c32ffca818ccc61afaf17ae8edd96f 313 1_Pooling/config.json
78d2861cbbfd80eee05839200c5a3b7ed64c789f6c1cab4fbb84cc4eae33eaf5 727 config.json
10667c72ddb772627bf1780cb7f86af8e2ae0032b8c243c731172064105c6961 215 config_sentence_transformers.json
28396d421a2108acce96383f6a7de78008f7f1b17f807958f3c14c51dbfb65fb 117 generation_config.json
8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5 1671853 merges.txt
e70bfe3c970523fb7ef4eddffed2254ce3f1e7150c3de2af4342de129dd756f8 4965826464 model-00001-of-00002.safetensors
ed1b87c8e9eb7e535a1a155e4fd00d9f4dba80e58a6db48a4c9f82cede7079c1 3077765624 model-00002-of-00002.safetensors
9d130c7f24fa1f9a2a7e19fad42c7d6d2d6fea31b180bdf3e8aac1924c26c39a 30431 model.safetensors.index.json
84e40c8e006c9b1d6c122e02cba9b02458120b5fb0c87b746c41e0207cf642cf 349 modules.json
83cdf8c3a34f68862319cb1810ee7b1e2c0a44e0864ae930194ddb76bb7feb8d 11422947 tokenizer.json
2f58f4bbd7bbce15d683f525954ef3a92cd82f5e06415a9c513859bf8ab72436 7256 tokenizer_config.json
ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910 2776833 vocab.json
"""
            ),
        ),
        ModelSpec(
            key="qwen3-8b",
            repo="Qwen/Qwen3-Embedding-8B",
            revision="1d8ad4ca9b3dd8059ad90a75d4983776a23d44af",
            query_prompt=QWEN3_QUERY_PROMPT,
            doc_prompt="",
            files=_files(
                """
2e1da26b3fd65cf7e370d2fabf28a8c59efa7edb525d1b8b50be8e5ca1048ea6 313 1_Pooling/config.json
832dd9e00a68dd83b3c3fb9f5588dad7dcf337a0db50f7d9483f310cd292e92e 11343 LICENSE
dcccf7c7890c8debc4af8dace8d6acd8dd50bd56d50d4d8b60529381ba3de3d7 729 config.json
10667c72ddb772627bf1780cb7f86af8e2ae0032b8c243c731172064105c6961 215 config_sentence_transformers.json
28396d421a2108acce96383f6a7de78008f7f1b17f807958f3c14c51dbfb65fb 117 generation_config.json
8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5 1671853 merges.txt
99b343597fe840706146144699a8b9188dd3387e43eb61faf0231b70b249d451 4900037024 model-00001-of-00004.safetensors
dff635b0f6dbbaad2a2d633ef037ec0a39bc165cc1806c712fbd6fcbcb4526c0 4915959512 model-00002-of-00004.safetensors
30b1d4c53d84eb018f642cad7b373f0aabf79699872d8702c1f38577c0a59a2f 4983067656 model-00003-of-00004.safetensors
36cbc9c60375693629f25743c1e77ebb1724af58e671b2376463193c7fd21ef6 335570376 model-00004-of-00004.safetensors
ceaf1429bfa18eecc75d079737e8d1fe8dc0627f5ec7e6a985514626d1ac6a77 30432 model.safetensors.index.json
84e40c8e006c9b1d6c122e02cba9b02458120b5fb0c87b746c41e0207cf642cf 349 modules.json
83cdf8c3a34f68862319cb1810ee7b1e2c0a44e0864ae930194ddb76bb7feb8d 11422947 tokenizer.json
2f58f4bbd7bbce15d683f525954ef3a92cd82f5e06415a9c513859bf8ab72436 7256 tokenizer_config.json
ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910 2776833 vocab.json
"""
            ),
        ),
        ModelSpec(
            key="gemma2",
            repo="google/embeddinggemma-2",
            revision="f9972ac22e696a105c482202646979e33e4b5a1e",
            query_prompt="task: code retrieval | query: ",
            doc_prompt="title: none | text: ",
            files=_files(
                """
8759bdf7c77efc7df7723f64856a593c8943b71ee38baf2a88771fbaf78438f9 90 1_Pooling/config.json
cdb09dfca347a56aa2d691744e38d5ad3c7cbc2834e7181272b9a15328b82524 97 2_Normalize/config.json
4b852efc0b9960283e735363331e6f325b33bc74bdbaa076f595bc4e9b94d85e 1016 chat_template.jinja
b8f1e9931b57fbc054acdb445c41765d55b0074c58d145fa82839941ad1b5bb3 4455 config.json
031e56a498d33c349ab489a21885bcfe25b4fcba841149dc99e1e90d4a7c28f5 1565 config_sentence_transformers.json
197a32965d4b1105faf060417baa899e193fb73cd401f42ec9295234d5553d79 1488915288 model.safetensors
3d02572a0455b832de67fb8e63a54981bc7e8b46e337c95e917bd8122a533bfd 413 modules.json
ea2ae257e901064abdd98dceb19f2b0da06af600bed15e0f99f5c85c37ee9d78 511 preprocessor_config.json
168f6a08522f3ce5dea596d94d003af2fd691742d4f41fe1f9d8cce76bfbf69c 1788 processor_config.json
b1bcd9f2dce3ae863b359e87d0710b5dbc3314a59ecb4e2f97c7778fc8e4b228 747 sentence_bert_config.json
4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4 32170510 tokenizer.json
e594c8a90eb08d8bda498ff4747977dc827ae0c3c56b5c0d41a605a22d02ef03 4689013 tokenizer.model
17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874 1599 tokenizer_config.json
"""
            ),
        ),
    ]
}
DEFAULT_MODEL = "qwen3-0.6b"


def require_files(spec: ModelSpec) -> None:
    if not spec.files:
        raise SnapshotError(f"model {spec.key} has no committed file hashes")


def file_sha256(path: Path) -> str:
    with open(path, "rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def verify_snapshot(spec: ModelSpec, model_dir: Path) -> None:
    """Raise SnapshotError unless model_dir holds exactly spec.files (and LICENSE)."""
    require_files(spec)
    model_dir = Path(model_dir)
    allowed_dirs = {""}
    for rel in spec.files:
        parent = os.path.dirname(rel)
        while parent:
            allowed_dirs.add(parent)
            parent = os.path.dirname(parent)
    allowed_files = set(spec.files) | {LICENSE_NAME}
    for root, dirs, names in os.walk(model_dir):
        rel_root = os.path.relpath(root, model_dir)
        rel_root = "" if rel_root == "." else Path(rel_root).as_posix()
        for name in dirs:
            rel = f"{rel_root}/{name}" if rel_root else name
            if rel not in allowed_dirs or os.path.islink(os.path.join(root, name)):
                raise SnapshotError(f"unexpected directory in the model: {rel}")
        for name in names:
            rel = f"{rel_root}/{name}" if rel_root else name
            if rel not in allowed_files:
                raise SnapshotError(f"unexpected file in the model: {rel}")
            if os.path.islink(os.path.join(root, name)):
                raise SnapshotError(f"model file is not a regular file: {rel}")
    for rel, (sha256, size) in sorted(spec.files.items()):
        path = model_dir / rel
        try:
            info = os.lstat(path)
        except FileNotFoundError:
            raise SnapshotError(f"model file missing: {rel}") from None
        if not stat.S_ISREG(info.st_mode):
            raise SnapshotError(f"model file is not a regular file: {rel}")
        if info.st_size != size:
            raise SnapshotError(
                f"model file {rel} has {info.st_size} bytes, expected {size}"
            )
        if file_sha256(path) != sha256:
            raise SnapshotError(f"model file {rel} does not match its sha256")


def download(spec: ModelSpec, dest: Path) -> Path:
    """Fetch the committed files of spec into dest, verified, and return dest.

    A non-empty dest is verified and returned as it is.
    """
    from huggingface_hub import snapshot_download

    require_files(spec)
    dest = Path(dest)
    if dest.is_dir() and any(dest.iterdir()):
        verify_snapshot(spec, dest)
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        dir=dest.parent, prefix=f".{dest.name}.download-"
    ) as tmp:
        fetched = Path(tmp) / "fetched"
        staged = Path(tmp) / "model"
        # The patterns are matched with fnmatch; the committed paths hold none of
        # its wildcards, so each one selects exactly that file.
        snapshot_download(
            spec.repo,
            revision=spec.revision,
            local_dir=fetched,
            allow_patterns=sorted(spec.files),
        )
        for rel in sorted(spec.files):
            source = fetched / rel
            if not source.is_file():
                raise SnapshotError(f"model file missing from the download: {rel}")
            target = staged / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(source, target)
        verify_snapshot(spec, staged)
        os.replace(staged, dest)
    return dest


def token_counts(model_dir: Path, texts: Sequence[str]) -> list[int]:
    """Tokens per text with the model's own tokenizer, before any truncation."""
    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(str(model_dir), local_files_only=True)
    encoded = tokenizer(list(texts), add_special_tokens=False)["input_ids"]
    return [len(ids) for ids in encoded]


def _major_version(version: str) -> int:
    match = re.match(r"\d+", version)
    return int(match.group()) if match else 0


class Embedder:
    """A sentence-transformers model loaded from a local directory, offline."""

    def __init__(
        self,
        spec: ModelSpec,
        model_dir: Path,
        threads: Optional[int] = None,
    ) -> None:
        import sentence_transformers
        import torch

        version = sentence_transformers.__version__
        if _major_version(version) < MIN_SENTENCE_TRANSFORMERS_MAJOR:
            raise RuntimeError(
                f"sentence-transformers >= {MIN_SENTENCE_TRANSFORMERS_MAJOR} is"
                f" required, found {version}"
            )
        if threads is not None:
            torch.set_num_threads(threads)
        self.spec = spec
        self._model = sentence_transformers.SentenceTransformer(
            str(model_dir),
            trust_remote_code=False,
            local_files_only=True,
            model_kwargs={"dtype": torch.bfloat16, "use_safetensors": True},
        )
        self._model.max_seq_length = spec.max_tokens

    @property
    def dim(self) -> int:
        return int(self._model.get_embedding_dimension())

    def encode(
        self,
        texts: Sequence[str],
        kind: Literal["query", "doc"],
        batch_size: int = 16,
    ) -> np.ndarray:
        if kind == "query":
            prompt = self.spec.query_prompt
        elif kind == "doc":
            prompt = self.spec.doc_prompt
        else:
            raise ValueError(f"unknown text kind: {kind}")
        if not texts:
            return np.zeros((0, self.dim), dtype=np.float32)
        # An explicit prompt, even "", keeps a model's default prompt from applying.
        embeddings = self._model.encode(
            list(texts),
            prompt=prompt,
            batch_size=batch_size,
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
        embeddings = np.asarray(embeddings, dtype=np.float32)
        # Normalizing in bfloat16 leaves norms up to ~0.2% off 1: redo it in float32.
        norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
        return embeddings / np.maximum(norms, np.finfo(np.float32).tiny)
