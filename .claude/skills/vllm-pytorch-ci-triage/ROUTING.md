# Repo Routing Cheat-Sheet

Match exception patterns to repo. When multiple patterns match, prefer
the more specific one.

If no pattern exists, give your best guess based on your repo knowledge.


| Error pattern | Repo |
|---|---|
| **Import errors — route by source package** | |
| `ImportError` / `ModuleNotFoundError` from `torch.*` or `torch._inductor.*` | pytorch/pytorch |
| `ImportError` / `ModuleNotFoundError` from `triton.*` | pytorch/pytorch (triton) |
| `ImportError` / `ModuleNotFoundError` from `vllm.*` | vllm-project/vllm |
| Import errors wrapped inside `RuntimeError: Engine core initialization failed` — unwrap to find the real `ImportError` underneath before routing | *(use rules above)* |
| `torch.library.Library.impl ... already a kernel registered` | pytorch/pytorch |
| `MetaProxy` in `prims.*` / Inductor | pytorch/pytorch |
| `PassManager::run failed` inside `triton/` frames | pytorch/pytorch (triton) |
| `Pointer argument cannot be accessed from Triton` | pytorch/pytorch (triton) |
| `Cannot access data pointer of Tensor (FakeTensor…)` | pytorch/pytorch (AOTAutograd) |
| `_pickle.PicklingError` on triton `launcher` | pytorch/pytorch (triton + AOT cache) |
| `warm_artifacts_saved: got 0`, `KeyError: None` in standalone_compile | pytorch/pytorch (Inductor cache) |
| `assert 'no' == 'yes'` in `test_dynamic_shapes_compilation` | pytorch/pytorch (Dynamo), but rerun first if GPU was OOM |
| `torch.compile with fullgraph=True found no compiled frames` (when `TORCH_COMPILE_DISABLE=1` is in env) | vLLM-side fix usually correct; upstream interest if behavior change is intentional |
| `RayChannelTimeoutError` on tp≥2 ray | pytorch/pytorch — likely torch.compile per-worker latency exceeds Ray channel timeout |
| `Nondeterministic outputs detected` (B200-only) | pytorch/pytorch — Blackwell-specific kernel drift |
| `assert torch.allclose(golden_output, vllm_output)` reward/PRM | pytorch/pytorch — numerical drift from triton update |
| `compare_two_settings(... cpu-offload-gb ...)` → "Results are not the same" | pytorch/pytorch (CPU↔GPU dequantize parity) |
| GSM8K accuracy collapses to 0.000 (not just degrades) | pytorch/pytorch — likely worker-side crash hidden behind unpickle error |
| `Generated text "X" doesn't match expected pattern "Y"` on Qwen2-VL / Qwen3-VL LoRA | pytorch/pytorch — multimodal LoRA path numerical drift |
| `AssertionError: expected size N==N, stride A==B` + `torch.ops.vllm.<X>` + "incorrect fake kernel" | **vllm-project/vllm** — fake kernel returns wrong shape |
| Multi-modal per-model assertions (qwen2_vl, chameleon) | vllm-project/vllm first — may be torch-side once isolated |
| Responses API assertion (`'incomplete' == 'completed'`) | vllm-project/vllm |
| `test_lm_eval_accuracy_v1_engine` — measured below threshold | investigate both — often numerical drift from triton update |
| `ValueError: Free memory on device cuda:N (X/Y GiB) … less than desired` (tagged `test_is_infra`) | infra (GPU contention) — rerun the job, do not file; can cascade dozens of unrelated tests, so the real failures may be a subset |
| CUDA OOM (`torch.OutOfMemoryError` / `CUDA out of memory`) in tp≥2 or B200 fusion tests (runner had ~4–5 GiB free at start) | infra likely — **not** tagged `test_is_infra` (runtime OOM ≠ startup free-memory check); cross-check the same job on the same-day main build. If main OOMs the same way, it's contention — skip filing |
