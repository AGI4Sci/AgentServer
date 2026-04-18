export interface ScpTool {
  id: string;
  name: string;
  category: string;
  type: 'database' | 'compute_tool' | 'model_service';
  description: string;
  provider: string;
  url: string;
  tools: string[];
}

export interface ScpToolCategory {
  id: string;
  label: string;
  icon: string;
  description: string;
}

export interface ScpToolsData {
  lastUpdated: string;
  categories: ScpToolCategory[];
  tools: ScpTool[];
}

export interface InvokeRequest {
  toolId: string;
  action: string;
  params: Record<string, any>;
  requestId?: string;
  timeout?: number;
}

export interface InvokeResponse {
  success: boolean;
  result?: any;
  error?: string;
  executionTime?: number;
}

export interface ScpServiceCategoryInfo {
  id: string;
  label: string;
  icon: string;
  description: string;
}
