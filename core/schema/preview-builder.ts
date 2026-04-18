import { appProjectSchema, appSchemaSchema, previewSessionSchema, type AppProject, type AppSchema, type PreviewSession } from './app-studio.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderNode(schema: AppSchema, nodeId: string): string {
  const page = schema.pages.find((entry) => nodeId === entry.rootNodeId || entry.nodes[nodeId]);
  const node = page?.nodes[nodeId];
  if (!page || !node) return '';

  const children = node.children.map((childId) => renderNode(schema, childId)).join('');
  const headline = typeof node.props.headline === 'string' ? node.props.headline : node.label || node.type;
  const body = typeof node.props.body === 'string' ? node.props.body : '';
  const ctaLabel = typeof node.props.ctaLabel === 'string' ? node.props.ctaLabel : '';

  if (node.type === 'hero') {
    return `
      <section class="hero-card">
        <p class="eyebrow">Generated Preview</p>
        <h1>${escapeHtml(headline)}</h1>
        <p>${escapeHtml(body)}</p>
        ${ctaLabel ? `<button>${escapeHtml(ctaLabel)}</button>` : ''}
      </section>
    `;
  }

  if (node.type === 'page') {
    return `<main class="page-shell">${children}</main>`;
  }

  return `
    <section class="generic-card">
      <h2>${escapeHtml(headline)}</h2>
      ${body ? `<p>${escapeHtml(body)}</p>` : ''}
      ${children}
    </section>
  `;
}

export function buildPreviewHtml(projectInput: AppProject, schemaInput: AppSchema): string {
  const project = appProjectSchema.parse(projectInput);
  const schema = appSchemaSchema.parse(schemaInput);
  const primaryPage = schema.pages[0];
  const content = primaryPage ? renderNode(schema, primaryPage.rootNodeId) : '<main class="page-shell"><p>No pages defined.</p></main>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(project.name)} Preview</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #08111f;
        --panel: rgba(17, 24, 39, 0.88);
        --line: rgba(255,255,255,0.08);
        --text: #f3f7ff;
        --muted: #a8b3cf;
        --accent: #7dd3fc;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top, rgba(125, 211, 252, 0.16), transparent 28%),
          linear-gradient(180deg, #07101b 0%, #0b1324 100%);
      }
      .preview-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 20px 24px;
        border-bottom: 1px solid var(--line);
        background: rgba(3, 7, 18, 0.4);
        backdrop-filter: blur(12px);
      }
      .preview-header code { color: var(--accent); }
      .page-shell {
        width: min(960px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 48px 0 72px;
      }
      .hero-card, .generic-card {
        border: 1px solid var(--line);
        background: var(--panel);
        border-radius: 28px;
        padding: 32px;
      }
      .hero-card h1 { font-size: clamp(32px, 6vw, 64px); line-height: 1.05; margin: 0 0 16px; }
      .hero-card p, .generic-card p { color: var(--muted); line-height: 1.7; }
      .hero-card button {
        margin-top: 18px;
        border: 0;
        border-radius: 999px;
        padding: 12px 18px;
        font-weight: 700;
        color: #04111b;
        background: linear-gradient(135deg, #7dd3fc, #38bdf8);
      }
      .eyebrow {
        color: var(--accent);
        text-transform: uppercase;
        letter-spacing: 0.12em;
        font-size: 11px;
      }
    </style>
  </head>
  <body>
    <header class="preview-header">
      <div>
        <div class="eyebrow">OpenTeam Studio Preview</div>
        <strong>${escapeHtml(project.name)}</strong>
      </div>
      <code>${escapeHtml(project.id)}</code>
    </header>
    ${content}
  </body>
</html>`;
}

export function buildReadyPreviewSession(input: PreviewSession, previewUrl: string): PreviewSession {
  return previewSessionSchema.parse({
    ...input,
    status: 'ready',
    previewUrl,
    lastBuildAt: new Date().toISOString(),
    buildLogs: [...input.buildLogs, `Preview generated at ${new Date().toISOString()}`],
  });
}
