/**
 * DOCX Structured Parser — extracts domain-specific parameters from raw DOCX text via Bedrock.
 *
 * Domain-agnostic by design: the caller passes a domainSchema that tells Claude
 * exactly what fields to extract. Building schemas, tunnel schemas, etc. each have
 * their own schema file under schemas/.
 *
 * Returns null on any Bedrock failure so callers can treat it as a no-op.
 */

const MODEL_ID = 'us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0';
const MAX_INPUT_CHARS = 8000;   // cap to keep Bedrock latency predictable
const MAX_TOKENS = 2048;

/**
 * Extract structured domain parameters from raw DOCX text.
 *
 * @param {string} rawText   - Full text extracted from the DOCX (via extractDocxText())
 * @param {object} bedrockClient - Initialized BedrockRuntimeClient
 * @param {object} domainSchema  - Template object defining the fields Claude should extract
 *                                 (e.g. TUNNEL_SCHEMA from schemas/tunnelSchema.mjs)
 * @param {object} [options]
 * @param {string} [options.invokeCommandClass] - The InvokeModelCommand class to use
 * @returns {Promise<object|null>} Filled-in schema object, or null on failure
 */
export async function extractStructuredParams(rawText, bedrockClient, domainSchema, options = {}) {
  if (!rawText || !bedrockClient || !domainSchema) return null;

  const truncatedText = rawText.slice(0, MAX_INPUT_CHARS);

  const prompt = [
    'Extract structured building/facility parameters from the following document text.',
    'Return ONLY a valid JSON object that matches this schema — no preamble, no markdown fences, no explanation.',
    'Fill in every field you can find. Leave fields as null if not mentioned.',
    '',
    'Schema:',
    JSON.stringify(domainSchema, null, 2),
    '',
    'Document text:',
    truncatedText,
  ].join('\n');

  try {
    const requestBody = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: MAX_TOKENS,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    };

    const InvokeModelCommand = options.invokeCommandClass;
    if (!InvokeModelCommand) {
      console.warn('docxStructuredParser: no invokeCommandClass provided — cannot call Bedrock');
      return null;
    }

    const response = await bedrockClient.send(new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(requestBody),
    }));

    const responseBody = JSON.parse(
      response.body instanceof Uint8Array
        ? new TextDecoder().decode(response.body)
        : response.body
    );

    const text = responseBody.content?.find(c => c.type === 'text')?.text || '';
    if (!text) {
      console.warn('docxStructuredParser: empty Bedrock response text');
      return null;
    }

    // Strip markdown fences if Claude wrapped the JSON anyway
    const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const match = stripped.match(/\{[\s\S]*\}/);
    if (!match) {
      console.warn('docxStructuredParser: no JSON object found in response');
      return null;
    }

    const result = JSON.parse(match[0]);
    console.log('docxStructuredParser: extracted keys:', Object.keys(result).join(', '));
    return result;

  } catch (err) {
    console.warn('docxStructuredParser: Bedrock call failed (non-fatal):', err.message);
    return null;
  }
}
