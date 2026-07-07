// Hand-distilled from docs/vllm-omni-openapi.json — only the fields the UI uses.

export interface ModelInfo {
  id: string
  max_model_len?: number
}

// —— chat ——

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

export interface ChatParams {
  temperature: number
  top_p: number
  max_tokens: number
  system: string
}

// —— images ——

export interface ImageGenRequest {
  prompt: string
  model?: string
  n?: number
  size?: string
  response_format?: 'b64_json' | 'url'
  negative_prompt?: string
  num_inference_steps?: number
  guidance_scale?: number
  true_cfg_scale?: number
  seed?: number
  output_format?: string
}

export interface ImageDatum {
  b64_json?: string
  url?: string
  revised_prompt?: string
}

export interface ImagesResponse {
  created: number
  data: ImageDatum[]
  usage?: unknown
  [k: string]: unknown
}

// —— videos ——

export type VideoStatus = 'queued' | 'in_progress' | 'completed' | 'failed'

export interface VideoJob {
  id: string
  model: string
  prompt: string
  status: VideoStatus
  progress: number
  size?: string | null
  seconds?: string
  created_at: number
  completed_at?: number | null
  error?: { message?: string; code?: string } | null
  media_type?: string
  inference_time_s?: number | null
  peak_memory_mb?: number
  stage_durations?: Record<string, number>
}

export interface VideoListResponse {
  data: VideoJob[]
}
