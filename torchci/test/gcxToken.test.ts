import { NextApiRequest, NextApiResponse } from "next";
import * as nextAuth from "next-auth";
import handler from "../pages/api/gcx-token";
import * as generalUtils from "../lib/GeneralUtils";
import * as github from "../lib/github";
import * as serviceAccount from "../lib/grafana/serviceAccount";

function mockReqRes(overrides: Partial<NextApiRequest> = {}) {
  const req = {
    method: "GET",
    headers: {},
    query: {},
    cookies: {},
    ...overrides,
  } as unknown as NextApiRequest;

  const res = {
    statusCode: 0,
    body: undefined as any,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
    send(payload: any) {
      this.body = payload;
      return this;
    },
    setHeader(key: string, value: string) {
      this.headers[key] = value;
    },
  };

  return { req, res: res as unknown as NextApiResponse & typeof res };
}

function mockOctokit(login: string | null) {
  return {
    rest: {
      users: {
        getAuthenticated: jest
          .fn()
          .mockResolvedValue({ data: login ? { login } : {} }),
      },
    },
  } as any;
}

describe("/api/gcx-token", () => {
  afterEach(() => jest.restoreAllMocks());

  test("405 on unsupported method", async () => {
    const { req, res } = mockReqRes({ method: "DELETE" } as any);
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  test("401 when no bearer token and no session", async () => {
    jest.spyOn(nextAuth, "getServerSession").mockResolvedValue(null as any);
    const { req, res } = mockReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  test("403 when authenticated but lacks pytorch/pytorch write access", async () => {
    jest
      .spyOn(github, "getOctokitWithUserToken")
      .mockResolvedValue(mockOctokit("someuser"));
    jest
      .spyOn(generalUtils, "hasWritePermissionsUsingOctokit")
      .mockResolvedValue(false);
    const mint = jest.spyOn(serviceAccount, "mintGcxViewerToken");

    const { req, res } = mockReqRes({
      headers: { authorization: "Bearer gho_faketoken" },
    } as any);
    await handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(mint).not.toHaveBeenCalled();
  });

  test("200 + plain-text token for a writer", async () => {
    jest
      .spyOn(github, "getOctokitWithUserToken")
      .mockResolvedValue(mockOctokit("writeruser"));
    jest
      .spyOn(generalUtils, "hasWritePermissionsUsingOctokit")
      .mockResolvedValue(true);
    jest
      .spyOn(serviceAccount, "mintGcxViewerToken")
      .mockResolvedValue("glsa_minted_for_writeruser");

    const { req, res } = mockReqRes({
      headers: { authorization: "Bearer gho_faketoken" },
    } as any);
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("glsa_minted_for_writeruser");
    expect(res.headers["Content-Type"]).toContain("text/plain");
  });

  test("200 + JSON token when Accept: application/json", async () => {
    jest
      .spyOn(github, "getOctokitWithUserToken")
      .mockResolvedValue(mockOctokit("writeruser"));
    jest
      .spyOn(generalUtils, "hasWritePermissionsUsingOctokit")
      .mockResolvedValue(true);
    jest
      .spyOn(serviceAccount, "mintGcxViewerToken")
      .mockResolvedValue("glsa_minted_for_writeruser");

    const { req, res } = mockReqRes({
      headers: {
        authorization: "Bearer gho_faketoken",
        accept: "application/json",
      },
    } as any);
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBe("glsa_minted_for_writeruser");
    expect(res.body.grafanaServer).toContain("grafana.net");
  });
});
