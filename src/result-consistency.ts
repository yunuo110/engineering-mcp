/** Reject contradictions in reported completion without treating reports as verification. */
export function completionContradiction(result: {
  outcome: string;
  implementation_complete?: boolean;
  validation?: ReadonlyArray<{ status: string }>;
}): string | undefined {
  if (result.outcome !== 'completed') return undefined;
  if (result.implementation_complete === false) {
    return 'Completed result declares implementation_complete=false';
  }
  if (result.validation?.some((entry) => entry.status === 'failed')) {
    return 'Completed result contains failed validation';
  }
  return undefined;
}
