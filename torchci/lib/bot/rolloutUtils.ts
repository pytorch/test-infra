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
  // Core members
  "albanD",
  "anjali411",
  "bdhirsh",
  "cpuhrsch",
  "drisspg",
  "george-qi",
  "soulitzer",
  "jbschlosser",
  "mikaylagawarecki",
  "mruberry",
  "ngimel",
  "zou3519",
  "saketh-are",
  "samdow",
  "SherlockNoMad",
  "dagitses",
]);

export const POSSIBLE_USERS = [
  "swang392",
  "janeyx99",
  "atalman",
  "clee2000",
  "seemethere",
  "huydhn",
  "zengk95",
  "linbinyu",
  "suo",
  "dagitses",
  "malfet",
  "mehtanirav",
  "kit1980",
  "b0noI",
  "weiwangmeta",
  "ZainRizvi",
  "DanilBaibak",
  "jeanschmidt",
  "osalpekar",
];

const ASCII_COW = `
\|/          (__)    
\`\------(oo)
  ||    (__)
  ||w--||     \|/
\|/`;

const LAND_CHECK_WIKI =
  "https://github.com/pytorch/pytorch/wiki/Bot-commands#land-checks";

export function getLandCheckMessage(isEnrolled: boolean) {
  const messagePrefix = isEnrolled
    ? `You have been enrolled into [land-checks](${LAND_CHECK_WIKI}). Thank you for being a dogfooder! If you would like to opt out, please reach out to the Pytorch Dev Infra team.`
    : `Thank you for using [land-checks](${LAND_CHECK_WIKI}).`;

  return `${messagePrefix} Your PR is now landing and it may take a 3-4 more hours to run additional tests. If you want to just check the signals on the PR, use the -g flag or if you need to land immediately, use the -f flag with a message.
    ${ASCII_COW}
    `;
}

export function isInLandCheckAllowlist(username: string) {
  return landCheckPilotGroup.has(username);
}
