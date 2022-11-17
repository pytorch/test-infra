import { getIPs } from "../src/get-ip";
import { expect, test } from "@jest/globals";

test("ip found", async () => {
  const ips = await getIPs();
  console.debug(`IPv4 is: ${ips.ipv4}`);
  expect(ips.ipv4).not.toBe("");
  console.debug(`IPv6 is: ${ips.ipv6}`);
  expect(ips.ipv6).not.toBe("");
});
