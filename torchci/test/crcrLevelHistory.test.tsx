import CrcrLevelHistory from "components/crcr/CrcrLevelHistory";
import { useLevelHistory } from "lib/crcr/levelHistory";
import { renderToStaticMarkup } from "react-dom/server";

jest.mock("lib/crcr/levelHistory", () => ({
  useLevelHistory: jest.fn(),
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
      "No level changes were observed in the retained dispatch history."
    );
  });
});
