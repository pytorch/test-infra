import {
  ApiError,
  conclusionColor,
  conclusionLabel,
  extractDynamoRecord,
  RelayPayload,
  validatePayloadSize,
} from "../lib/crcr/crcrUtils";

function makePayload(
  overrides: {
    trusted?: any;
    workflow?: any;
    callback?: any;
  } = {}
): RelayPayload {
  return {
    trusted: {
      verified_repo: "Ascend/pytorch",
      downstream_repo_level: "L2",
      ci_metrics: { queue_time: 12.5, execution_time: null },
      ...overrides.trusted,
    },
    untrusted: {
      callback_payload: {
        event_type: "workflow_job",
        delivery_id: "delivery-abc-123",
        payload: {
          pull_request: { number: 12345, head: { sha: "abcdef1234567890" } },
          repository: { full_name: "pytorch/pytorch" },
        },
        workflow: {
          schema_version: "1",
          status: "in_progress",
          name: "npu-ci",
          url: "https://github.com/Ascend/pytorch/actions/runs/123",
          job_name: "build-and-test",
          check_run_id: "99001",
          run_id: "123456",
          run_attempt: 1,
          started_at: "2026-05-20T10:00:00Z",
          ...overrides.workflow,
        },
        ...overrides.callback,
      },
    },
  };
}

describe("extractDynamoRecord", () => {
  test("extracts correct dynamoKey format", () => {
    const record = extractDynamoRecord(makePayload());
    expect(record.dynamoKey).toBe(
      "Ascend/pytorch/delivery-abc-123/npu-ci/build-and-test/99001"
    );
  });

  test("maps all basic fields correctly", () => {
    const record = extractDynamoRecord(makePayload());
    expect(record.status).toBe("in_progress");
    expect(record.downstream_repo).toBe("Ascend/pytorch");
    expect(record.upstream_repo).toBe("pytorch/pytorch");
    expect(record.pr_number).toBe(12345);
    expect(record.pytorch_head_sha).toBe("abcdef1234567890");
    expect(record.delivery_id).toBe("delivery-abc-123");
    expect(record.workflow_name).toBe("npu-ci");
    expect(record.job_name).toBe("build-and-test");
    expect(record.check_run_id).toBe("99001");
    expect(record.run_id).toBe("123456");
    expect(record.run_attempt).toBe(1);
  });

  test("sets downstream_repo_level from trusted payload", () => {
    const record = extractDynamoRecord(makePayload());
    expect(record.downstream_repo_level).toBe("L2");
  });

  test("omits downstream_repo_level when not provided", () => {
    const record = extractDynamoRecord(
      makePayload({ trusted: { downstream_repo_level: undefined } })
    );
    expect(record.downstream_repo_level).toBeUndefined();
  });

  test("sets event_type from callback payload", () => {
    const record = extractDynamoRecord(makePayload());
    expect(record.event_type).toBe("workflow_job");
  });

  test("sets event_type for nightly callback", () => {
    const record = extractDynamoRecord(
      makePayload({ callback: { event_type: "nightly" } })
    );
    expect(record.event_type).toBe("nightly");
  });

  test("sets event_type for periodic callback", () => {
    const record = extractDynamoRecord(
      makePayload({ callback: { event_type: "periodic" } })
    );
    expect(record.event_type).toBe("periodic");
  });

  test("omits event_type when empty", () => {
    const record = extractDynamoRecord(
      makePayload({ callback: { event_type: "" } })
    );
    expect(record.event_type).toBeUndefined();
  });

  test("sets queue_time from ci_metrics when non-null", () => {
    const record = extractDynamoRecord(makePayload());
    expect(record.queue_time).toBe(12.5);
  });

  test("omits execution_time when ci_metrics value is null", () => {
    const record = extractDynamoRecord(makePayload());
    expect(record.execution_time).toBeUndefined();
  });

  test("sets execution_time when provided", () => {
    const record = extractDynamoRecord(
      makePayload({
        trusted: { ci_metrics: { queue_time: null, execution_time: 45.2 } },
      })
    );
    expect(record.execution_time).toBe(45.2);
    expect(record.queue_time).toBeUndefined();
  });

  test("sets started_at from workflow", () => {
    const record = extractDynamoRecord(makePayload());
    expect(record.started_at).toBe("2026-05-20T10:00:00Z");
  });

  test("sets artifact_url when provided", () => {
    const record = extractDynamoRecord(
      makePayload({
        workflow: { artifact_url: "https://example.com/artifacts.zip" },
      })
    );
    expect(record.artifact_url).toBe("https://example.com/artifacts.zip");
  });

  test("omits artifact_url when not provided", () => {
    const record = extractDynamoRecord(makePayload());
    expect(record.artifact_url).toBeUndefined();
  });

  test("coerces string run_attempt to number", () => {
    const record = extractDynamoRecord(
      makePayload({ workflow: { run_attempt: "3" } })
    );
    expect(record.run_attempt).toBe(3);
  });

  test("defaults run_attempt to 1 when missing", () => {
    const record = extractDynamoRecord(
      makePayload({ workflow: { run_attempt: undefined } })
    );
    expect(record.run_attempt).toBe(1);
  });

  test("defaults upstream_repo to pytorch/pytorch when missing", () => {
    const record = extractDynamoRecord(
      makePayload({ callback: { payload: {} } })
    );
    expect(record.upstream_repo).toBe("pytorch/pytorch");
  });

  test("defaults pr_number to 0 when no pull_request", () => {
    const record = extractDynamoRecord(
      makePayload({
        callback: { payload: { repository: { full_name: "pytorch/pytorch" } } },
      })
    );
    expect(record.pr_number).toBe(0);
    expect(record.pytorch_head_sha).toBe("");
  });

  // --- completed status ---

  test("sets conclusion and completed_at for completed status", () => {
    const record = extractDynamoRecord(
      makePayload({
        workflow: {
          status: "completed",
          conclusion: "success",
          completed_at: "2026-05-20T10:30:00Z",
        },
      })
    );
    expect(record.conclusion).toBe("success");
    expect(record.completed_at).toBe("2026-05-20T10:30:00Z");
  });

  test("does not set conclusion for in_progress status", () => {
    const record = extractDynamoRecord(makePayload());
    expect(record.conclusion).toBeUndefined();
    expect(record.completed_at).toBeUndefined();
  });

  // --- test_results ---

  test("extracts test results with explicit total", () => {
    const record = extractDynamoRecord(
      makePayload({
        workflow: {
          status: "completed",
          conclusion: "failure",
          test_results: { passed: 100, failed: 5, skipped: 10, total: 115 },
        },
      })
    );
    expect(record.passed_tests).toBe(100);
    expect(record.failed_tests).toBe(5);
    expect(record.skipped_tests).toBe(10);
    expect(record.total_tests).toBe(115);
  });

  test("computes total_tests from passed+failed+skipped when total absent", () => {
    const record = extractDynamoRecord(
      makePayload({
        workflow: {
          status: "completed",
          conclusion: "failure",
          test_results: { passed: 80, failed: 3, skipped: 7 },
        },
      })
    );
    expect(record.total_tests).toBe(90);
  });

  test("does not set test results for in_progress status", () => {
    const record = extractDynamoRecord(
      makePayload({
        workflow: { test_results: { passed: 10, failed: 0, skipped: 0 } },
      })
    );
    expect(record.passed_tests).toBeUndefined();
    expect(record.total_tests).toBeUndefined();
  });

  // --- validation errors ---

  test("throws 400 when job_name is missing", () => {
    expect(() =>
      extractDynamoRecord(makePayload({ workflow: { job_name: "" } }))
    ).toThrow(ApiError);
    try {
      extractDynamoRecord(makePayload({ workflow: { job_name: undefined } }));
    } catch (e: any) {
      expect(e).toBeInstanceOf(ApiError);
      expect(e.statusCode).toBe(400);
      expect(e.message).toContain("job_name");
    }
  });

  test("throws 400 when check_run_id is missing", () => {
    expect(() =>
      extractDynamoRecord(
        makePayload({ workflow: { check_run_id: undefined } })
      )
    ).toThrow(ApiError);
    try {
      extractDynamoRecord(makePayload({ workflow: { check_run_id: null } }));
    } catch (e: any) {
      expect(e).toBeInstanceOf(ApiError);
      expect(e.statusCode).toBe(400);
      expect(e.message).toContain("check_run_id");
    }
  });
});

describe("validatePayloadSize", () => {
  test("accepts payload under 2MB", () => {
    expect(() => validatePayloadSize("short payload")).not.toThrow();
  });

  test("throws 413 for payload exceeding 2MB", () => {
    const largePayload = "x".repeat(2 * 1024 * 1024 + 1);
    expect(() => validatePayloadSize(largePayload)).toThrow(ApiError);
    try {
      validatePayloadSize(largePayload);
    } catch (e: any) {
      expect(e.statusCode).toBe(413);
    }
  });

  test("accepts payload exactly at 2MB boundary", () => {
    const exactPayload = "x".repeat(2 * 1024 * 1024);
    expect(() => validatePayloadSize(exactPayload)).not.toThrow();
  });
});

describe("conclusionColor", () => {
  test("returns info for in_progress", () => {
    expect(conclusionColor("in_progress", "")).toBe("info");
  });

  test("returns success for success", () => {
    expect(conclusionColor("completed", "success")).toBe("success");
  });

  test("returns error for failure", () => {
    expect(conclusionColor("completed", "failure")).toBe("error");
  });

  test("returns warning for cancelled", () => {
    expect(conclusionColor("completed", "cancelled")).toBe("warning");
  });

  test("returns warning for timed_out", () => {
    expect(conclusionColor("completed", "timed_out")).toBe("warning");
  });

  test("returns default for unknown conclusion", () => {
    expect(conclusionColor("completed", "unknown")).toBe("default");
  });
});

describe("conclusionLabel", () => {
  test("returns running for in_progress", () => {
    expect(conclusionLabel("in_progress", "")).toBe("running");
  });

  test("returns conclusion when completed", () => {
    expect(conclusionLabel("completed", "success")).toBe("success");
    expect(conclusionLabel("completed", "failure")).toBe("failure");
  });

  test("falls back to status when conclusion is empty", () => {
    expect(conclusionLabel("completed", "")).toBe("completed");
  });
});

describe("ApiError", () => {
  test("has correct statusCode and message", () => {
    const err = new ApiError(404, "Not found");
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe("Not found");
  });
});
