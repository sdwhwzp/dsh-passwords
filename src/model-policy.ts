/** Provider route exposed to customer subaccounts. */
export const CUSTOMER_MODEL_PROVIDER = 'codex';

/**
 * Whether a model route is available to a customer subaccount.
 * @param provider - provider route from the catalog or model request.
 * @param model - model id; Codex requires a GPT version of at least 5.6.
 * @returns whether the route meets the customer model policy.
 */
export function customerModelAllowed(provider: string, model: string): boolean {
  if (provider !== CUSTOMER_MODEL_PROVIDER) return true;
  const version = /^gpt-(\d+)(?:\.(\d+))?(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/.exec(model);
  if (version === null) return false;
  const major = Number(version[1]);
  const minor = Number(version[2] ?? '0');
  return major > 5 || (major === 5 && minor >= 6);
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
    if (group === null || !Array.isArray(group.models)) return [];
    if (group.id !== CUSTOMER_MODEL_PROVIDER) return [group];
    const models = group.models.filter((candidateModel) => {
      const model = recordOf(candidateModel);
      return model !== null && typeof model.id === 'string' && customerModelAllowed(CUSTOMER_MODEL_PROVIDER, model.id);
    });
    return models.length === 0 ? [] : [{ ...group, models }];
  });
  return {
    ...envelope,
    result: {
      ...result,
      value: {
        ...value,
        groups,
        failures: value.failures,
      },
    },
  };
}
