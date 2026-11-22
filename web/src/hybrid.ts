import {
  getGenerativeModel,
  InferenceMode,
  type GenerationConfig,
  type GenerativeModel,
  type SchemaRequest,
} from 'firebase/ai';
import { cloudModel, cloudModelFallback, getAIInstance, isConfigured, onDeviceModel } from './firebase';
import { TRANSIENT_BUSY_MESSAGE, TransientExhaustedError, withTransientRetry } from './cloud/transient';

export type InferenceStage = 'redact' | 'query' | 'synthesize';

export interface GenResult {
  text: string;
  usedOnDevice: boolean;
  model: string;
}

export class HybridUnavailableError extends Error {
  stage: InferenceStage;
  reason: string;

  constructor(stage: InferenceStage, reason: string) {
    super(`Hybrid AI unavailable at stage "${stage}": ${reason}`);
    this.name = 'HybridUnavailableError';
    this.stage = stage;
    this.reason = reason;
  }
}

let onDeviceInitPromise: Promise<GenerativeModel> | null = null;

async function ensureOnDeviceBaseModel(): Promise<GenerativeModel> {
  if (!onDeviceInitPromise) {
    onDeviceInitPromise = (async () => {
      const ai = await getAIInstance();
      if (!ai) {
        throw new Error('firebase-not-configured');
      }
      const model = getGenerativeModel(ai, {
        mode: InferenceMode.ONLY_ON_DEVICE,
        onDeviceParams: {
          createOptions: {
            expectedInputs: [{ type: 'text' }],
            expectedOutputs: [{ type: 'text', languages: ['en'] }],
          },
        },
        inCloudParams: {
          model: cloudModel(),
        },
      });
      await model.initializeDeviceModel();
      return model;
    })().catch((err) => {
      // Allow retrying initialization later (e.g. after user gesture or model download).
      onDeviceInitPromise = null;
      throw err;
    });
  }
  return onDeviceInitPromise;
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name;
  }
  return String(err);
}

/**
 * Runs inference for the given pipeline stage while enforcing privacy routing:
 * - 'synthesize': cloud only (receives already-blinded text).
 * - 'redact' | 'query': strictly ONLY_ON_DEVICE (never falls back to cloud).
 */
export async function generate(
  stage: InferenceStage,
  prompt: string,
  jsonSchema?: object,
  opts?: { onRetry?: (attempt: number, waitMs: number, kind: string) => void }
): Promise<GenResult> {
  if (stage === 'synthesize') {
    const ai = await getAIInstance();
    if (!ai) {
      throw new HybridUnavailableError('synthesize', 'firebase-not-configured');
    }
    const modelName = cloudModel();
    const generationConfig: GenerationConfig = jsonSchema
      ? {
          responseMimeType: 'application/json',
          responseSchema: jsonSchema as SchemaRequest,
        }
      : {};
    const model = getGenerativeModel(ai, {
      model: modelName,
      generationConfig,
    });
    // Bounded transient handling (CEO 2026-11-22): 500 high-demand / 503 / 429
    // only, exponential backoff + jitter, max 3 total calls per payload.
    // Auth/model 4xx errors are never retried.
    let result: Awaited<ReturnType<GenerativeModel['generateContent']>>;
    let usedModel = modelName;
    try {
      result = await withTransientRetry(() => model.generateContent(prompt), {
        maxAttempts: 3,
        onRetry: opts?.onRetry,
      });
    } catch (err) {
      const fallback = cloudModelFallback();
      if (err instanceof TransientExhaustedError && fallback && fallback !== modelName) {
        // Opt-in fallback (default OFF): exactly one attempt on the fallback model.
        try {
          const fbModel = getGenerativeModel(ai, { model: fallback, generationConfig });
          result = await fbModel.generateContent(prompt);
          usedModel = fallback;
        } catch (fbErr) {
          if (fbErr instanceof TransientExhaustedError) throw fbErr;
          throw new TransientExhaustedError(
            `${TRANSIENT_BUSY_MESSAGE} (fallback model also failed)`,
            1,
            fbErr,
          );
        }
      } else {
        throw err;
      }
    }
    return {
      text: result.response.text(),
      usedOnDevice: false,
      model: usedModel,
    };
  }

  // 'redact' | 'query' — strictly on-device only.
  if (!isConfigured()) {
    throw new HybridUnavailableError(stage, 'firebase-not-configured');
  }

  try {
    const baseModel = await ensureOnDeviceBaseModel();
    let activeModel = baseModel;
    let effectivePrompt = prompt;

    if (jsonSchema) {
      const ai = await getAIInstance();
      if (!ai) {
        throw new Error('firebase-not-configured');
      }
      activeModel = getGenerativeModel(ai, {
        mode: InferenceMode.ONLY_ON_DEVICE,
        onDeviceParams: {
          createOptions: {
            expectedInputs: [{ type: 'text' }],
            expectedOutputs: [{ type: 'text', languages: ['en'] }],
          },
          promptOptions: {
            responseConstraint: jsonSchema,
          },
        },
        inCloudParams: {
          model: cloudModel(),
        },
      });
      // Only required (and only safe) after initializeDeviceModel() on THIS instance:
      // inference before device-model init errors out under ONLY_ON_DEVICE.
      await activeModel.initializeDeviceModel();
      effectivePrompt = `${prompt}\n\nRespond with valid JSON matching this schema:\n${JSON.stringify(jsonSchema)}`;
    }

    const result = await activeModel.generateContent(effectivePrompt);
    return {
      text: result.response.text(),
      usedOnDevice: true,
      model: onDeviceModel(),
    };
  } catch (err) {
    if (err instanceof HybridUnavailableError) {
      throw err;
    }
    throw new HybridUnavailableError(stage, toErrorMessage(err));
  }
}

interface PromptApiSession {
  prompt(input: string): Promise<string>;
  destroy?: () => void;
}

interface PromptApiGlobal {
  availability?: (options?: {
    expectedInputs?: Array<{ type: string }>;
    expectedOutputs?: Array<{ type: string; languages?: string[] }>;
  }) => Promise<string>;
  create?: (options?: {
    temperature?: number;
    expectedInputs?: Array<{ type: string }>;
    expectedOutputs?: Array<{ type: string; languages?: string[] }>;
    initialPrompts?: Array<{ role: string; content: string }>;
    monitor?: () => void;
  }) => Promise<PromptApiSession>;
}

/**
 * Probes Chrome's built-in Prompt API (LanguageModel) directly without initializing Firebase.
 * Never throws; safe in Node and unsupported browsers.
 */
export async function onDeviceStatus(): Promise<{ available: boolean; detail: string }> {
  try {
    const lm = (globalThis as Record<string, unknown>).LanguageModel as PromptApiGlobal | undefined;
    if (typeof lm?.availability === 'function') {
      const status = await lm.availability({
        expectedInputs: [{ type: 'text' }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
      });
      return {
        available: status === 'available',
        detail: String(status),
      };
    }

    if (typeof lm?.create === 'function') {
      const session = await lm.create({
        temperature: 0,
        expectedInputs: [{ type: 'text' }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
        initialPrompts: [{ role: 'system', content: 'Respond with the single letter X.' }],
        monitor: () => {},
      });
      try {
        await session.prompt('x');
      } finally {
        if (typeof session?.destroy === 'function') {
          session.destroy();
        }
      }
      return { available: true, detail: 'ping-ok' };
    }

    return { available: false, detail: 'prompt-api-not-exposed' };
  } catch (err) {
    return { available: false, detail: toErrorMessage(err) || 'on-device-probe-failed' };
  }
}
