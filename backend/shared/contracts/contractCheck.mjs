// contractCheck.mjs — wraps Zod contract validation with structured logging.
// Used by all Node pipeline lambdas to validate artifacts they produce.
//
// checkContractAsync(name, schema, artifact, opts)
//   halting=true  (default) — quarantine-writes artifact then throws ContractFailure.
//   halting=false (self-check) — logs contract_self_check_failure and returns.
//
// quarantineWriter is optional. When provided, receives (artifact, errors[]) and
// should write the quarantine document to S3 before the error is thrown.
//
// ContractFailure is a named error class so Step Functions can route it
// specifically via ErrorEquals: ["ContractFailure"] in Catch blocks.

export class ContractFailure extends Error {
  constructor(contractName, errors, preview) {
    super(`Contract ${contractName} failed: ${errors.length} error(s) — ${preview}`);
    this.name = 'ContractFailure';
    this.contractName = contractName;
    this.errors = errors;
  }
}

// Returns 'pass' | 'fail'. Callers that don't need the result can ignore the return value.
export async function checkContractAsync(contractName, schema, artifact, {
  halting = true,
  renderId = null,
  stage = null,
  quarantineWriter = null,
} = {}) {
  const result = schema.safeParse(artifact);
  if (result.success) {
    console.log(`[contract:${contractName}] PASS stage=${stage} renderId=${renderId}`);
    return 'pass';
  }

  const errs = result.error.errors;
  const tag = halting ? 'contract_failure' : 'contract_self_check_failure';
  const preview = errs.slice(0, 5)
    .map(e => `${e.path.length ? e.path.join('.') : '(root)'}: ${e.message}`)
    .join(' | ');
  console.error(
    `[${tag}] contract=${contractName} stage=${stage} renderId=${renderId}` +
    ` totalErrors=${errs.length} sample="${preview}"`
  );

  if (!halting) return 'fail';

  if (quarantineWriter) {
    try {
      await quarantineWriter(artifact, errs.slice(0, 20));
    } catch (qe) {
      console.warn(`[contract_quarantine_failed] contract=${contractName} ${qe.message}`);
    }
  }

  throw new ContractFailure(contractName, errs.slice(0, 20), preview);
}
