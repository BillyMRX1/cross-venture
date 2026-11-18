import {
  getGenerativeModel,
  InferenceMode,
  type GenerationConfig,
  type GenerativeModel,
  type SchemaRequest,
} from 'firebase/ai';
import { cloudModel, getAIInstance, isConfigured, onDeviceModel } from './firebase';

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
  jsonSchema?: object
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
    const result = await model.generateContent(prompt);
    return {
      text: result.response.text(),
      usedOnDevice: false,
      model: modelName,
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
  availability?: (options?: { expectedInputs?: Array<{ type: string }> }) => Promise<string>;
  create?: (options?: {
    temperature?: number;
    expectedInputs?: Array<{ type: string }>;
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
      const status = await lm.availability({ expectedInputs: [{ type: 'text' }] });
      return {
        available: status === 'available',
        detail: String(status),
      };
    }

    if (typeof lm?.create === 'function') {
      const session = await lm.create({
        temperature: 0,
        expectedInputs: [{ type: 'text' }],
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
