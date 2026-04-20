export interface Project {
    id: string;
    name: string;
    created_at: string;
}
export interface PageNode {
    id: string;
    path: string;
    name: string;
    display_name: string;
    num: string | null;
    type: 'page' | 'folder';
    file_type?: 'md' | 'html';
    content?: string;
    parent_id?: string | null;
    children?: PageNode[];
    child_count: number;
    created_at: string;
    updated_at: string;
    assets?: Asset[];
}
export interface Asset {
    id: string;
    page_id: string | null;
    filename: string;
    original_name: string;
    mime_type: string | null;
    size: number;
    created_at: string;
    url: string;
}
export interface Settings {
    theme: 'dark' | 'light';
    llm_provider: 'openai' | 'gemini' | 'claude' | 'openai-compatible';
    llm_model: string;
    llm_api_key: string;
    llm_base_url: string;
    image_model: string;
    [key: string]: string;
}
export interface ChatMessage {
    id: string;
    page_id: string | null;
    role: 'user' | 'assistant';
    content: string;
    created_at: string;
}
export type LLMMessage = {
    role: 'system' | 'user' | 'assistant';
    content: string;
};
export type LLMProvider = 'openai' | 'openai-compatible' | 'gemini' | 'claude';
export interface AIOptions {
    provider?: LLMProvider;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
}
export interface ImageResult {
    url?: string;
    base64?: string;
    mimeType?: string;
    revised_prompt?: string;
}
export interface ProjectsResponse {
    projects: Project[];
}
export interface PagesResponse {
    pages: PageNode[];
}
export interface PageResponse {
    page: PageNode;
}
export interface AssetsResponse {
    assets: Asset[];
}
export interface AssetResponse {
    asset: Asset;
}
export interface SettingsResponse {
    settings: Settings;
}
export interface HealthResponse {
    status: string;
    version: string;
    app: string;
}
export interface ErrorResponse {
    error: string;
}
export interface SuccessResponse {
    success: boolean;
}
//# sourceMappingURL=types.d.ts.map