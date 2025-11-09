import axios, { AxiosInstance } from 'axios';
import * as vscode from 'vscode';
import { EmbeddingProvider } from '../types';

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private client: AxiosInstance;
  private model: string;
  private keepAlive: string;
  private dimensions: number = 768; // Default for nomic-embed-text

  constructor(endpoint: string, model: string, keepAlive: string = '30m') {
    this.client = axios.create({
      baseURL: endpoint,
      timeout: 30000,
    });
    this.model = model;
    this.keepAlive = keepAlive;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const maxRetries = 3;
    const baseDelay = 1000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.client.post('/api/embeddings', {
          model: this.model,
          prompt: text,
          keep_alive: this.keepAlive,
        });

        if (response.data && response.data.embedding) {
          this.dimensions = response.data.embedding.length;
          return response.data.embedding;
        }

        throw new Error('Invalid response from Ollama');
      } catch (error) {
        const isLastAttempt = attempt === maxRetries;
        const isRetryableError =
          axios.isAxiosError(error) &&
          (error.response?.status === 500 ||
            error.code === 'ECONNRESET' ||
            error.code === 'ETIMEDOUT');

        if (isRetryableError && !isLastAttempt) {
          const delay = baseDelay * Math.pow(2, attempt);
          console.warn(
            `Ollama API error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms...`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        if (axios.isAxiosError(error)) {
          throw new Error(
            `Ollama API error: ${error.message}. Make sure Ollama is running at the configured endpoint.`
          );
        }
        throw error;
      }
    }

    throw new Error('Failed to generate embedding after retries');
  }

  getDimensions(): number {
    return this.dimensions;
  }
}

export class CustomEmbeddingProvider implements EmbeddingProvider {
  private client: AxiosInstance;
  private apiKey: string;
  private dimensions: number = 768;

  constructor(endpoint: string, apiKey: string) {
    this.client = axios.create({
      baseURL: endpoint,
      timeout: 30000,
      headers: apiKey
        ? {
            Authorization: `Bearer ${apiKey}`,
          }
        : {},
    });
    this.apiKey = apiKey;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const maxRetries = 3;
    const baseDelay = 1000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Try multiple API formats to support different providers
        // 1. OpenAI-compatible format (most common)
        let response;
        try {
          response = await this.client.post('/v1/embeddings', {
            input: text,
            model: 'text-embedding-ada-002', // Some APIs require this
          });
        } catch (firstError) {
          // 2. Fallback to simpler format (TabbyML, etc.)
          response = await this.client.post('/embeddings', {
            text: text,
          });
        }

        // Handle different response formats
        let embedding: number[] | undefined;

        // OpenAI format: { data: [{ embedding: [...] }] }
        if (response.data?.data?.[0]?.embedding) {
          embedding = response.data.data[0].embedding;
        }
        // Simple format: { embedding: [...] }
        else if (response.data?.embedding) {
          embedding = response.data.embedding;
        }
        // TabbyML format: { embeddings: [[...]] }
        else if (response.data?.embeddings?.[0]) {
          embedding = response.data.embeddings[0];
        }

        if (embedding && Array.isArray(embedding)) {
          this.dimensions = embedding.length;
          return embedding;
        }

        throw new Error('Invalid response format from custom endpoint');
      } catch (error) {
        const isLastAttempt = attempt === maxRetries;
        const isRetryableError =
          axios.isAxiosError(error) &&
          (error.response?.status === 500 ||
            error.code === 'ECONNRESET' ||
            error.code === 'ETIMEDOUT');

        if (isRetryableError && !isLastAttempt) {
          const delay = baseDelay * Math.pow(2, attempt);
          console.warn(
            `Custom API error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms...`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        if (axios.isAxiosError(error)) {
          throw new Error(
            `Custom API error: ${error.message}. Make sure the endpoint is correct and the API is running.`
          );
        }
        throw error;
      }
    }

    throw new Error('Failed to generate embedding after retries');
  }

  getDimensions(): number {
    return this.dimensions;
  }
}

export class EmbeddingService {
  private provider: EmbeddingProvider | null = null;

  constructor() {
    this.updateProvider();
  }

  updateProvider(): void {
    const config = vscode.workspace.getConfiguration('caffeinated');
    const providerType = config.get<string>('embeddingProvider', 'ollama');

    if (providerType === 'ollama') {
      const endpoint = config.get<string>('ollamaEndpoint', 'http://localhost:11434');
      const model = config.get<string>('ollamaModel', 'nomic-embed-text');
      const keepAlive = config.get<string>('ollamaKeepAlive', '30m');
      this.provider = new OllamaEmbeddingProvider(endpoint, model, keepAlive);
    } else {
      const endpoint = config.get<string>('customEndpoint', '');
      const apiKey = config.get<string>('customApiKey', '');
      if (!endpoint) {
        throw new Error('Custom endpoint not configured');
      }
      this.provider = new CustomEmbeddingProvider(endpoint, apiKey);
    }
  }

  async generateEmbedding(text: string): Promise<number[]> {
    if (!this.provider) {
      throw new Error('Embedding provider not initialized');
    }
    return this.provider.generateEmbedding(text);
  }

  getDimensions(): number {
    if (!this.provider) {
      throw new Error('Embedding provider not initialized');
    }
    return this.provider.getDimensions();
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.generateEmbedding('test');
      return true;
    } catch (error) {
      return false;
    }
  }
}
