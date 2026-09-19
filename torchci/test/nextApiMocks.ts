import type { NextApiResponse } from "next";

export type MockApiResponse = NextApiResponse & {
  _status: number;
  _json: any;
  _headers: Record<string, any>;
  _ended: boolean;
};

export function mockRes(): MockApiResponse {
  const res: any = {
    _status: 0,
    _json: null,
    _headers: {},
    _ended: false,
    setHeader(name: string, value: any) {
      res._headers[name] = value;
      return res;
    },
    status(code: number) {
      res._status = code;
      return res;
    },
    json(data: any) {
      res._json = data;
      return res;
    },
    end(data?: any) {
      res._ended = true;
      if (data !== undefined) {
        res._json = data;
      }
      return res;
    },
  };
  return res;
}
