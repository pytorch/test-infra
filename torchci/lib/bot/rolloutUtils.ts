const landCheckPilotGroup = new Set([
  "landchecktestuser",
  "zengk95",
  "atalman",
  "clee2000",
  "huydhn",
  "izaitsevfb",
  "mehtanirav",
  "weiwangmeta",
  "ZainRizvi",
  "janeyx99",
  "DanilBaibak",
  "jeanschmidt",
  "osalpekar",
  "malfet",
  "kit1980",
]);

export function isInLandCheckAllowlist(username: string) {
  return landCheckPilotGroup.has(username);
}
