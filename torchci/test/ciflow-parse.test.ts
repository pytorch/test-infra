import { parseCIFlowIssue } from "../lib/bot/ciflowBot";

describe("Parse CIFflow issue", () => {
  test("Empty", () => {
    expect(parseCIFlowIssue("")).toStrictEqual(new Map());
  });

  test("One line", () => {
    expect(parseCIFlowIssue("@malfet")).toStrictEqual(
      new Map([
        [
          "malfet",
          {
            optOut: false,
            defaultLabels: ["ciflow/default"],
          },
        ],
      ])
    );
  });

  test("Empty lines", () => {
    expect(
      parseCIFlowIssue(`

                            @malfet

                            `)
    ).toStrictEqual(
      new Map([
        [
          "malfet",
          {
            optOut: false,
            defaultLabels: ["ciflow/default"],
          },
        ],
      ])
    );
  });

  test("Two users", () => {
    expect(
      parseCIFlowIssue(`
                            @malfet
                            @octocat cats
                            -@opt-out-user
                            - @another-opt-out-user
                            `)
    ).toStrictEqual(
      new Map([
        [
          "malfet",
          {
            optOut: false,
            defaultLabels: ["ciflow/default"],
          },
        ],
        [
          "octocat",
          {
            optOut: false,
            defaultLabels: ["cats"],
          },
        ],
        [
          "opt-out-user",
          {
            optOut: true,
          },
        ],
        [
          "another-opt-out-user",
          {
            optOut: true,
          },
        ],
      ])
    );
  });
});
