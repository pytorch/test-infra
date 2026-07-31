import { CrcrAllowlist, clearAllowlistCache } from "../lib/crcrAllowlist";

const VALID_YAML = `
L1:
  - org1/repo1
L2:
  - org2/repo2
L3:
  device1:
    org3/device1-repo: [oncall1, oncall2]
  device2:
    org4/device2-repo: [oncall3]
L4:
  - org5/repo5: oncall_a, oncall_b
`;

describe("CrcrAllowlist", () => {
  beforeEach(() => {
    clearAllowlistCache();
  });

  describe("fromYaml", () => {
    test("parses a valid YAML with all levels", () => {
      const al = CrcrAllowlist.fromYaml(VALID_YAML);
      expect(al.getLevelForRepo("org1/repo1")).toBe("L1");
      expect(al.getLevelForRepo("org2/repo2")).toBe("L2");
      expect(al.getLevelForRepo("org3/device1-repo")).toBe("L3");
      expect(al.getLevelForRepo("org4/device2-repo")).toBe("L3");
      expect(al.getLevelForRepo("org5/repo5")).toBe("L4");
    });

    test("L3 entries have correct device and oncalls", () => {
      const al = CrcrAllowlist.fromYaml(VALID_YAML);
      expect(al.getDeviceForRepo("org3/device1-repo")).toBe("device1");
      expect(al.getDeviceForRepo("org4/device2-repo")).toBe("device2");
      expect(al.getOncallsForRepo("org3/device1-repo")).toEqual([
        "oncall1",
        "oncall2",
      ]);
      expect(al.getOncallsForRepo("org4/device2-repo")).toEqual(["oncall3"]);
    });

    test("L4 entries have correct oncalls", () => {
      const al = CrcrAllowlist.fromYaml(VALID_YAML);
      expect(al.getOncallsForRepo("org5/repo5")).toEqual([
        "oncall_a",
        "oncall_b",
      ]);
    });

    test("L1/L2 entries have no oncalls or device", () => {
      const al = CrcrAllowlist.fromYaml(VALID_YAML);
      expect(al.getOncallsForRepo("org1/repo1")).toEqual([]);
      expect(al.getDeviceForRepo("org1/repo1")).toBeNull();
      expect(al.getOncallsForRepo("org2/repo2")).toEqual([]);
      expect(al.getDeviceForRepo("org2/repo2")).toBeNull();
    });

    test("unknown repo returns null level and empty oncalls", () => {
      const al = CrcrAllowlist.fromYaml(VALID_YAML);
      expect(al.getLevelForRepo("unknown/repo")).toBeNull();
      expect(al.getOncallsForRepo("unknown/repo")).toEqual([]);
      expect(al.getDeviceForRepo("unknown/repo")).toBeNull();
    });

    test("repo lookup is case-insensitive", () => {
      const al = CrcrAllowlist.fromYaml(VALID_YAML);
      expect(al.getLevelForRepo("ORG5/REPO5")).toBe("L4");
      expect(al.getOncallsForRepo("Org5/Repo5")).toEqual([
        "oncall_a",
        "oncall_b",
      ]);
    });
  });

  describe("isBlocking", () => {
    test("L4 is blocking, L3 and below are not", () => {
      const al = CrcrAllowlist.fromYaml(VALID_YAML);
      expect(al.isBlocking("org5/repo5")).toBe(true); // L4
      expect(al.isBlocking("org3/device1-repo")).toBe(false); // L3
      expect(al.isBlocking("org2/repo2")).toBe(false); // L2
      expect(al.isBlocking("org1/repo1")).toBe(false); // L1
      expect(al.isBlocking("unknown/repo")).toBe(false); // unknown
    });
  });

  describe("getReposAtOrAboveLevel", () => {
    test("L1 gives all repos", () => {
      const al = CrcrAllowlist.fromYaml(VALID_YAML);
      const repos = al.getReposAtOrAboveLevel("L1");
      expect(repos).toHaveLength(5);
      expect(repos).toContain("org1/repo1");
    });

    test("L3 gives L3+ repos only", () => {
      const al = CrcrAllowlist.fromYaml(VALID_YAML);
      const repos = al.getReposAtOrAboveLevel("L3");
      expect(repos).toHaveLength(3);
      expect(repos).toContain("org3/device1-repo");
      expect(repos).toContain("org4/device2-repo");
      expect(repos).toContain("org5/repo5");
    });

    test("L4 gives L4 repos only", () => {
      const al = CrcrAllowlist.fromYaml(VALID_YAML);
      const repos = al.getReposAtOrAboveLevel("L4");
      expect(repos).toEqual(["org5/repo5"]);
    });
  });

  describe("error handling", () => {
    test("duplicate repo raises", () => {
      expect(() =>
        CrcrAllowlist.fromYaml(`
L1:
  - org/repo
L2:
  - org/repo
`)
      ).toThrow(/duplicate repo/i);
    });

    test("L3 as list raises", () => {
      expect(() =>
        CrcrAllowlist.fromYaml(`
L3:
  - org/repo
`)
      ).toThrow(/L3 must be a device mapping/);
    });

    test("L3 device with non-mapping raises", () => {
      expect(() =>
        CrcrAllowlist.fromYaml(`
L3:
  device1:
    - org/repo
`)
      ).toThrow(/L3.device1 must be a repo mapping/);
    });

    test("empty L3 device name raises", () => {
      expect(() =>
        CrcrAllowlist.fromYaml(`
L3:
  "  ":
    org/repo: []
`)
      ).toThrow(/device name must not be empty/);
    });
  });
});
