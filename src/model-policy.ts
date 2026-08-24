/** Provider route exposed to customer subaccounts. */
export const CUSTOMER_MODEL_PROVIDER = 'codex';

/** Models exposed to customer subaccounts, in provider catalog order. */
export const CUSTOMER_MODEL_IDS = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
]);

/** Whether a model route is available to a customer subaccount. */
export function customerModelAllowed(provider: string, model: string): boolean {
  return provider === CUSTOMER_MODEL_PROVIDER && CUSTOMER_MODEL_IDS.has(model);
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Filter a successful llm.models or session.models response for a customer.
 * Upstream error responses remain unchanged; malformed success responses fail
 * closed so the gateway never returns an unfiltered catalog.
 */
export function filterCustomerModelCatalogResponse(response: unknown): unknown | null {
  const envelope = recordOf(response);
  const result = recordOf(envelope?.result);
  if (envelope === null || result === null) return null;
  if (result.ok === false) return response;
  if (result.ok !== true) return null;

  const value = recordOf(result.value);
  if (value === null || !Array.isArray(value.groups) || !Array.isArray(value.failures)) return null;

  const groups = value.groups.flatMap((candidate) => {
    const group = recordOf(candidate);
    if (group === null || group.id !== CUSTOMER_MODEL_PROVIDER || !Array.isArray(group.models)) return [];
    const models = group.models.filter((candidateModel) => {
      const model = recordOf(candidateModel);
      return model !== null && typeof model.id === 'string' && CUSTOMER_MODEL_IDS.has(model.id);
    });
    return models.length === 0 ? [] : [{ ...group, models }];
  });
  const failures = value.failures.filter((candidate) => recordOf(candidate)?.id === CUSTOMER_MODEL_PROVIDER);

  return {
    ...envelope,
    result: {
      ...result,
      value: {
        ...value,
        groups,
        failures,
      },
    },
  };
}
