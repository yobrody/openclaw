import { z } from "zod";

const AgentModelRoutingRuleSchema = z
  .object({
    contains: z.array(z.string()).optional(),
    containsAny: z.array(z.string()).optional(),
    regex: z.string().optional(),
    maxLength: z.number().optional(),
    minLength: z.number().optional(),
    model: z.string(),
  })
  .strict();

export const AgentModelSchema = z.union([
  z.string(),
  z
    .object({
      primary: z.string().optional(),
      fallbacks: z.array(z.string()).optional(),
      routing: z.array(AgentModelRoutingRuleSchema).optional(),
    })
    .strict(),
]);
