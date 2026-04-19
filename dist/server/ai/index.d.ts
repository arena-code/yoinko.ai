import type { LLMMessage, AIOptions, ImageResult } from '../../shared/types.js';
export declare function generateText(messages: LLMMessage[], opts?: AIOptions): Promise<string>;
export declare function streamText(messages: LLMMessage[], opts?: AIOptions): AsyncGenerator<string>;
export declare function generateImage(prompt: string): Promise<ImageResult>;
//# sourceMappingURL=index.d.ts.map