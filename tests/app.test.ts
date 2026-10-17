import request from "supertest";
import { createApp } from "../src/app";
import { encodeCursor } from "../src/history";
import { History } from "../src/types";
import { ApiError } from "../src/errors";
import { weather } from "./helpers";
const history: jest.Mocked<History> = {
  record: jest.fn(),
  page: jest.fn().mockResolvedValue({ items: [], next_cursor: null }),
  delete: jest.fn().mockResolvedValue(undefined),
};
const service = { get: jest.fn().mockResolvedValue(weather) };
const app = createApp("test-placeholder", service, history);
const auth = (r: request.Test) => r.set("X-API-Key", "test-placeholder");
test("health probe succeeds without credentials or provider access", async () => {
  const response = await request(app).get("/health");
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ status: "ok" });
  expect(service.get).not.toHaveBeenCalled();
  expect(history.page).not.toHaveBeenCalled();
});
test.each([
  ["get", "/weather?city=London"],
  ["get", "/history"],
  ["delete", "/history"],
])("authenticates %s %s before dependencies", async (method, path) => {
  for (const key of [undefined, "wrong"]) {
    const r =
      method === "get" ? request(app).get(path!) : request(app).delete(path!);
    if (key) r.set("X-API-Key", key);
    expect((await r).status).toBe(401);
  }
  expect(service.get).not.toHaveBeenCalled();
  expect(history.page).not.toHaveBeenCalled();
  expect(history.delete).not.toHaveBeenCalled();
});
test.each([
  "",
  "?city=",
  "?city=a&city=b",
  "?city=a%00",
  "?city=a,b,c,d",
  "?city=a,XYZ",
  "?city=a,CA,GB",
  "?city=" + "a".repeat(101),
  "?city=London&other=x",
])("invalid weather query %s", async (query) => {
  expect((await auth(request(app).get("/weather" + query))).status).toBe(400);
});
test.each(["London", "London,GB", "Portland,OR,US"])(
  "valid city %s",
  async (city) => {
    const r = await auth(
      request(app)
        .get("/weather")
        .query({ city: " " + city + " " }),
    );
    expect(r.body).toEqual(weather);
    expect(service.get).toHaveBeenCalledWith(city);
  },
);
test.each([
  "?limit=0",
  "?limit=101",
  "?limit=1.2",
  "?limit=2&limit=3",
  "?cursor=bad",
  "?cursor=",
  "?other=x",
])("invalid history query %s", async (query) => {
  expect((await auth(request(app).get("/history" + query))).status).toBe(400);
});
test("history default and valid cursor", async () => {
  expect((await auth(request(app).get("/history"))).body).toEqual({
    items: [],
    next_cursor: null,
  });
  const cursor = {
    v: 1 as const,
    timestamp: "2026-10-14T08:00:00.000Z",
    id: "12345678-1234-4234-8234-123456789abc",
  };
  await auth(
    request(app)
      .get("/history")
      .query({ limit: 1, cursor: encodeCursor(cursor) }),
  );
  expect(history.page).toHaveBeenCalledWith(1, cursor);
});
test("deletion is 204 including empty history", async () => {
  for (let i = 0; i < 2; i++)
    expect((await auth(request(app).delete("/history"))).status).toBe(204);
});
test("error mapping and retry header", async () => {
  service.get.mockRejectedValueOnce(
    new ApiError(429, "LOCAL_QUOTA_EXCEEDED", "Budget exhausted.", 60),
  );
  const r = await auth(request(app).get("/weather?city=London"));
  expect(r.status).toBe(429);
  expect(r.headers["retry-after"]).toBe("60");
  expect(r.body.code).toBe("LOCAL_QUOTA_EXCEEDED");
});
test("unregistered routes return 404", async () => {
  expect((await auth(request(app).get("/unregistered"))).status).toBe(404);
});
