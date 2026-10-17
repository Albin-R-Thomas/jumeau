import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { ApiError, unavailable } from "./errors";
import { Cursor, History, Source } from "./types";
const cursorSchema = z
  .object({
    v: z.literal(1),
    timestamp: z.iso.datetime(),
    id: z.string().uuid(),
  })
  .strict();
export function decodeCursor(value: string): Cursor {
  try {
    if (value.length > 300 || !/^[A-Za-z0-9_-]+$/.test(value))
      throw new Error();
    const buffer = Buffer.from(value, "base64url");
    if (buffer.toString("base64url") !== value) throw new Error();
    const cursor = cursorSchema.parse(JSON.parse(buffer.toString("utf8")));
    if (new Date(cursor.timestamp).toISOString() !== cursor.timestamp)
      throw new Error();
    return cursor;
  } catch {
    throw new ApiError(400, "INVALID_INPUT", "Invalid history cursor.");
  }
}
export const encodeCursor = (cursor: Cursor) =>
  Buffer.from(JSON.stringify(cursor)).toString("base64url");
export class PrismaHistory implements History {
  constructor(private db: PrismaClient) {}
  async record(city: string, source: Source) {
    try {
      await this.db.searchHistory.create({ data: { city_name: city, source } });
    } catch {
      throw unavailable();
    }
  }
  async page(limit: number, cursor?: Cursor) {
    try {
      const rows = await this.db.searchHistory.findMany({
        take: limit + 1,
        orderBy: [{ timestamp: "desc" }, { id: "desc" }],
        where: cursor
          ? {
              OR: [
                { timestamp: { lt: new Date(cursor.timestamp) } },
                {
                  timestamp: new Date(cursor.timestamp),
                  id: { lt: cursor.id },
                },
              ],
            }
          : undefined,
      });
      const items = rows
        .slice(0, limit)
        .map((r) => ({ ...r, timestamp: r.timestamp.toISOString() }));
      const last = items.at(-1);
      return {
        items,
        next_cursor:
          rows.length > limit && last
            ? encodeCursor({ v: 1, timestamp: last.timestamp, id: last.id })
            : null,
      };
    } catch {
      throw unavailable();
    }
  }
  async delete() {
    try {
      await this.db.searchHistory.deleteMany();
    } catch {
      throw unavailable();
    }
  }
}
