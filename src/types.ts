import { z } from "zod";
export const weatherSchema = z.object({
  city: z.string().min(1),
  country: z.string().regex(/^[A-Z]{2}$/),
  temperature_celsius: z.number().finite(),
  condition: z.string().min(1),
  humidity_percent: z.number().min(0).max(100),
  observed_at: z.iso.datetime(),
});
export type Weather = z.infer<typeof weatherSchema>;
export const geoSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});
export type Geo = z.infer<typeof geoSchema>;
export type Source = "cache" | "provider";
export interface Store {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttl: number): Promise<void>;
  reserve(): Promise<void>;
  cooldown(seconds: number): Promise<void>;
}
export interface History {
  record(city: string, source: Source): Promise<void>;
  page(
    limit: number,
    cursor?: Cursor,
  ): Promise<{ items: HistoryItem[]; next_cursor: string | null }>;
  delete(): Promise<void>;
}
export type Cursor = { v: 1; timestamp: string; id: string };
export type HistoryItem = {
  id: string;
  city_name: string;
  timestamp: string;
  source: Source;
};
