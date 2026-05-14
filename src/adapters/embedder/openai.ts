/**
 * semantic-memory — OpenAI Embedder Adapter
 *
 * Uses the OpenAI text-embedding-3-small model (1536 dimensions).
 * Requires an OpenAI API key passed via configuration.
 *
 * Cost: ~$0.00002 per embedding call.
 * Higher quality embeddings than the local model, useful when
 * recall accuracy is the top priority.
 */

import type { EmbedderFunction } from '../../types.js';

const DEFAULT_MODEL = 'text-embedding-3-small';

/**
 * Create an OpenAI embedder function.
 *
 * @param apiKey - OpenAI API key.
 * @param model - Embedding model name. Default: 'text-embedding-3-small'.
 * @returns An EmbedderFunction that embeds text via OpenAI's API.
 * @throws {Error} If apiKey is not provided.
 */
export function createOpenAIEmbedder(
  apiKey: string,
  model?: string,
): EmbedderFunction {
  if (!apiKey) {
    throw new Error(
      '[semantic-memory] OpenAI embedder requires an API key. ' +
      "Pass it via `openaiApiKey` in the Memory constructor options."
    );
  }

  const embeddingModel = model ?? DEFAULT_MODEL;

  // Lazy-load the OpenAI SDK to avoid breaking apps that don't have it installed
  let clientPromise: Promise<InstanceType<typeof import('openai').default>> | null = null;

  function getClient(): Promise<InstanceType<typeof import('openai').default>> {
    if (!clientPromise) {
      clientPromise = (async () => {
        try {
          const { default: OpenAI } = await import('openai');
          return new OpenAI({ apiKey });
        } catch {
          throw new Error(
            '[semantic-memory] The "openai" package is required for the OpenAI embedder. ' +
            'Install it with: npm install openai'
          );
        }
      })();
    }
    return clientPromise;
  }

  return async (text: string): Promise<number[]> => {
    const client = await getClient();

    const response = await client.embeddings.create({
      model: embeddingModel,
      input: text,
    });

    const embedding = response.data[0]?.embedding;
    if (!embedding || embedding.length === 0) {
      throw new Error('[semantic-memory] OpenAI returned empty embedding');
    }

    return embedding;
  };
}
