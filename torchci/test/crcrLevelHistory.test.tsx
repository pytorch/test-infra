import CrcrLevelHistory from "components/crcr/CrcrLevelHistory";
import { useLevelHistory } from "lib/crcr/levelHistory";
import { renderToStaticMarkup } from "react-dom/server";

jest.mock("lib/crcr/levelHistory", () => ({
  useLevelHistory: jest.fn(),
}));

jest.mock("components/common/TimeUtils", () => ({
  LocalTimeHuman: ({ timestamp }: { timestamp: string }) => <>{timestamp}</>,
}));

const mockUseLevelHistory = useLevelHistory as jest.MockedFunction<
  typeof useLevelHistory
>;

describe("CrcrLevelHistory", () => {
  test("does not present a failed request as an empty history", () => {
    mockUseLevelHistory.mockReturnValue({
      events: [],
      error: new Error("ClickHouse unavailable"),
      loaded: true,
    });

    const html = renderToStaticMarkup(
      <CrcrLevelHistory repoFullName="pytorch/pytorch" />
    );

    expect(html).toContain("Level history is temporarily unavailable");
    expect(html).not.toContain("0 observed changes");
    expect(html).not.toContain(
      "No level events were observed in the retained dispatch history."
    );
  });

  test("uses the UTC-aware timestamp renderer and exposes the initial level", () => {
    mockUseLevelHistory.mockReturnValue({
      events: [
        {
          changed_at: "2026-09-12 00:53:00",
          previous_level: "Initial level",
          new_level: "L2",
        },
      ],
      error: undefined,
      loaded: true,
    });

    const html = renderToStaticMarkup(
      <CrcrLevelHistory repoFullName="pytorch/pytorch" />
    );

    expect(html).toContain("2026-09-12 00:53:00");
    expect(html).toContain("Initial level → L2");
    expect(html).toContain("1 observed level event");
    expect(html).toContain('aria-expanded="false"');
  });
});
