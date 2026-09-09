import { z } from "zod";

const id = z.string().uuid();
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

export const agentscanVercelRuntimeAcknowledgeInputSchema = z.object({
  projectId: id,
  expectedScopeVersion: z.number().int().min(1),
  /** A canonical `https://*.vercel.app/` deployment origin. */
  origin: z.string().url().max(512),
  vercelDeploymentId: z.string().regex(/^dpl_[A-Za-z0-9]{1,120}$/u),
}).strict();
export type AgentscanVercelRuntimeAcknowledgeInput = z.infer<typeof agentscanVercelRuntimeAcknowledgeInputSchema>;

export const agentscanVercelRuntimeAcknowledgeResultSchema = z.union([
  z.object({ outcome: z.literal("acknowledged"), deploymentUid: id, endpoint: z.string().url(), healthEndpoint: z.string().url(), runtimeBundleDigest: digest, status: z.enum(["ready", "active"]) }).strict(),
  z.object({ outcome: z.enum(["project_not_found", "scope_changed", "agent_binding_invalid", "runtime_unreachable", "runtime_invalid", "reporting_unavailable"]) }).strict(),
]);
export type AgentscanVercelRuntimeAcknowledgeResult = z.infer<typeof agentscanVercelRuntimeAcknowledgeResultSchema>;
