import type { BackgroundJob } from "@kenfutwork/shared";
import { z } from "zod";

const mediaSchema = z.object({
  url: z.string().min(1),
  mimeType: z.string().min(1),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  durationSeconds: z.number().nonnegative().optional(),
});
const storedSchema = z.object({
  asset_id: z.string(),
  object_path: z.string(),
  signed_url: z.string(),
  mime_type: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  duration_seconds: z.number().optional(),
});
const executionSchema = z.object({
  phase: z.enum(["ready", "submitting", "polling", "saving", "publishing"]),
  generated: mediaSchema.optional(),
  sourceObjectPath: z.string().optional(),
  stored: storedSchema.optional(),
  usageRecorded: z.boolean().optional(),
});
export type GeneratedMedia = z.infer<typeof mediaSchema>;
export type JobExecution = z.infer<typeof executionSchema>;
export type JobExecutionWrite = {
  providerJobId?: string;
  providerRevision?: number;
  leaseToken?: string;
};

export function readJobExecution(job: BackgroundJob): JobExecution {
  return executionSchema.parse(
    job.payload._generation_execution ?? {
      phase: job.provider_job_id ? "polling" : "ready",
    },
  );
}

export type JobRetry = {
  errorCode: string;
  errorMessage: string;
  delaySeconds: number;
  execution?: JobExecution;
};
