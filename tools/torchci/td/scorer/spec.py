"""The scorer's contract with pytorch's TD job: the feature names written into
td_scorer.json, which pytorch computes the same way by name, and the row schema the
training steps pass along."""

FORMAT = 1
MODEL_FILE = "td_scorer.json"

AREAS = {
    "core_cpp": ("aten/", "c10/", "torch/csrc/"),
    "inductor": ("torch/_inductor/",),
    "dynamo": ("torch/_dynamo/",),
    "distributed": ("torch/distributed/",),
    "build": ("cmake/", "CMakeLists.txt", "setup.py", "pyproject.toml", "requirements"),
    "ci": (".github/", ".ci/"),
}
AREA_FEATURES = tuple(f"area_{a}" for a in AREAS)
NON_SIGNIFICANT_PREFIXES = ("test/", "docs/", "third_party/", ".github/")
NON_SIGNIFICANT_SUFFIXES = (".md", ".rst", ".txt", ".ipynb", ".expect")

UNIT_STATS = ("n_files", "n_src_files", "n_test_files", "docs_only", *AREA_FEATURES)
# TD's heuristics as pytorch serves them: each one's normalised score of the test.
SERVED = (
    "prev_failed",
    "edited",
    "mentioned",
    "fail_n",
    "llm_n",
    "filepath_s",
    "public_bindings",
)
SCORER_FEATURES = (*SERVED, "test_seconds", "is_pr", *UNIT_STATS)
# TD's sum adds every non-trial heuristic's score. The gate replays it, which also needs
# the two heuristics the scorer does not read.
TD_ONLY = ("coedit_n", "profiling_n")
TD_SUM_PARTS = (*SERVED, *TD_ONLY)
# The change stats heuristics.risk_inputs computes for the risk score.
RISK_INPUTS = (
    "log_files",
    "log_src_files",
    "n_test_files",
    "docs_only",
    *AREA_FEATURES,
    "log_sig_added",
    "log_sig_deleted",
)
RISK_FEATURES = RISK_INPUTS

ROW_COLUMNS = (
    "unit_id",
    "kind",
    "time",
    "test",
    "y",
    "w",
    "fresh",
    "full",
    "cost",
    *SCORER_FEATURES,
    *TD_ONLY,
)
UNIT_COLUMNS = (
    "unit_id",
    "kind",
    "time",
    "train_ok",
    "n_positives",
    "uw",
    *RISK_FEATURES,
)
