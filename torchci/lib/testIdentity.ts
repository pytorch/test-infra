import {
  compressToEncodedURIComponent,
  decompressFromEncodedURIComponent,
} from "lz-string";

export interface TestIdentity {
  file: string;
  classname: string;
  name: string;
}

export function encodeTestIdentity(test: TestIdentity): string {
  return compressToEncodedURIComponent(JSON.stringify(test));
}

export function decodeTestIdentity(value: string): TestIdentity | null {
  try {
    const decoded = decompressFromEncodedURIComponent(value);
    if (!decoded) return null;

    const parsed: unknown = JSON.parse(decoded);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }

    const identity = parsed as Partial<TestIdentity>;
    if (
      typeof identity.file !== "string" ||
      typeof identity.classname !== "string" ||
      typeof identity.name !== "string" ||
      ![identity.file, identity.classname, identity.name].some(
        (value) => value.trim().length > 0
      )
    ) {
      return null;
    }

    return identity as TestIdentity;
  } catch {
    return null;
  }
}
