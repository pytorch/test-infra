// The commit page's GreenLight tray: the pill pressed open, in a renderer
// whose nodes, window and document are stand-ins. What is checked is what
// the tray says, where it is put, and when it is on the page and leaves it;
// how it looks and moves is checked in a browser (pages/tests/README.md).
//
// Emotion hands no ref on where there is no document, and the tray is placed
// and moved through its refs, so in this file a Box is the plain element it
// would render. The pill as it is drawn is greenlight.test.tsx's.
//
// No expectation is given a renderer's instance: one that failed would print
// the whole tree, and run the test out of memory doing it.

import GreenLightPill from "components/tests/GreenLightPill";
import type {
  GreenlightStatus,
  GreenlightVerdict,
} from "lib/api/tests/commit/greenlight/types";
import {
  GREENLIGHT_NO_LAND_HEADLINE,
  GREENLIGHT_REVERTED_BODY,
  GREENLIGHT_REVERTED_HEADLINE,
} from "lib/greenlight/greenlightRender";
import { whenExact, whenLabel } from "lib/tests/commit";
import {
  CommitGreenlightState,
  TRAY_WIDTH,
  trayPlacement,
} from "lib/tests/greenlight";
import { act, create, ReactTestRenderer } from "react-test-renderer";

jest.mock("@mui/material", () => {
  const React = jest.requireActual("react");
  return {
    ...jest.requireActual("@mui/material"),
    Box: React.forwardRef(function Box(
      { component = "div", sx: _sx, ...props }: Record<string, unknown>,
      ref: unknown
    ) {
      return React.createElement(component, { ...props, ref });
    }),
  };
});

// The report button reads the session and the router, which no test here
// provides; what matters here is whether the tray offers it, and for what.
jest.mock("components/greenlight/GreenLightReportButton", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    const React = jest.requireActual("react");
    return React.createElement("report-button", props);
  },
}));

const REPO = "pytorch/pytorch";
const SHA = "573c889f49603f0bd8d0033ef6a49e3016d863d3";
const HEAD = "841ef2a4d54042f2f2c8930627d799c94cba4ad0";
const JOB = "https://github.com/pytorch/test-infra/actions/runs/42857520608";
const RECORDED_AT = "2026-11-10T16:46:47.169Z";
const OUTLINE =
  "- Triviality\n  - Four separate perf rewrites in the hot path (`step`, `popn`)\n- Tests\n  - Diff adds no tests";

function verdictOf(overrides: Partial<GreenlightVerdict> = {}) {
  const verdict: GreenlightVerdict = {
    status: "NO_LAND",
    reason: "not_trivial",
    message: OUTLINE,
    pull_request_number: 204150,
    head_sha: SHA,
    updated_at: RECORDED_AT,
    job_url: JOB,
    ...overrides,
  };
  return verdict;
}

// An element's animation, as the tray starts one and ends it.
interface FakeAnimation {
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
  onfinish: (() => void) | null;
  cancel: jest.Mock;
}

// What the pill reads of a node: its place, its row's, its document, and
// the two things it asks of one, focus and an animation.
interface FakeNode {
  type: string;
  role: unknown;
  ownerDocument: unknown;
  focus: jest.Mock;
  getBoundingClientRect: () => { left: number; right: number; width: number };
  parentElement: {
    getBoundingClientRect: () => { left: number; right: number };
  };
  animate?: (
    _frames: Keyframe[],
    _options: KeyframeAnimationOptions
  ) => FakeAnimation;
  animations: FakeAnimation[];
}

// The header's row at the page's full width, and a pill at its end, where
// the tray cannot hang from the pill's left edge: the placement with the
// most to get wrong, so the one the tests start from. The commit page's own
// pill is first in the row.
const WIDE_ROW = { left: 16, right: 1408 };
const PILL_AT_END = { left: 930, right: 1205 };
const PILL_FIRST = { left: 16, right: 291 };

describe("the tray", () => {
  const documentListeners = new Map<string, (_event: unknown) => void>();
  const fakeDocument = {
    addEventListener: (type: string, listener: (_event: unknown) => void) =>
      documentListeners.set(type, listener),
    removeEventListener: (type: string) => documentListeners.delete(type),
    documentElement: { clientWidth: 1440, clientHeight: 900 },
  };
  const windowListeners = new Map<string, () => void>();
  // What a test sets before it mounts: the places measured, whether the
  // nodes can animate, and whether the reader asked for less motion. The
  // tray's own box is as wide as its place unless a test gives it one, a
  // tray that holds little.
  let pill = PILL_AT_END;
  let row = WIDE_ROW;
  let trayBox: { left: number; right: number } | null = null;
  const wholePlace = () => {
    const { left, width } = trayPlacement(pill, row);
    return { left: pill.left + left, right: pill.left + left + width };
  };
  let animates = false;
  let still = false;
  let nodes: FakeNode[] = [];
  let renderer: ReactTestRenderer | undefined;

  function nodeMock(element: { type: unknown; props: { role?: unknown } }) {
    const node: FakeNode = {
      type: String(element.type),
      role: element.props.role,
      ownerDocument: fakeDocument,
      focus: jest.fn(),
      getBoundingClientRect: () => {
        const box =
          element.props.role === "region" ? trayBox ?? wholePlace() : pill;
        return { ...box, width: box.right - box.left };
      },
      parentElement: { getBoundingClientRect: () => row },
      animations: [],
    };
    if (animates) {
      node.animate = (frames, options) => {
        const animation = {
          frames,
          options,
          onfinish: null,
          cancel: jest.fn(),
        };
        node.animations.push(animation);
        return animation;
      };
    }
    nodes.push(node);
    return node;
  }
  // The nodes the pill holds: its button, and while the tray is on the page
  // the tray's card and, within it, what the card holds.
  const lastNode = (match: (_node: FakeNode) => boolean) =>
    nodes.filter(match).slice(-1)[0];
  const pillNode = () => lastNode((node) => node.type === "button");
  const rootNode = () => lastNode((node) => node.type === "span");
  const cardNode = () => lastNode((node) => node.role === "region");
  const contentNode = () =>
    lastNode((node) => node.type === "div" && node.role === undefined);

  const globals = globalThis as { window?: unknown; self?: unknown };
  beforeAll(() => {
    globals.window = {
      addEventListener: (type: string, listener: () => void) =>
        windowListeners.set(type, listener),
      removeEventListener: (type: string) => windowListeners.delete(type),
      matchMedia: () => ({ matches: still }),
    };
    // A Next link waits for an idle moment of the page's, through self, to
    // look at what it leads to; here that moment never comes.
    globals.self = { setTimeout: () => 0 };
  });
  afterAll(() => {
    delete globals.window;
    delete globals.self;
  });
  beforeEach(() => {
    pill = PILL_AT_END;
    row = WIDE_ROW;
    trayBox = null;
    animates = false;
    still = false;
    nodes = [];
  });
  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
  });

  // The pill for a verdict, or for another state of the commit's answer.
  const stateOf = (
    shown: GreenlightVerdict | CommitGreenlightState
  ): CommitGreenlightState =>
    "kind" in shown ? shown : { kind: "verdict", verdict: shown };
  let mountedSha = SHA;
  async function mount(
    shown: GreenlightVerdict | CommitGreenlightState,
    sha = SHA
  ) {
    mountedSha = sha;
    await act(async () => {
      // Under no ThemeProvider, so in MUI's default theme: the provider's
      // own effect reaches for a document.
      renderer = create(
        <GreenLightPill repo={REPO} sha={sha} state={stateOf(shown)} />,
        { createNodeMock: nodeMock }
      );
      // MUI's click-away arms itself a tick after it mounts.
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  // The same pill given another state: a new answer.
  const show = (shown: GreenlightVerdict | CommitGreenlightState) =>
    act(() =>
      renderer!.update(
        <GreenLightPill repo={REPO} sha={mountedSha} state={stateOf(shown)} />
      )
    );
  const hosts = (match: (_props: Record<string, unknown>) => boolean) =>
    renderer!.root.findAll(
      (node) => typeof node.type === "string" && match(node.props)
    );
  const host = (type: string) =>
    renderer!.root.findAll((node) => node.type === type);
  const button = () => host("button")[0];
  const tray = () => hosts((props) => props.role === "region")[0];
  // Asked as plain values, so that a failed expectation prints one and not
  // the renderer's tree.
  const trayIsOn = () => tray() !== undefined;
  const count = (type: string) => host(type).length;
  // Where the tray is put: the style of the element that holds it.
  const place = () =>
    hosts((props) => props.style !== undefined)[0]?.props.style;
  const press = () => act(() => button().props.onClick());
  const keyDown = (key: string) => {
    const stopPropagation = jest.fn();
    act(() =>
      hosts(
        (props) => typeof props.onKeyDown === "function"
      )[0].props.onKeyDown({ key, stopPropagation })
    );
    return stopPropagation;
  };
  // A click as MUI's click-away hears it on the document, on the nodes given.
  const clickOn = (path: unknown[]) =>
    act(() => documentListeners.get("click")!({ composedPath: () => path }));
  function textOf(node: unknown): string {
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (node !== null && typeof node === "object" && "children" in node) {
      return textOf((node as { children: unknown }).children ?? []);
    }
    return "";
  }
  // The tray's words: everything in the pill's element after its button.
  const trayText = () =>
    textOf((renderer!.toJSON() as { children: unknown[] }).children.slice(1));

  describe("opened and folded", () => {
    test("a press opens the tray the pill controls, and another folds it", async () => {
      await mount(verdictOf());
      expect(trayIsOn()).toBe(false);
      expect(button().props["aria-expanded"]).toBe(false);
      expect(button().props["aria-controls"]).toBeUndefined();
      expect(button().props.title).toBe(GREENLIGHT_NO_LAND_HEADLINE);

      press();
      expect(button().props["aria-expanded"]).toBe(true);
      expect(tray().props.id).toBe(button().props["aria-controls"]);
      expect(tray().props["aria-label"]).toBe(
        `Green Light: ${GREENLIGHT_NO_LAND_HEADLINE}`
      );
      // The tooltip would repeat the tray's first line.
      expect(button().props.title).toBeUndefined();

      press();
      expect(button().props["aria-expanded"]).toBe(false);
      expect(button().props["aria-controls"]).toBeUndefined();
      expect(button().props.title).toBe(GREENLIGHT_NO_LAND_HEADLINE);
      expect(trayIsOn()).toBe(false);
    });

    test("Escape folds the tray and returns focus to the pill", async () => {
      await mount(verdictOf());
      press();
      const stopPropagation = keyDown("Escape");
      expect(trayIsOn()).toBe(false);
      expect(button().props["aria-expanded"]).toBe(false);
      expect(pillNode().focus).toHaveBeenCalledTimes(1);
      // The key is the tray's alone while it is open: nothing behind it,
      // a dialog the page is in, closes with it.
      expect(stopPropagation).toHaveBeenCalledTimes(1);
    });

    test("Escape with the tray closed, and any other key, are left to the page", async () => {
      await mount(verdictOf());
      expect(keyDown("Escape")).not.toHaveBeenCalled();
      press();
      expect(keyDown("a")).not.toHaveBeenCalled();
      expect(keyDown("Enter")).not.toHaveBeenCalled();
      expect(trayIsOn()).toBe(true);
      expect(pillNode().focus).not.toHaveBeenCalled();
    });

    test("a click elsewhere folds the tray, and a click within it does not", async () => {
      await mount(verdictOf());
      press();
      clickOn([{}, rootNode()]);
      expect(trayIsOn()).toBe(true);
      clickOn([{}]);
      expect(trayIsOn()).toBe(false);
      expect(button().props["aria-expanded"]).toBe(false);
      // The page's own click took the focus; the pill does not take it back.
      expect(pillNode().focus).not.toHaveBeenCalled();
      // With the tray closed a click elsewhere changes nothing.
      clickOn([{}]);
      expect(trayIsOn()).toBe(false);
    });

    test("listens to the window and the document only while it needs to", async () => {
      await mount(verdictOf());
      expect(windowListeners.has("resize")).toBe(false);
      press();
      expect(windowListeners.has("resize")).toBe(true);
      press();
      expect(windowListeners.has("resize")).toBe(false);
      press();
      act(() => renderer!.unmount());
      renderer = undefined;
      expect(windowListeners.size).toBe(0);
      expect(documentListeners.size).toBe(0);
    });
  });

  describe("placed", () => {
    test("at the row's end it hangs from the pill's right edge", async () => {
      await mount(verdictOf());
      press();
      expect(place()).toEqual({
        left: PILL_AT_END.right - TRAY_WIDTH - PILL_AT_END.left,
        width: TRAY_WIDTH,
        visibility: "visible",
      });
    });

    test("first in the row, where the commit page has it, it hangs from the pill's left edge", async () => {
      pill = PILL_FIRST;
      await mount(verdictOf());
      press();
      expect(place()).toEqual({
        left: 0,
        width: TRAY_WIDTH,
        visibility: "visible",
      });
    });

    test("a tray narrower than its place stays under its pill, against the edge it hangs from", async () => {
      await mount(verdictOf());
      press();
      // From the pill's right edge, at the row's end.
      expect(tray().props.style).toEqual({ marginLeft: "auto" });
      press();
      pill = PILL_FIRST;
      act(() => windowListeners.get("resize")?.());
      press();
      // From its left edge, first in the row.
      expect(tray().props.style).toEqual({ marginLeft: 0 });
    });

    test("is placed again when the pill's words change under it, and not unfolded again", async () => {
      animates = true;
      await mount(
        verdictOf({
          status: "AI_REVIEW_STARTED",
          reason: "",
          message: "",
          // In flight now, whenever the test runs.
          updated_at: new Date().toISOString(),
        })
      );
      press();
      expect(place()).toMatchObject({
        left: PILL_AT_END.right - TRAY_WIDTH - PILL_AT_END.left,
      });
      // The review's verdict lands, in fewer words: a narrower pill.
      pill = { left: PILL_AT_END.left, right: 1130 };
      show(verdictOf({ status: "LAND", reason: "clean" }));
      expect(place()).toEqual({
        left: 1130 - TRAY_WIDTH - PILL_AT_END.left,
        width: TRAY_WIDTH,
        visibility: "visible",
      });
      expect(trayIsOn()).toBe(true);
      expect(button().props["aria-expanded"]).toBe(true);
      expect(cardNode().animations).toHaveLength(1);
      expect(windowListeners.has("resize")).toBe(true);
    });

    test("follows the window's width, and is not unfolded again for it", async () => {
      animates = true;
      await mount(verdictOf());
      press();
      expect(cardNode().animations).toHaveLength(1);
      // A phone's width: the row is narrower than the tray.
      pill = { left: 23, right: 298 };
      row = { left: 23, right: 382 };
      act(() => windowListeners.get("resize")!());
      expect(place()).toEqual({ left: 0, width: 359, visibility: "visible" });
      expect(cardNode().animations).toHaveLength(1);
      expect(trayIsOn()).toBe(true);
    });
  });

  describe("in motion", () => {
    const WHOLE = "inset(0px 0px 0% 0px round 14px)";
    // The pill's own footprint at the tray's top edge: the tray hangs from
    // the pill's right edge, so all of it to the pill's left is cut away.
    const FOLDED = `inset(0px 0px 100% ${TRAY_WIDTH - 275}px round 14px)`;

    test("unfolds from the pill's footprint, its words arriving after", async () => {
      animates = true;
      await mount(verdictOf());
      press();
      expect(cardNode().animations).toEqual([
        expect.objectContaining({
          frames: [
            { clipPath: FOLDED, transform: "translateY(-8px)" },
            { clipPath: WHOLE, transform: "translateY(0px)" },
          ],
          options: { duration: 300, easing: "cubic-bezier(0.32, 0.72, 0, 1)" },
        }),
      ]);
      expect(contentNode().animations).toEqual([
        expect.objectContaining({
          frames: [
            { opacity: 0, transform: "translateY(-4px)" },
            { opacity: 1, transform: "translateY(0px)" },
          ],
          options: {
            duration: 240,
            delay: 60,
            easing: "ease-out",
            fill: "backwards",
          },
        }),
      ]);
    });

    test("under the pill's left edge it unfolds from the left", async () => {
      animates = true;
      pill = { left: 200, right: 475 };
      await mount(verdictOf());
      press();
      expect(cardNode().animations[0].frames[0].clipPath).toBe(
        `inset(0px ${TRAY_WIDTH - 275}px 100% 0px round 14px)`
      );
    });

    test("a tray that holds little unfolds from the pill's footprint within its own box", async () => {
      animates = true;
      pill = PILL_FIRST;
      // "Green Light has no review of this commit", and its padding.
      trayBox = { left: PILL_FIRST.left, right: PILL_FIRST.left + 340 };
      await mount({ kind: "no_verdict", reason: "not_reviewed" });
      press();
      expect(cardNode().animations[0].frames[0].clipPath).toBe(
        `inset(0px ${340 - 275}px 100% 0px round 14px)`
      );
      // A tray no wider than its pill is all footprint.
      press();
      act(() => cardNode().animations[1].onfinish!());
      trayBox = { left: PILL_FIRST.left, right: PILL_FIRST.left + 200 };
      press();
      expect(cardNode().animations[0].frames[0].clipPath).toBe(
        "inset(0px 0px 100% 0px round 14px)"
      );
    });

    test("folds back into the pill, faster, and leaves the page when folded", async () => {
      animates = true;
      await mount(verdictOf());
      press();
      press();
      // Closed to the reader at once; on the page until it has folded.
      expect(button().props["aria-expanded"]).toBe(false);
      expect(trayIsOn()).toBe(true);
      const [, folding] = cardNode().animations;
      expect(folding).toEqual(
        expect.objectContaining({
          frames: [
            { clipPath: WHOLE, transform: "translateY(0px)" },
            { clipPath: FOLDED, transform: "translateY(-8px)" },
          ],
          options: {
            duration: 160,
            easing: "cubic-bezier(0.4, 0, 1, 1)",
            fill: "forwards",
          },
        })
      );
      // Its words go first, so no line is seen cut through.
      const [, fading] = contentNode().animations;
      expect(fading.frames).toEqual([{ opacity: 1 }, { opacity: 0 }]);
      expect(fading.options).toMatchObject({ duration: 90, fill: "forwards" });

      act(() => folding.onfinish!());
      expect(trayIsOn()).toBe(false);
      expect(windowListeners.has("resize")).toBe(false);
    });

    test("pressed again while folding, it drops the fold and unfolds whole", async () => {
      animates = true;
      await mount(verdictOf());
      press();
      press();
      const card = cardNode();
      const [, folding] = card.animations;
      const [, fading] = contentNode().animations;
      press();
      // The fold would hold the tray shut under the unfolding.
      expect(folding.cancel).toHaveBeenCalledTimes(1);
      expect(fading.cancel).toHaveBeenCalledTimes(1);
      expect(folding.onfinish).toBeNull();
      // The same tray, never taken off the page, unfolding again.
      expect(cardNode() === card).toBe(true);
      expect(card.animations).toHaveLength(3);
      expect(card.animations[2].options).toMatchObject({ duration: 300 });
      expect(button().props["aria-expanded"]).toBe(true);
      expect(trayIsOn()).toBe(true);
    });

    test("a fold cut short by the window's width leaves the page at once", async () => {
      animates = true;
      await mount(verdictOf());
      press();
      press();
      const [, folding] = cardNode().animations;
      pill = { left: 23, right: 298 };
      row = { left: 23, right: 382 };
      act(() => windowListeners.get("resize")!());
      expect(folding.cancel).toHaveBeenCalledTimes(1);
      expect(trayIsOn()).toBe(false);
    });

    test("for a reader who asked for less motion it does not move", async () => {
      animates = true;
      still = true;
      await mount(verdictOf());
      press();
      expect(trayIsOn()).toBe(true);
      expect(place()).toMatchObject({ visibility: "visible" });
      press();
      expect(trayIsOn()).toBe(false);
      expect(nodes.flatMap((node) => node.animations)).toEqual([]);
    });
  });

  describe("says", () => {
    test("the verdict, its reason, the outline, when, and links the job", async () => {
      await mount(verdictOf());
      press();
      expect(trayText()).toBe(
        [
          GREENLIGHT_NO_LAND_HEADLINE,
          "not_trivial",
          "Triviality",
          "Four separate perf rewrites in the hot path (step, popn)",
          "Tests",
          "Diff adds no tests",
          `Reviewed ${whenLabel(RECORDED_AT)}`,
          "Inference job",
        ].join("")
      );
      // The outline is a list whose identifiers are code, as the HUD's
      // verdict panel shows it.
      expect(host("code").map((node) => textOf(node.children))).toEqual([
        "not_trivial",
        "step",
        "popn",
      ]);
      expect(host("strong").map((node) => textOf(node.children))).toEqual([
        "Triviality",
        "Tests",
      ]);
      // The time in the reader's own zone, the exact one behind it.
      expect(
        hosts((props) => props.title === whenExact(RECORDED_AT)).map((node) =>
          textOf(node.children)
        )
      ).toEqual([whenLabel(RECORDED_AT)]);
      expect(
        host("a").map((node) => [
          textOf(node.children),
          node.props.href,
          node.props.target,
          node.props.rel,
        ])
      ).toEqual([["Inference job", JOB, "_blank", "noreferrer"]]);
    });

    test("an approval, with no reason beside it", async () => {
      await mount(verdictOf({ status: "LAND", reason: "clean", message: "" }));
      press();
      expect(count("code")).toBe(0);
      expect(trayText()).toMatch(/Reviewed .*Inference job$/);
    });

    test("a message that is no outline as the text it is", async () => {
      const prose = "The diff is too large.\n\nSee `symbolic_convert.py`.";
      await mount(verdictOf({ message: prose }));
      press();
      expect(host("pre").map((node) => textOf(node.children))).toEqual([prose]);
      expect(count("ul")).toBe(0);
    });

    test("what the model wrote as text, whatever it wrote", async () => {
      const markup =
        '- <img src=x onerror=alert(1)>\n  - [click](javascript:alert(1)) <a href="https://example.com">here</a>';
      await mount(verdictOf({ message: markup }));
      press();
      expect(trayText()).toContain("<img src=x onerror=alert(1)>");
      expect(trayText()).toContain(
        '[click](javascript:alert(1)) <a href="https://example.com">here</a>'
      );
      // No element is made of it: the only link is the review's job, and
      // the only markup set as markup is Emotion's own style sheets.
      expect(count("img")).toBe(0);
      expect(host("a").map((node) => node.props.href)).toEqual([JOB]);
      expect(
        hosts((props) => props.dangerouslySetInnerHTML !== undefined).filter(
          (node) => node.type !== "style"
        ).length
      ).toBe(0);
    });

    test("for a commit that landed from another head, that head, linking its page", async () => {
      await mount(
        verdictOf({ status: "LAND", reason: "clean", head_sha: HEAD })
      );
      press();
      expect(trayText()).toContain(
        `PR head ${HEAD.slice(0, 7)}·Reviewed ${whenLabel(RECORDED_AT)}`
      );
      const head = host("a").find(
        (node) => textOf(node.children) === HEAD.slice(0, 7)
      );
      expect(head?.props.href).toBe(`/tests/pytorch/pytorch/commit/${HEAD}`);
      expect(head?.props.title).toBe(HEAD);
    });

    test("for the reviewed head itself, no head beside the time", async () => {
      await mount(verdictOf());
      press();
      expect(trayText()).not.toContain("PR head");
    });

    test("a status's fixed words, and no job where none is recorded", async () => {
      await mount(
        verdictOf({
          status: "REVERTED",
          reason: "",
          message: "",
          job_url: null,
        })
      );
      press();
      expect(trayText()).toBe(
        [
          GREENLIGHT_REVERTED_HEADLINE,
          GREENLIGHT_REVERTED_BODY,
          `Updated ${whenLabel(RECORDED_AT)}`,
        ].join("")
      );
      expect(count("a")).toBe(0);
    });
  });

  describe("says, where there is no verdict", () => {
    test("that GreenLight has no review of the commit", async () => {
      const sentence = "Green Light has no review of this commit";
      await mount({ kind: "no_verdict", reason: "not_reviewed" });
      expect(button().props.title).toBe(sentence);
      press();
      expect(tray().props["aria-label"]).toBe(`Green Light: ${sentence}`);
      expect(trayText()).toBe(sentence);
      // Nothing was reviewed: no job to link, no verdict to report.
      expect(count("a")).toBe(0);
      expect(count("report-button")).toBe(0);
      press();
      expect(trayIsOn()).toBe(false);
    });

    test("that the commit is of no pull request, and what GreenLight reviews", async () => {
      await mount({ kind: "no_verdict", reason: "no_pull_request" });
      press();
      expect(trayText()).toBe(
        "This commit is not part of a pull request" +
          "Green Light reviews pull requests."
      );
    });

    test("that the status recorded is one HUD does not recognize", async () => {
      await mount({ kind: "no_verdict", reason: "unrecognized_status" });
      press();
      expect(trayText()).toBe(
        "Green Light recorded a status HUD does not recognize"
      );
    });
  });

  describe("for a verdict that could not be read", () => {
    // A failed request as the hub's request helper throws it.
    const failure = Object.assign(
      new Error("An error occurred while fetching the data"),
      { status: 500, info: "Failed to read the commit's GreenLight verdict" }
    );
    const retryButton = () => host("button")[1];

    test("says what failed, and asks again on Retry", async () => {
      const retry = jest.fn();
      await mount({ kind: "unavailable", error: failure, retry });
      expect(button().props.title).toBe(
        "Green Light's verdict could not be loaded"
      );
      press();
      expect(trayText()).toBe(
        "Could not load Green Light's verdict: " +
          "Failed to read the commit's GreenLight verdict" +
          "Retry"
      );
      expect(count("report-button")).toBe(0);
      expect(retry).not.toHaveBeenCalled();
      act(() => retryButton().props.onClick());
      expect(retry).toHaveBeenCalledTimes(1);
    });

    test("asked again, it gives way to its placeholder and comes back open on the answer, the focus on the pill", async () => {
      await mount({ kind: "unavailable", error: failure, retry: jest.fn() });
      press();
      act(() => retryButton().props.onClick());
      // The answer is on its way: no pill, no tray.
      show({ kind: "loading" });
      expect(count("button")).toBe(0);
      expect(trayIsOn()).toBe(false);
      // It comes: the tray the reader asked from holds it.
      show(verdictOf());
      expect(button().props["aria-expanded"]).toBe(true);
      expect(trayIsOn()).toBe(true);
      expect(trayText()).toContain(GREENLIGHT_NO_LAND_HEADLINE);
      expect(place()).toMatchObject({ visibility: "visible" });
      // The Retry button that had the focus is gone; the pill takes it.
      expect(pillNode().focus).toHaveBeenCalledTimes(1);
    });

    test("failing again, it says so again, and can be asked again", async () => {
      const retry = jest.fn();
      await mount({ kind: "unavailable", error: failure, retry });
      press();
      act(() => retryButton().props.onClick());
      show({ kind: "loading" });
      show({ kind: "unavailable", error: failure, retry });
      expect(trayIsOn()).toBe(true);
      expect(trayText()).toContain("Could not load Green Light's verdict");
      act(() => retryButton().props.onClick());
      expect(retry).toHaveBeenCalledTimes(2);
    });

    test("an answer that was not asked for from the tray takes no focus", async () => {
      await mount({ kind: "loading" });
      expect(count("button")).toBe(0);
      show(verdictOf());
      expect(button().props["aria-expanded"]).toBe(false);
      expect(pillNode().focus).not.toHaveBeenCalled();
    });
  });

  describe("offers a report", () => {
    test.each<[GreenlightStatus]>([["LAND"], ["NO_LAND"]])(
      "of a judgement (%s), against the head that was reviewed",
      async (status) => {
        await mount(verdictOf({ status, head_sha: HEAD }));
        press();
        expect(host("report-button").map((node) => node.props)).toEqual([
          {
            repoOwner: "pytorch",
            repoName: "pytorch",
            prNumber: 204150,
            // Not the commit the page shows.
            sha: HEAD,
            status,
          },
        ]);
      }
    );

    test.each<[GreenlightStatus]>([
      ["AI_REVIEW_DISPATCHED"],
      ["AI_REVIEW_STARTED"],
      ["CANCELLED"],
      ["FAILED"],
      ["REVERTED"],
    ])("of nothing else: %s is no judgement", async (status) => {
      await mount(verdictOf({ status, reason: "", message: "" }));
      press();
      expect(trayIsOn()).toBe(true);
      expect(count("report-button")).toBe(0);
    });
  });
});
