import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';

// Phase 13: Consumer contract check
import { checkContractAsync, ifcContract } from '@builting/contracts';
// Phase 13 PR2: Trace writer
import { writeTraceStart, writeTraceEnd } from '@builting/trace';

const dynamoClient = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(dynamoClient);
const s3 = new S3Client({});
const RENDERS_TABLE = process.env.RENDERS_TABLE || 'builting-renders';
const IFC_BUCKET = process.env.IFC_BUCKET || 'builting-ifc';
const DATA_BUCKET = process.env.DATA_BUCKET || 'builting-data';

export const handler = async (event, context) => {
  console.log('StoreIFC input:', JSON.stringify(event, null, 2));
  const { userId, renderId, bucket, ifcS3Path, ai_generated_title, ai_generated_description, elementCounts, outputMode, cssHash, tracingReport, validationSummary, sourceFusion, structuralWarnings, refinementReport, refinementReportS3Key, readinessScore, exportReadiness, authoringSuitability, criticalIssueCount, validationWarningCount, validationProxyRatio, validationReportS3Key, generationModeRecommendation, readinessDelta, geometryFidelity, exportFormats, exportFiles } = event;
  // Phase 13 PR2: Trace state
  const _traceRunId = context?.awsRequestId || `store-${Date.now()}`;
  const _traceStartedAt = new Date().toISOString();
  let _traceKey = null; let _traceAttemptN = 1;

  try {
    // Handle contract failure mode — distinct from generic failures.
    // Step Function routes ContractFailure errors here via HandleContractFailure state.
    if (event.contractFailure) {
      const errorMsg = typeof event.error === 'object'
        ? (event.error.Cause || event.error.Error || JSON.stringify(event.error))
        : String(event.error || 'Contract check failed');
      console.error(`[contract_failure_recorded] renderId=${renderId} error=${errorMsg.substring(0, 200)}`);
      await dynamo.send(
        new UpdateCommand({
          TableName: RENDERS_TABLE,
          Key: { user_id: userId, render_id: renderId },
          UpdateExpression: 'SET #status = :status, error_message = :err',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':status': 'failed_contract',
            ':err': errorMsg.substring(0, 1000),
          },
        })
      );
      console.log('DynamoDB updated with failed_contract status');
      return { userId, renderId, status: 'failed_contract', error_message: errorMsg };
    }

    // Handle generic failure mode — called by Step Function Catch for non-contract errors.
    if (event.failureMode) {
      console.log('Recording render failure:', event.error);
      const errorMsg = typeof event.error === 'object'
        ? (event.error.Cause || event.error.Error || JSON.stringify(event.error))
        : String(event.error || 'Unknown error');

      await dynamo.send(
        new UpdateCommand({
          TableName: RENDERS_TABLE,
          Key: { user_id: userId, render_id: renderId },
          UpdateExpression: 'SET #status = :status, error_message = :err',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':status': 'failed', ':err': errorMsg.substring(0, 1000) }
        })
      );
      console.log('DynamoDB updated with failed status');
      return { userId, renderId, status: 'failed', error_message: errorMsg };
    }

    // Consumer contract check: validate generate→store event on entry (halting).
    await checkContractAsync('ifcContract', ifcContract, event, {
      halting: true,
      renderId,
      stage: 'store-entry',
    });

    // Phase 13 PR2: Trace start — after failure-mode guards and contract check.
    try {
      ({ key: _traceKey, attemptN: _traceAttemptN } = await writeTraceStart({
        renderId, stage: 'store', runId: _traceRunId, startedAt: _traceStartedAt,
        artifactKey: ifcS3Path || null,
      }));
    } catch (te) { console.warn('[trace] start write failed (non-fatal):', te.message); }

    // IFC is already saved to S3 by the IFC generator Lambda.
    // This Lambda updates DynamoDB with the path and metadata.
    const ifc_s3_path = ifcS3Path || `s3://${IFC_BUCKET}/${userId}/${renderId}/model.ifc`;

    console.log(`Recording IFC path: ${ifc_s3_path}`);

    // Build update expression dynamically
    let updateExpr = 'SET ifc_s3_path = :path, #status = :status, pipelineVersion = :pv';
    const exprValues = {
      ':path': ifc_s3_path,
      ':status': 'completed',
      ':pv': '2.0'
    };
    const exprNames = { '#status': 'status' };

    // Add optional fields dynamically
    const optionalFields = {
      ai_generated_title: ['title', ai_generated_title],
      ai_generated_description: ['desc', ai_generated_description],
      elementCounts: ['counts', elementCounts],
      outputMode: ['mode', outputMode],
      cssHash: ['hash', cssHash],
      tracingReport: ['tr', tracingReport],
      validationSummary: ['vs', validationSummary],
      sourceFusion: ['sf', sourceFusion],
      structuralWarnings: ['sw', structuralWarnings && structuralWarnings.length > 0 ? structuralWarnings : undefined],
      refinementReport: ['rr', refinementReport],
      refinementReportS3Key: ['rrsk', refinementReportS3Key],
      readinessScore: ['rs', readinessScore],
      exportReadiness: ['er', exportReadiness],
      authoringSuitability: ['as', authoringSuitability],
      criticalIssueCount: ['cic', criticalIssueCount],
      validationWarningCount: ['vwc', validationWarningCount],
      validationProxyRatio: ['vpr', validationProxyRatio],
      validationReportS3Key: ['vrsk', validationReportS3Key],
      generationModeRecommendation: ['gmr', generationModeRecommendation],
      readinessDelta: ['rd', readinessDelta],
      geometryFidelity: ['gf', geometryFidelity],
      exportFormats: ['ef', exportFormats],
      exportFiles: ['efl', exportFiles],
    };

    for (const [field, [alias, value]] of Object.entries(optionalFields)) {
      if (value !== undefined && value !== null) {
        updateExpr += `, ${field} = :${alias}`;
        exprValues[`:${alias}`] = value;
      }
    }

    if (elementCounts) {
      // Compute quality score
      const totalElems = Object.values(elementCounts).reduce((s, n) => s + n, 0);
      const proxyCount = elementCounts['IfcBuildingElementProxy'] || 0;
      const semanticRatio = totalElems > 0 ? (totalElems - proxyCount) / totalElems : 0;
      const proxyPenalty = totalElems > 0 ? Math.max(0, 1 - (proxyCount / totalElems)) : 1;
      const hasWalls = (elementCounts['IfcWall'] || 0) + (elementCounts['IfcWallStandardCase'] || 0) > 0;
      const hasSlabs = (elementCounts['IfcSlab'] || 0) > 0;
      const validScore = validationSummary?.valid ? 1 : 0.5;
      const revitScore = (validationSummary?.revitCompatScore || 70) / 100;
      const structScore = (hasWalls ? 0.5 : 0) + (hasSlabs ? 0.5 : 0);
      const qualityScore = Math.round(
        (semanticRatio * 30 + proxyPenalty * 20 + validScore * 20 + structScore * 20 + revitScore * 10)
      );
      updateExpr += ', qualityScore = :qs';
      exprValues[':qs'] = qualityScore;
    }

    await dynamo.send(
      new UpdateCommand({
        TableName: RENDERS_TABLE,
        Key: { user_id: userId, render_id: renderId },
        UpdateExpression: updateExpr,
        ExpressionAttributeNames: exprNames,
        ExpressionAttributeValues: exprValues
      })
    );

    console.log('DynamoDB updated with IFC path and metadata');

    // Phase 13 PR2: Persist trace summary to DynamoDB for fast UI reads.
    // Lists all pipeline_trace/ files for this render, writes compact index.
    try {
      const tracePrefix = `${renderId}/pipeline_trace/`;
      const traceList = await s3.send(new ListObjectsV2Command({ Bucket: IFC_BUCKET, Prefix: tracePrefix }));
      const traceFiles = (traceList.Contents || []).map(obj => ({
        key: obj.Key,
        stage: obj.Key.replace(tracePrefix, '').split('.')[0],
        size: obj.Size,
        lastModified: obj.LastModified?.toISOString?.() || null,
      }));
      if (traceFiles.length > 0) {
        await dynamo.send(new UpdateCommand({
          TableName: RENDERS_TABLE,
          Key: { user_id: userId, render_id: renderId },
          UpdateExpression: 'SET pipelineTraceSummary = :pts',
          ExpressionAttributeValues: { ':pts': { stageCount: traceFiles.length, files: traceFiles } },
        }));
        console.log(`[trace] pipelineTraceSummary saved: ${traceFiles.length} trace file(s)`);
      }
    } catch (te) { console.warn('[trace] pipelineTraceSummary DynamoDB write failed (non-fatal):', te.message); }

    // Phase 6: Write artifact_manifest.json with v2 pipeline artifacts and lineage
    const dataBucket = bucket || DATA_BUCKET;
    const revision = event.renderRevision || 1;
    const manifestKey = `uploads/${userId}/${renderId}/pipeline/v${revision}/artifact_manifest.json`;

    // Build artifact list dynamically from available S3 keys
    const artifacts = [
      { name: 'css_raw.json', s3Key: `uploads/${userId}/${renderId}/css/css_raw.json`, producedByStage: 'extract' },
      { name: 'extract_debug.json', s3Key: `uploads/${userId}/${renderId}/pipeline/v${revision}/extract_debug.json`, producedByStage: 'extract' },
      { name: 'claims.json', s3Key: `uploads/${userId}/${renderId}/pipeline/v${revision}/claims.json`, producedByStage: 'extract' },
      { name: 'normalized_claims.json', s3Key: `uploads/${userId}/${renderId}/pipeline/v${revision}/normalized_claims.json`, producedByStage: 'resolve' },
      { name: 'canonical_observed.json', s3Key: `uploads/${userId}/${renderId}/pipeline/v${revision}/canonical_observed.json`, producedByStage: 'resolve' },
      { name: 'resolution_report.json', s3Key: `uploads/${userId}/${renderId}/pipeline/v${revision}/resolution_report.json`, producedByStage: 'resolve' },
      { name: 'identity_map.json', s3Key: `uploads/${userId}/${renderId}/pipeline/v${revision}/identity_map.json`, producedByStage: 'resolve' },
      { name: 'css_structure.json', s3Key: `uploads/${userId}/${renderId}/css/css_structure.json`, producedByStage: 'structure' },
      { name: 'inferred.json', s3Key: `uploads/${userId}/${renderId}/pipeline/v${revision}/inferred.json`, producedByStage: 'structure' },
      { name: 'css_processed.json', s3Key: `uploads/${userId}/${renderId}/css/css_processed.json`, producedByStage: 'geometry' },
      { name: 'resolved.json', s3Key: `uploads/${userId}/${renderId}/pipeline/v${revision}/resolved.json`, producedByStage: 'geometry' },
      validationReportS3Key ? { name: 'validation_report.json', s3Key: validationReportS3Key, producedByStage: 'validate' } : null,
      refinementReportS3Key ? { name: 'refinement_report.json', s3Key: refinementReportS3Key, producedByStage: 'extract' } : null,
      { name: 'model.ifc', s3Key: `${userId}/${renderId}/model.ifc`, producedByStage: 'generate' },
      exportFiles?.glb ? { name: 'model.glb', s3Key: exportFiles.glb.s3Key, producedByStage: 'generate', format: 'glTF' } : null,
      exportFiles?.obj ? { name: 'model.obj', s3Key: exportFiles.obj.s3Key, producedByStage: 'generate', format: 'OBJ' } : null,
    ].filter(Boolean);

    const manifest = {
      pipelineVersion: '2.0',
      renderRevision: revision,
      generatedAt: new Date().toISOString(),
      stageOrder: ['read', 'extract', 'resolve', 'structure', 'geometry', 'validate', 'generate', 'store'],
      priorRevisionArtifactManifestS3Key: revision > 1
        ? `uploads/${userId}/${renderId}/pipeline/v${revision - 1}/artifact_manifest.json`
        : null,
      refinementLineage: revision > 1
        ? { revision, previousRevision: revision - 1 }
        : null,
      artifacts,
      featureFlags: { PIPELINE_V2: true },
      generatorCompatibilityMode: 'v2_css'
    };

    await s3.send(new PutObjectCommand({
      Bucket: dataBucket,
      Key: manifestKey,
      Body: JSON.stringify(manifest),
      ContentType: 'application/json'
    }));
    console.log(`Artifact manifest saved: s3://${dataBucket}/${manifestKey}`);

    // Phase 13 PR2: Trace end (Release 13.2: + scalars)
    if (_traceKey) {
      try {
        await writeTraceEnd({
          traceKey: _traceKey, stage: 'store', runId: _traceRunId, attemptN: _traceAttemptN,
          startedAt: _traceStartedAt, finishedAt: new Date().toISOString(),
          outputArtifactKey: ifc_s3_path,
          counts: elementCounts || {},
          validationFlags: [],
          scalars: {
            gatePassRate: null,
            contractStatus: 'pass',
            provenanceCompleteness: null,
          },
        });
      } catch (te) { console.warn('[trace] end write failed (non-fatal):', te.message); }
    }

    return {
      ...event,
      ifc_s3_path
    };
  } catch (error) {
    console.error('StoreIFC error:', error);
    throw error;
  }
};
