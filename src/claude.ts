// The one place Bookr calls Claude. Reads a photo or PDF of a page and returns structured data.
// The API key comes from the ANTHROPIC_API_KEY Worker secret and never leaves the server.
// Tests replace this module, so no test ever calls the API.

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import type { Env } from './types';

export const DEFAULT_OCR_MODEL = 'claude-opus-5-5';

export class OcrError extends Error {
  constructor(public status: 400 | 409 | 429 | 502 | 503, message: string) {
    super(message);
  }
}

export interface PageImage {
  bytes: Uint8Array;
  mediaType: 'image/jpeg' | 'image/png' | 'application/pdf';
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // the API's limit for one image

function toBase64(bytes: Uint8Array): string {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(out);
}

export async function readWithClaude<T extends z.ZodType>(
  env: Env,
  page: PageImage,
  instructions: string,
  schema: T,
): Promise<{ data: z.infer<T>; model: string }> {
  if (!env.ANTHROPIC_API_KEY) throw new OcrError(503, 'Reading pages is not set up: the ANTHROPIC_API_KEY secret is missing on the server. You can still type the rows in.');
  if (page.mediaType !== 'application/pdf' && page.bytes.length > MAX_IMAGE_BYTES) {
    throw new OcrError(400, 'This photo is larger than 5 MB, which is too large to read. Take it again at a lower resolution, or type the rows in.');
  }
  const model = env.CLAUDE_OCR_MODEL || DEFAULT_OCR_MODEL;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 120_000 });
  const data = toBase64(page.bytes);
  const source = page.mediaType === 'application/pdf'
    ? { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data } }
    : { type: 'image' as const, source: { type: 'base64' as const, media_type: page.mediaType, data } };

  try {
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: betaZodOutputFormat(schema) },
      messages: [{ role: 'user', content: [source, { type: 'text', text: instructions }] }],
    });
    if (response.stop_reason === 'refusal') throw new OcrError(502, 'Claude declined to read this page. Type the rows in instead.');
    if (response.stop_reason === 'max_tokens') throw new OcrError(502, 'The page has more rows than one reading can hold. Split it into two photos, or type the rows in.');
    if (!response.parsed_output) throw new OcrError(502, 'Claude did not return the rows in the expected form. Try again, or type the rows in.');
    return { data: response.parsed_output as z.infer<T>, model: response.model };
  } catch (e) {
    if (e instanceof OcrError) throw e;
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      throw new OcrError(503, 'The server could not sign in to Claude. Check the ANTHROPIC_API_KEY secret. You can still type the rows in.');
    }
    if (e instanceof Anthropic.NotFoundError) throw new OcrError(503, `The model "${model}" was not found. Check the CLAUDE_OCR_MODEL setting.`);
    if (e instanceof Anthropic.RateLimitError) throw new OcrError(429, 'Claude is busy right now. Try again in a minute.');
    if (e instanceof Anthropic.BadRequestError) throw new OcrError(502, 'Claude could not read this file. Try a clearer photo, or type the rows in.');
    if (e instanceof Anthropic.APIError) throw new OcrError(502, 'Reading the page failed on Claude’s side. Try again shortly, or type the rows in.');
    throw new OcrError(502, 'Could not reach Claude. Try again shortly, or type the rows in.');
  }
}
