import type { InvokeResponse } from './types.js';
import { getScpHubApiKey, getScpHubBaseUrl, getTool } from './catalog.js';

const DEFAULT_TIMEOUT_MS = 30000;

export async function invokeMcpTool(
  toolId: string,
  action: string,
  params: Record<string, any>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<InvokeResponse> {
  const startTime = Date.now();
  const apiKey = getScpHubApiKey();

  if (!apiKey) {
    return {
      success: false,
      error: 'SCP Hub API key not configured. Please set integrations.scpHub.apiKey in openteam.json.',
      executionTime: 0,
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const mcpRequest = {
      jsonrpc: '2.0',
      id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      method: 'tools/call',
      params: {
        name: `${toolId}_${action}`,
        arguments: params,
      },
    };

    try {
      const response = await fetch(`${getScpHubBaseUrl()}/api/mcp/v1/invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(mcpRequest),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return {
          success: false,
          error: `HTTP ${response.status}: ${await response.text()}`,
          executionTime: Date.now() - startTime,
        };
      }

      const result = await response.json();
      if (result.error) {
        return {
          success: false,
          error: result.error.message || JSON.stringify(result.error),
          executionTime: Date.now() - startTime,
        };
      }

      return {
        success: true,
        result: result.result?.content || result.result,
        executionTime: Date.now() - startTime,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (errorMessage.includes('abort')) {
      return {
        success: false,
        error: `Request timeout after ${timeoutMs}ms`,
        executionTime: Date.now() - startTime,
      };
    }

    console.error('[SCP-Tools] Invoke error:', err);
    return {
      success: false,
      error: errorMessage,
      executionTime: Date.now() - startTime,
    };
  }
}

export async function mockInvokeTool(
  toolId: string,
  action: string,
  params: Record<string, any>,
): Promise<InvokeResponse> {
  const startTime = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 300 + Math.random() * 500));

  const normalizedMockId = toolId.replace(/_/g, '-');
  if (normalizedMockId === 'sequence-alignment-pairwise') {
    const seqA = params.seq_a || params.seqA || params.a || 'ATGC';
    const seqB = params.seq_b || params.seqB || params.b || 'ATGG';
    return {
      success: true,
      result: {
        toolId: normalizedMockId,
        action,
        seqA: String(seqA).slice(0, 120),
        seqB: String(seqB).slice(0, 120),
        identityPercent: (82 + Math.random() * 15).toFixed(1),
        note: 'Mock pairwise alignment — agents/skills/scp/sequence-alignment-pairwise (T006); use Hub catalog when available',
      },
      executionTime: Date.now() - startTime,
    };
  }

  const tool = await getTool(toolId);
  if (!tool) {
    return {
      success: false,
      error: `Tool not found: ${toolId}`,
      executionTime: Date.now() - startTime,
    };
  }

  if (toolId === 'protein-properties-calculation' || toolId === 'protein_properties_calculation') {
    const sequence = params.sequence || params.protein || 'MKFLILLFNILCLFPVLAADNH';
    const length = sequence.length;
    return {
      success: true,
      result: {
        toolId,
        action,
        sequence: sequence.slice(0, 50) + (length > 50 ? '...' : ''),
        sequenceLength: length,
        properties: {
          molecularWeight: `${(length * 110).toFixed(2)} Da`,
          isoelectricPoint: (6.5 + Math.random() * 2).toFixed(2),
          instabilityIndex: (30 + Math.random() * 20).toFixed(2),
          aliphaticIndex: (80 + Math.random() * 20).toFixed(2),
          gravy: (-0.5 + Math.random()).toFixed(3),
          aminoAcidComposition: {
            Ala: '8.5%', Leu: '12.3%', Val: '6.2%', Ile: '5.8%',
            Pro: '4.2%', Phe: '3.5%', Trp: '1.2%', Met: '2.1%',
            Gly: '7.4%', Ser: '6.8%', Thr: '5.5%', Cys: '1.8%',
            Tyr: '3.2%', Asn: '4.1%', Gln: '3.8%', Asp: '5.2%',
            Glu: '6.1%', Lys: '5.8%', Arg: '4.5%', His: '2.2%'
          }
        },
        note: 'Mock result - configure SCP_HUB_API_KEY for real computation'
      },
      executionTime: Date.now() - startTime,
    };
  }

  if (toolId === 'molecular-properties-calculation' || toolId === 'molecular_properties_calculation') {
    const smiles = params.smiles || params.molecule || 'CCO';
    return {
      success: true,
      result: {
        toolId,
        action,
        smiles,
        properties: {
          molecularWeight: '46.07 Da',
          molecularFormula: 'C2H6O',
          atomCount: { C: 2, H: 6, O: 1 },
          exactMass: '46.0419',
          logP: '-0.31',
          tpsa: '20.23',
          rotatableBonds: 0,
          hydrogenBondDonors: 1,
          hydrogenBondAcceptors: 1
        },
        note: 'Mock result - configure SCP_HUB_API_KEY for real computation'
      },
      executionTime: Date.now() - startTime,
    };
  }

  return {
    success: true,
    result: {
      toolId,
      action,
      params,
      message: 'Mock response (API key not configured or invalid)',
      timestamp: new Date().toISOString(),
    },
    executionTime: Date.now() - startTime,
  };
}
