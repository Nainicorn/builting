import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, PutCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, S3Client, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const dynamoClient = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(dynamoClient);
const s3 = new S3Client({});
const sfn = new SFNClient({});
const lambdaClient = new LambdaClient({});

const TableName = process.env.RENDERS_TABLE || 'builting-renders';
const DATA_BUCKET = process.env.DATA_BUCKET || 'builting-data';
const IFC_BUCKET = process.env.IFC_BUCKET || 'builting-ifc';
const DIAGNOSTICS_LAMBDA = process.env.DIAGNOSTICS_LAMBDA_ARN || 'builting-diagnostics';

const renders = {
  handle: async (event) => {
    const userId = event._authenticatedUserId;

    const method = event.requestContext?.http?.method || event.httpMethod || 'GET';
    const path = event.path || event.rawPath || '';

    try {
      // POST /api/renders/{renderId}/refine - refine with engineer correction
      if (method === 'POST' && path.includes('/refine')) {
        const renderId = path.split('/').slice(-2)[0];
        const body = typeof event.body === 'string' ? JSON.parse(event.body || '{}') : (event.body || {});
        return await renders.refineRender(userId, renderId, body.refinement);
      }

      // POST /api/renders/{renderId}/retry - retry a failed render
      if (method === 'POST' && path.includes('/retry')) {
        const renderId = path.split('/').slice(-2)[0];
        return await renders.retryRender(userId, renderId);
      }

      // POST /api/renders/{renderId}/finalize - finalize upload and start pipeline
      if (method === 'POST' && path.includes('/finalize')) {
        const renderId = path.split('/').slice(-2)[0];
        return await renders.finalizeRender(userId, renderId);
      }

      // GET /api/renders/{renderId}/download - download IFC/glTF/OBJ
      if (method === 'GET' && path.includes('/download')) {
        const renderId = path.split('/').slice(-2)[0];
        const format = (event.queryStringParameters?.format || 'ifc').toLowerCase();
        return await renders.getDownloadUrl(userId, renderId, format);
      }

      // GET /api/renders/{renderId}/report - download verification report
      if (method === 'GET' && path.includes('/report')) {
        const renderId = path.split('/').slice(-2)[0];
        return await renders.getVerificationReport(userId, renderId);
      }

      // GET /api/renders/{renderId}/diagnostics - assemble and download diagnostics ZIP
      if (method === 'GET' && path.includes('/diagnostics')) {
        const renderId = path.split('/').slice(-2)[0];
        return await renders.getDiagnosticsUrl(userId, renderId);
      }

      // GET /api/renders/{renderId}/sources/{fileName} - download source file
      if (method === 'GET' && path.includes('/sources/')) {
        const parts = path.split('/');
        const sourcesIdx = parts.indexOf('sources');
        const renderId = parts[sourcesIdx - 1];
        const fileName = decodeURIComponent(parts[sourcesIdx + 1]);
        return await renders.getSourceFile(userId, renderId, fileName);
      }

      // GET /api/renders - list all renders for user
      if (method === 'GET') {
        const renderId = path.split('/').pop();
        if (renderId && renderId !== 'renders' && renderId !== 'api') {
          return await renders.getRender(userId, renderId);
        }
        return await renders.listRenders(userId);
      }

      // DELETE /api/renders/{renderId}
      if (method === 'DELETE') {
        const renderId = path.split('/').pop();
        return await renders.deleteRender(userId, renderId);
      }

      return { error: 'Method not allowed', statusCode: 405 };
    } catch (error) {
      console.error('Renders error:', error);
      return { error: error.message, statusCode: 500 };
    }
  },

  createRender: async (userId, renderId, description, fileNames) => {
    console.log('Creating render:', { userId, renderId, description, fileNames });
    const item = {
      user_id: userId,
      render_id: renderId,
      status: 'uploading',
      created_at: Math.floor(Date.now() / 1000),
      source_files: fileNames,
      s3_path: `s3://${DATA_BUCKET}/uploads/${userId}/${renderId}`,
      description: description || ''
    };

    await dynamo.send(new PutCommand({ TableName, Item: item }));
    return item;
  },

  getRender: async (userId, renderId) => {
    const result = await dynamo.send(
      new GetCommand({
        TableName,
        Key: { user_id: userId, render_id: renderId }
      })
    );

    if (!result.Item) return { error: 'Render not found', statusCode: 404 };
    return result.Item;
  },

  listRenders: async (userId) => {
    const result = await dynamo.send(
      new QueryCommand({
        TableName,
        KeyConditionExpression: 'user_id = :userId',
        ExpressionAttributeValues: { ':userId': userId },
        ScanIndexForward: false
      })
    );

    return { renders: result.Items || [] };
  },

  updateStatus: async (userId, renderId, status, updates = {}) => {
    const updateExpr = ['#status = :status', ...Object.keys(updates).map(k => `${k} = :${k}`)];
    const exprValues = { ':status': status, ...Object.fromEntries(Object.entries(updates).map(([k, v]) => [`:${k}`, v])) };

    await dynamo.send(
      new UpdateCommand({
        TableName,
        Key: { user_id: userId, render_id: renderId },
        UpdateExpression: updateExpr.join(', '),
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: exprValues
      })
    );
  },

  getDownloadUrl: async (userId, renderId, format = 'ifc') => {
    const render = await renders.getRender(userId, renderId);
    if (render.error) return render;

    if (render.status !== 'completed') {
      return { error: `Render is ${render.status}, not ready for download`, statusCode: 400 };
    }

    // Resolve file key, content type, and filename based on requested format
    const formatConfig = {
      ifc: {
        key: render.ifc_s3_path.replace(`s3://${IFC_BUCKET}/`, ''),
        contentType: 'application/octet-stream',
        ext: 'ifc'
      },
      glb: {
        key: `${userId}/${renderId}/model.glb`,
        contentType: 'model/gltf-binary',
        ext: 'glb'
      },
      gltf: {
        key: `${userId}/${renderId}/model.glb`,
        contentType: 'model/gltf-binary',
        ext: 'glb'
      },
      obj: {
        key: `${userId}/${renderId}/model.obj`,
        contentType: 'text/plain',
        ext: 'obj'
      }
    };

    const config = formatConfig[format];
    if (!config) {
      return { error: `Unsupported format: ${format}. Available: ifc, glb, obj`, statusCode: 400 };
    }

    // For non-IFC formats, check if the format was actually exported
    if (format !== 'ifc') {
      const available = render.exportFormats || ['IFC4'];
      const formatLabel = format === 'obj' ? 'OBJ' : 'glTF';
      if (!available.includes(formatLabel)) {
        return { error: `Format ${formatLabel} not available for this render. Available: ${available.join(', ')}`, statusCode: 404 };
      }
    }

    const command = new GetObjectCommand({
      Bucket: IFC_BUCKET,
      Key: config.key,
      ResponseContentType: config.contentType,
      ResponseContentDisposition: `attachment; filename="render-${renderId}.${config.ext}"`
    });
    const downloadUrl = await getSignedUrl(s3, command, { expiresIn: 900 });

    return {
      downloadUrl,
      fileName: `render-${renderId}.${config.ext}`,
      format: config.ext,
      render
    };
  },

  getSourceFile: async (userId, renderId, fileName) => {
    const render = await renders.getRender(userId, renderId);
    if (render.error) return render;

    // Validate the file is in source_files list
    if (!render.source_files || !render.source_files.includes(fileName)) {
      return { error: 'File not found in this render', statusCode: 404 };
    }

    const key = `uploads/${userId}/${renderId}/${fileName}`;
    try {
      const response = await s3.send(new GetObjectCommand({ Bucket: DATA_BUCKET, Key: key }));
      const buffer = await response.Body.transformToByteArray();
      const base64 = Buffer.from(buffer).toString('base64');

      return {
        fileData: base64,
        fileName
      };
    } catch (err) {
      console.error('Error fetching source file:', err.message);
      return { error: 'File not found in storage', statusCode: 404 };
    }
  },

  getVerificationReport: async (userId, renderId) => {
    // Load verification report (if present) and pipeline trace files in parallel.
    const reportKey = `uploads/${userId}/${renderId}/reports/verification_report.json`;
    const tracePrefix = `${renderId}/pipeline_trace/`;

    const [reportResult, traceResult] = await Promise.allSettled([
      s3.send(new GetObjectCommand({ Bucket: DATA_BUCKET, Key: reportKey }))
        .then(async r => {
          const buf = await r.Body.transformToByteArray();
          return JSON.parse(Buffer.from(buf).toString('utf-8'));
        }),
      // Trace files live in the IFC bucket at <renderId>/pipeline_trace/
      s3.send(new ListObjectsV2Command({ Bucket: IFC_BUCKET, Prefix: tracePrefix }))
        .then(async r => {
          const files = r.Contents || [];
          // Read each trace file (small JSON — always under 2KB)
          const reads = files.map(f =>
            s3.send(new GetObjectCommand({ Bucket: IFC_BUCKET, Key: f.Key }))
              .then(async obj => {
                const buf = await obj.Body.transformToByteArray();
                return JSON.parse(Buffer.from(buf).toString('utf-8'));
              })
              .catch(() => null)
          );
          const entries = (await Promise.all(reads)).filter(Boolean);
          // Sort by stage order then attemptN
          const stageOrder = ['extract', 'resolve', 'topology', 'generate', 'store'];
          entries.sort((a, b) => {
            const si = stageOrder.indexOf(a.stage) - stageOrder.indexOf(b.stage);
            return si !== 0 ? si : (a.attemptN || 0) - (b.attemptN || 0);
          });
          return entries;
        }),
    ]);

    const report = reportResult.status === 'fulfilled' ? reportResult.value : null;
    const traceEntries = traceResult.status === 'fulfilled' ? traceResult.value : [];

    if (!report && traceEntries.length === 0) {
      return { error: 'Report not found', statusCode: 404 };
    }

    return { report, pipelineTrace: traceEntries };
  },

  finalizeRender: async (userId, renderId) => {
    console.log('Finalizing render:', { userId, renderId });

    // Fail fast if STATE_MACHINE_ARN is not configured
    const stateMachineArn = process.env.STATE_MACHINE_ARN;
    if (!stateMachineArn) {
      console.error('STATE_MACHINE_ARN not set');
      return { error: 'Pipeline not configured', statusCode: 500 };
    }

    // Check if render exists
    const render = await renders.getRender(userId, renderId);
    if (render.error) return render;

    // Idempotent: if already past uploading, return deterministic response
    if (render.status !== 'uploading') {
      console.log(`Render ${renderId} already finalized (status: ${render.status})`);
      return { message: 'Render already finalized', renderId, status: render.status };
    }

    // Reject if zero files uploaded — list S3 objects under this render
    const prefix = `uploads/${userId}/${renderId}/`;
    const listResult = await s3.send(new ListObjectsV2Command({
      Bucket: DATA_BUCKET,
      Prefix: prefix
    }));

    const files = (listResult.Contents || []).filter(obj => obj.Key !== prefix);
    if (files.length === 0) {
      return { error: 'No files uploaded. Upload at least one file before finalizing.', statusCode: 400 };
    }

    // Store file manifest and transition status uploading → processing (conditional)
    const fileManifest = files.map(f => ({
      key: f.Key,
      name: f.Key.split('/').pop(),
      size: f.Size
    }));

    try {
      await dynamo.send(new UpdateCommand({
        TableName,
        Key: { user_id: userId, render_id: renderId },
        UpdateExpression: 'SET #status = :processing, upload_finalized = :true, fileManifest = :manifest',
        ConditionExpression: '#status = :uploading',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':processing': 'processing',
          ':uploading': 'uploading',
          ':true': true,
          ':manifest': fileManifest
        }
      }));
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') {
        console.log(`Render ${renderId} status changed concurrently, already finalized`);
        return { message: 'Render already finalized', renderId };
      }
      throw err;
    }
    console.log(`Render ${renderId} finalized with ${fileManifest.length} files`);

    // Start Step Function
    const executionResult = await sfn.send(new StartExecutionCommand({
      stateMachineArn,
      input: JSON.stringify({ userId, renderId, bucket: DATA_BUCKET }),
      name: `render-${renderId}-${Date.now()}`
    }));
    console.log(`Step Function started: ${executionResult.executionArn}`);

    return { message: 'Render finalized and pipeline started', renderId, fileCount: fileManifest.length };
  },

  retryRender: async (userId, renderId) => {
    console.log('Retrying render:', { userId, renderId });

    const stateMachineArn = process.env.STATE_MACHINE_ARN;
    if (!stateMachineArn) {
      return { error: 'Pipeline not configured', statusCode: 500 };
    }

    // Get the render record
    const render = await renders.getRender(userId, renderId);
    if (render.error) return render;

    // Only allow retry for failed renders
    if (render.status !== 'failed') {
      return { error: `Cannot retry render with status '${render.status}'. Only failed renders can be retried.`, statusCode: 400 };
    }

    // Verify files still exist in S3
    const prefix = `uploads/${userId}/${renderId}/`;
    const listResult = await s3.send(new ListObjectsV2Command({
      Bucket: DATA_BUCKET,
      Prefix: prefix
    }));

    const files = (listResult.Contents || []).filter(obj => obj.Key !== prefix);
    if (files.length === 0) {
      return { error: 'Original source files no longer available in S3. Please create a new render.', statusCode: 400 };
    }

    // Reset status to processing and clear error
    try {
      await dynamo.send(new UpdateCommand({
        TableName,
        Key: { user_id: userId, render_id: renderId },
        UpdateExpression: 'SET #status = :processing, retry_count = if_not_exists(retry_count, :zero) + :one REMOVE error_message',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':processing': 'processing',
          ':zero': 0,
          ':one': 1
        }
      }));
    } catch (err) {
      console.error('Failed to reset render status:', err);
      return { error: 'Failed to reset render for retry', statusCode: 500 };
    }

    // Re-start Step Function
    const executionResult = await sfn.send(new StartExecutionCommand({
      stateMachineArn,
      input: JSON.stringify({ userId, renderId, bucket: DATA_BUCKET }),
      name: `render-${renderId}-retry-${Date.now()}`
    }));
    console.log(`Retry Step Function started: ${executionResult.executionArn}`);

    return { message: 'Render retry started', renderId, fileCount: files.length };
  },

  refineRender: async (userId, renderId, refinementText) => {
    if (!refinementText || typeof refinementText !== 'string' || !refinementText.trim()) {
      return { error: 'refinement text is required', statusCode: 400 };
    }

    const stateMachineArn = process.env.STATE_MACHINE_ARN;
    if (!stateMachineArn) return { error: 'Pipeline not configured', statusCode: 500 };

    const render = await renders.getRender(userId, renderId);
    if (render.error) return render;
    if (render.status !== 'completed') {
      return { error: 'Can only refine completed renders', statusCode: 400 };
    }

    // Fetch previous PROCESSED CSS from S3 so extract can use it as a modification base.
    // Use css_processed.json (post-transform, validated) instead of css_raw.json (pre-validation)
    // because the processed version is what actually produced the working IFC.
    let previousCSS = null;
    const cssKey = `uploads/${userId}/${renderId}/css/css_processed.json`;
    try {
      const cssResponse = await s3.send(new GetObjectCommand({ Bucket: DATA_BUCKET, Key: cssKey }));
      const cssBuffer = await cssResponse.Body.transformToByteArray();
      previousCSS = JSON.parse(Buffer.from(cssBuffer).toString('utf-8'));
      console.log(`Loaded previous CSS from ${cssKey}`);
    } catch (err) {
      console.warn(`Could not load previous CSS (${cssKey}):`, err.message);
    }

    // Update existing render in-place: set status to processing, store refinement
    try {
      await dynamo.send(new UpdateCommand({
        TableName,
        Key: { user_id: userId, render_id: renderId },
        UpdateExpression: 'SET #status = :processing, refinement = :refinement, refine_count = if_not_exists(refine_count, :zero) + :one, render_revision = if_not_exists(render_revision, :zero) + :one',
        ConditionExpression: '#status = :completed',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':processing': 'processing',
          ':completed': 'completed',
          ':refinement': refinementText.trim(),
          ':zero': 0,
          ':one': 1
        }
      }));
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') {
        return { error: 'Render status changed, please try again', statusCode: 409 };
      }
      throw err;
    }

    // Start Step Function with same renderId + previousCSS
    const sfInput = { userId, renderId, bucket: DATA_BUCKET };
    if (previousCSS) sfInput.previousCSS = previousCSS;

    const executionResult = await sfn.send(new StartExecutionCommand({
      stateMachineArn,
      input: JSON.stringify(sfInput),
      name: `refine-${renderId}-${Date.now()}`
    }));
    console.log(`Refine pipeline started: ${executionResult.executionArn}`);

    return { renderId, message: 'Refinement pipeline started' };
  },

  getDiagnosticsUrl: async (userId, renderId) => {
    const render = await renders.getRender(userId, renderId);
    if (render.error) return render;

    const allowedStatuses = ['completed', 'failed', 'failed_contract'];
    if (!allowedStatuses.includes(render.status)) {
      return { error: `Diagnostics not available for renders with status: ${render.status}`, statusCode: 400 };
    }

    try {
      const resp = await lambdaClient.send(new InvokeCommand({
        FunctionName: DIAGNOSTICS_LAMBDA,
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify({ userId, renderId }),
      }));

      const payload = JSON.parse(Buffer.from(resp.Payload).toString('utf-8'));
      if (resp.FunctionError || payload.errorMessage || payload.error) {
        console.error('Diagnostics lambda error:', payload);
        return { error: 'Failed to assemble diagnostics bundle', statusCode: 500 };
      }
      return payload; // { downloadUrl }
    } catch (err) {
      console.error('Error invoking diagnostics lambda:', err);
      return { error: 'Diagnostics service unavailable', statusCode: 503 };
    }
  },

  deleteRender: async (userId, renderId) => {
    console.log('Deleting render:', { userId, renderId });

    try {
      // Get render record to find S3 paths
      const render = await renders.getRender(userId, renderId);
      if (render.error) {
        return render; // Render not found
      }

      // Protect permanent demo renders — only deletable via backend/DynamoDB directly
      if (render.is_demo_render) {
        return { error: 'This render is permanent and cannot be deleted', statusCode: 403 };
      }

      // Delete source files from builting-data bucket
      const sourceFolder = `uploads/${userId}/${renderId}/`;
      await deleteS3Folder(DATA_BUCKET, sourceFolder);
      console.log('Deleted source files from S3');

      // Delete all export files from builting-ifc bucket (IFC + glTF + OBJ)
      const ifcFolder = `${userId}/${renderId}/`;
      await deleteS3Folder(IFC_BUCKET, ifcFolder);
      console.log('Deleted IFC and export files from S3');

      // Delete DynamoDB record
      await dynamo.send(
        new DeleteCommand({
          TableName,
          Key: { user_id: userId, render_id: renderId }
        })
      );
      console.log('Deleted render record from DynamoDB');

      return { message: 'Render deleted successfully' };
    } catch (error) {
      console.error('Error deleting render:', error);
      throw error;
    }
  }
};

/**
 * Delete all objects in an S3 folder (prefix)
 */
async function deleteS3Folder(bucket, prefix) {
  let continuationToken = null;

  do {
    const listParams = {
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken
    };

    const listResult = await s3.send(new ListObjectsV2Command(listParams));

    if (!listResult.Contents || listResult.Contents.length === 0) {
      break;
    }

    // Delete each object in the folder
    for (const object of listResult.Contents) {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: object.Key
        })
      );
    }

    // Handle pagination
    if (listResult.IsTruncated) {
      continuationToken = listResult.NextContinuationToken;
    } else {
      break;
    }
  } while (continuationToken);

  console.log(`Deleted all objects with prefix ${prefix} from ${bucket}`);
}

export default renders;
