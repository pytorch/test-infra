import { z } from "zod";

export const BenchmarkGroupRequest = z.record(z.unknown()).and(
  z.object({
    repo: z.string(),
    benchmark_name: z.string(),
    start_time: z.string(),
    end_time: z.string(),
    group_table_by_fields: z.array(z.string()).optional(),
    group_row_by_fields: z.array(z.string()).optional(),
  })
);
