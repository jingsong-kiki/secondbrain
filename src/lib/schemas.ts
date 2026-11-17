import { z } from "zod";

const SourceTypeSchema = z.enum(["html", "text", "document", "image"]);
const ActionTypeSchema = z.enum([
  "must_read",
  "worth_reading",
  "skim",
  "summary_only",
  "skip",
]);

export const OriginalDataSchema = z.object({
  id: z.string(),
  schemaVersion: z.number().int().optional().default(1),
  source_url: z.string().optional(),
  created_at: z.string(),
  type: SourceTypeSchema,
  original_file: z.string(),
  original_title: z.string(),
  saved: z.boolean().optional(),
}).passthrough();

const HighlightSchema = z.object({
  id: z.string().optional(),
  text: z.string().default(""),
  type: z.enum(["insight", "fact", "actionable"]).catch("insight"),
  reaction: z.enum(["star", "dismiss"]).optional().catch(undefined),
  reactionAt: z.string().optional(),
});

const ConceptSchema = z.object({
  id: z.string().optional(),
  term: z.string().default(""),
  definition: z.string().default(""),
  status: z.enum(["knew", "learned"]).optional().catch(undefined),
  statusAt: z.string().optional(),
});

const TriageSchema = z.object({
  score: z.number().default(50),
  reason: z.string().default("Unable to assess"),
  action: ActionTypeSchema.default("skim"),
  readTimeMinutes: z.number().default(5),
  density: z.number().default(50),
  originality: z.number().default(50),
}).prefault({});

const DigestSchema = z.object({
  summary: z.string().default(""),
  highlights: z.array(HighlightSchema).default([]),
  concepts: z.array(ConceptSchema).default([]),
  structure: z.array(z.string()).default([]),
}).prefault({});

const CritiqueSchema = z.object({
  hiddenAssumptions: z.array(z.string()).default([]),
  potentialIssues: z.array(z.string()).default([]),
  needsVerification: z.array(z.string()).default([]),
  biasIndicators: z.array(z.string()).default([]),
}).prefault({});

export const AnalysisSchema = z.object({
  triage: TriageSchema,
  digest: DigestSchema,
  critique: CritiqueSchema,
  connections: z.array(z.unknown()).optional(),
  connectionError: z.string().optional(),
  analyzedAt: z.string().optional(),
  userRating: z.number().min(0.5).max(5).optional(),
  userRatingAt: z.string().optional(),
}).passthrough().prefault({});

export const SignalChannelSchema = z.enum(["rss", "youtube", "podcast", "x", "browser", "search"]);

const SignalEngagementSchema = z.object({
  dwellSeconds: z.number().optional(),
  scrollDepth: z.number().optional(),
  likesOrReplies: z.number().optional(),
}).partial();

export const IngestItemSchema = z.object({
  id: z.string().optional(),
  channel: SignalChannelSchema,
  sourceId: z.string().min(1),
  sourceName: z.string().min(1),
  authorHandle: z.string().optional(),
  title: z.string().min(1),
  url: z.string().min(1),
  canonicalUrl: z.string().optional(),
  publishedAt: z.string().optional(),
  capturedAt: z.string().optional(),
  rawLengthHint: z.string().optional(),
  snippet: z.string().default(""),
  outboundUrls: z.array(z.string()).optional(),
  thumbnail: z.string().optional(),
  engagement: SignalEngagementSchema.optional(),
});

export const RadarIngestRequestSchema = z.object({
  items: z.array(IngestItemSchema).max(100),
});

export const RadarSourceCreateSchema = z.object({
  channel: z.enum(["rss", "youtube", "podcast", "x"]),
  url: z.string().min(1),
  label: z.string().optional(),
  handle: z.string().optional(),
});

export const RadarSourcePatchSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["active", "candidate", "muted"]).optional(),
  delete: z.boolean().optional(),
}).refine((value) => value.delete === true || value.status !== undefined, {
  message: "status or delete is required",
});

export const RadarFeedbackSchema = z.object({
  action: z.enum(["capture", "dismiss", "follow", "mute"]),
  sourceId: z.string().min(1),
  url: z.string().optional(),
  channel: SignalChannelSchema.optional(),
  sourceName: z.string().optional(),
  handle: z.string().optional(),
});
