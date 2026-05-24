import * as z from "zod/v4";

export const idString = z.string().min(1).describe("Google Marketing Platform ID as a string.");

export const jsonObject = z
  .record(z.string(), z.unknown())
  .describe("Raw Google Marketing Platform JSON resource object. Use official API field names.");

export const querySchema = z
  .record(
    z.string(),
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.array(z.union([z.string(), z.number(), z.boolean()]))
    ])
  )
  .optional()
  .describe("Optional Google API query parameters using official API field names.");

export const dryRunSchema = z
  .boolean()
  .optional()
  .default(true)
  .describe("When true, return the exact request preview without changing the GMP product.");

export const confirmSchema = z
  .boolean()
  .optional()
  .default(false)
  .describe("Required as true for live write requests after reviewing the payload.");

export const profileInput = z.object({
  profileId: idString
});

export const listInput = z.object({
  profileId: idString,
  query: querySchema
});

export const getInput = z.object({
  profileId: idString,
  id: idString
});

export const mutationControls = {
  dryRun: dryRunSchema,
  confirm: confirmSchema
};
